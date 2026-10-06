'use strict';
/* 数据源适配器：把不同来源统一成「每次采集返回一批原始作品对象」的接口。
   可选 adapter：
     file      读取 realtime/data/inbox 下的 CSV/JSON 文件（平台导出文件、其它脚本落盘）
     http      调用你自己的或第三方数据服务的 REST 接口（支持字段映射、分页、鉴权头）
     official  官方开放平台（抖音/快手等），自动取 token 并分页拉取
     none      不主动采集，只接收外部 POST /api/ingest 推送的数据
*/

var fs = require('node:fs');
var path = require('node:path');

function pickPath(obj, pathStr) {
  if (!pathStr) return obj;
  return String(pathStr).split('.').reduce(function (acc, key) {
    if (acc == null) return null;
    if (Array.isArray(acc)) return acc[Number(key)];
    return acc[key];
  }, obj);
}

function asArray(json, itemsPath) {
  var node = pickPath(json, itemsPath);
  if (Array.isArray(node)) return node;
  if (node && Array.isArray(node.list)) return node.list;
  if (node && Array.isArray(node.items)) return node.items;
  if (node && Array.isArray(node.data)) return node.data;
  if (Array.isArray(json)) return json;
  return [];
}

/* --------- 字段映射：把任意接口的返回结构翻译成内部字段 ---------
   map 里每个字段可以写：
     "account": "owner.name"                        取嵌套路径
     "platform": { "value": "bilibili" }            写死值
     "publish_time": { "path": "pubdate", "type": "unix" }
     "tags": ["tname"]                              数组＝多个来源路径，自动合并
     "views": { "path": "stat.view", "default": 0 }
   映射不到或为空的字段会留给后面的别名识别兜底。
----------------------------------------------------------------- */
function resolvePath(obj, pathStr) {
  if (pathStr == null) return undefined;
  return String(pathStr).split('.').reduce(function (acc, key) {
    if (acc == null) return undefined;
    if (Array.isArray(acc)) return acc[Number(key)];
    return acc[key];
  }, obj);
}

function coerce(value, spec) {
  if (value == null || value === '') {
    return spec && spec.default !== undefined ? spec.default : null;
  }
  if (spec && spec.value !== undefined) return spec.value;
  var num = Number(value);
  if (spec && spec.type === 'unix') return isFinite(num) ? num : null;
  if (spec && spec.type === 'unixMs') return isFinite(num) ? Math.round(num / 1000) : null;
  if (spec && spec.type === 'number') return isFinite(num) ? num : null;
  if (spec && spec.type === 'string') return String(value);
  if (spec && spec.multiply) return isFinite(num) ? num * spec.multiply : null;
  return value;
}

function applyMap(item, map) {
  if (!map || typeof map !== 'object') return item;
  var out = {};
  Object.keys(map).forEach(function (field) {
    var spec = map[field];
    if (typeof spec === 'string') {
      var v = resolvePath(item, spec);
      if (v !== undefined && v !== null && v !== '') out[field] = v;
      return;
    }
    if (Array.isArray(spec)) {
      var list = [];
      spec.forEach(function (one) {
        var val = resolvePath(item, typeof one === 'string' ? one : one.path);
        if (val !== undefined && val !== null && val !== '') list.push(val);
      });
      if (list.length) out[field] = list;
      return;
    }
    if (spec && typeof spec === 'object') {
      if (spec.value !== undefined) { out[field] = spec.value; return; }
      var got = coerce(resolvePath(item, spec.path), spec);
      if (got !== null && got !== undefined) out[field] = got;
    }
  });
  return Object.assign({}, item, out);
}

/* 数据过滤：过滤掉刚发布、还没有任何数据的占位作品，避免污染中位数等分析口径 */
function readViews(row) {
  var v = row.views;
  if (v == null) v = row.play;
  if (v == null) v = row.play_count;
  if (v == null) v = row.view_count;
  if (v == null) v = row['播放量'];
  var n = Number(String(v == null ? 0 : v).replace(/[^\d.]/g, ''));
  return isFinite(n) ? n : 0;
}

function applyFilter(rows, filter) {
  if (!filter || typeof filter !== 'object') return rows;
  var minViews = Number(filter.minViews || 0);
  var maxAgeHours = Number(filter.maxAgeHours || 0);
  if (!minViews && !maxAgeHours) return rows;
  var now = Date.now();
  return rows.filter(function (row) {
    if (minViews && readViews(row) < minViews) return false;
    if (maxAgeHours) {
      var dt = require('./lib/normalize.js').parseTime(
        row.publish_time != null ? row.publish_time : row.ts
      );
      if (dt && (now - dt.getTime()) / 3600000 > maxAgeHours) return false;
    }
    return true;
  });
}

function withTimeout(ms) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ms);
  return { signal: ctrl.signal, done: function () { clearTimeout(timer); } };
}

/* 请求头必须是 ASCII：占位符（例如「Bearer 在这里填你的密钥」）会让请求直接失败，这里过滤掉并提示 */
function sanitizeHeaders(headers) {
  var out = {};
  Object.keys(headers || {}).forEach(function (key) {
    var value = headers[key];
    if (value == null || value === '') return;
    if (/[^\x20-\xFF]/.test(String(value))) {
      process.stderr.write('[adapters] 已忽略请求头 ' + key +
        '：值含非 ASCII 字符，像是没替换的占位符，请在 config.json 或环境变量里填真实值\n');
      return;
    }
    out[key] = String(value);
  });
  return out;
}

/* ---------------- file：读取本地导出文件 ---------------- */
function fileAdapter(config) {
  var normalize = require('./lib/normalize.js');
  var inbox = path.resolve(config.inbox || path.join(__dirname, 'data', 'inbox'));
  var extraFiles = config.files || [];
  return {
    name: 'file',
    describe: '文件采集：' + inbox,
    fetch: async function () {
      var files = [];
      if (fs.existsSync(inbox)) {
        fs.readdirSync(inbox).forEach(function (f) {
          if (/\.(json|csv|txt)$/i.test(f)) files.push(path.join(inbox, f));
        });
      }
      extraFiles.forEach(function (f) {
        var p = path.resolve(f);
        if (fs.existsSync(p) && files.indexOf(p) < 0) files.push(p);
      });
      if (!files.length) throw new Error('inbox 里还没有数据文件：' + inbox);
      var rows = [];
      files.forEach(function (f) {
        rows = rows.concat(normalize.parseAny(fs.readFileSync(f, 'utf8')));
      });
      return rows;
    }
  };
}

/* ---------------- http：你自己的 / 第三方 REST 接口 ---------------- */
function httpAdapter(config) {
  var url = config.url;
  if (!url) throw new Error('http 适配器需要配置 url');
  var headers = sanitizeHeaders(Object.assign({ Accept: 'application/json' }, config.headers || {}));
  var itemsPath = config.itemsPath || 'data.list';
  var timeout = config.timeoutMs || 20000;
  var pages = Math.max(1, Number(config.pages || 1));
  var pageParam = config.pageParam || 'page';

  function buildUrl(page, ctx) {
    var target = String(url)
      .replace(/\{date\}/g, ctx.date)
      .replace(/\{from\}/g, ctx.from)
      .replace(/\{to\}/g, ctx.to)
      .replace(/\{page\}/g, String(page));
    if (pages > 1 && String(url).indexOf('{page}') < 0) {
      target += (target.indexOf('?') >= 0 ? '&' : '?') + pageParam + '=' + page;
    }
    return target;
  }

  async function fetchPage(page, ctx) {
    var t = withTimeout(timeout);
    var res;
    try {
      res = await fetch(buildUrl(page, ctx), { headers: headers, signal: t.signal });
    } finally {
      t.done();
    }
    if (!res.ok) throw new Error('接口返回 ' + res.status + ' ' + res.statusText);
    return asArray(await res.json(), itemsPath).map(function (item) {
      return applyMap(item, config.map);
    });
  }

  return {
    name: 'http',
    describe: 'HTTP 拉取：' + url,
    fetch: async function (ctx) {
      var wanted = [];
      for (var page = 1; page <= pages; page++) wanted.push(page);
      // 分页并行 + 单页失败不影响其它页，某页超时也能拿到其余页的数据
      var results = await Promise.all(wanted.map(function (page) {
        return fetchPage(page, ctx).then(function (rows) {
          return { page: page, rows: rows, error: null };
        }).catch(function (err) {
          return { page: page, rows: [], error: err.message };
        });
      }));
      var out = [], errors = [];
      results.sort(function (a, b) { return a.page - b.page; }).forEach(function (r) {
        out = out.concat(r.rows);
        if (r.error) errors.push('第 ' + r.page + ' 页：' + r.error);
      });
      if (!out.length && errors.length) throw new Error(errors.join('；'));
      if (errors.length) process.stderr.write('[adapters] ' + url + ' ' + errors.join('；') + '\n');
      return applyFilter(out, config.filter);
    }
  };
}

/* ---------------- official：官方开放平台 ---------------- */
function officialAdapter(config) {
  var ep = config.endpoints || {};
  var cred = config.credentials || {};
  if (!ep.token || !ep.list) {
    throw new Error('official 适配器需要在 config.json 里填 endpoints.token 与 endpoints.list。' +
      '这两个地址请以你获批的平台开放平台文档为准，或者改用 file / http 适配器。');
  }
  var tokenCache = {
    value: cred.access_token || '',
    expireAt: cred.access_token ? Date.now() + 1800e3 : 0
  };
  async function getToken() {
    if (tokenCache.value && Date.now() < tokenCache.expireAt - 60000) return tokenCache.value;
    if (cred.access_token) {
      tokenCache.value = cred.access_token;
      tokenCache.expireAt = Date.now() + 1800e3;
      return tokenCache.value;
    }
    var t = withTimeout(15000);
    var res;
    try {
      res = await fetch(ep.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_key: cred.client_key,
          client_secret: cred.client_secret,
          app_id: cred.app_id,
          app_secret: cred.app_secret,
          grant_type: 'client_credential'
        }),
        signal: t.signal
      });
    } finally {
      t.done();
    }
    var json = await res.json();
    var data = json && json.data ? json.data : json;
    var token = data && (data.access_token || data.client_token || data.access_token_client);
    if (!token) throw new Error('取 token 失败：' + JSON.stringify(json).slice(0, 300));
    tokenCache.value = token;
    tokenCache.expireAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return token;
  }
  return {
    name: 'official:' + (config.platform || 'unknown'),
    describe: '官方开放平台：' + ep.list,
    fetch: async function (ctx) {
      var token = await getToken();
      var pages = Math.max(1, Number(config.pages || 5));
      var pageSize = Number(config.pageSize || 50);
      var isPost = String(config.method || 'GET').toUpperCase() === 'POST';
      var out = [];
      for (var page = 1; page <= pages; page++) {
        var target = String(ep.list)
          .replace(/\{date\}/g, ctx.date)
          .replace(/\{from\}/g, ctx.from)
          .replace(/\{to\}/g, ctx.to)
          .replace(/\{page\}/g, String(page))
          .replace(/\{size\}/g, String(pageSize));
        var t = withTimeout(config.timeoutMs || 20000);
        var res;
        try {
          res = await fetch(target, {
            method: isPost ? 'POST' : 'GET',
            headers: sanitizeHeaders(Object.assign({
              'Content-Type': 'application/json',
              'access-token': token,
              Authorization: 'Bearer ' + token
            }, config.headers || {})),
            body: isPost ? JSON.stringify({
              date: ctx.date,
              start_date: ctx.from,
              end_date: ctx.to,
              page: page,
              size: pageSize,
              cursor: page * pageSize
            }) : undefined,
            signal: t.signal
          });
        } finally {
          t.done();
        }
        if (!res.ok) throw new Error('平台接口返回 ' + res.status + ' ' + res.statusText);
        var list = asArray(await res.json(), config.itemsPath || 'data.list').map(function (item) {
          return applyMap(item, config.map);
        });
        out = out.concat(list);
        if (list.length < pageSize) break;
      }
      return out;
    }
  };
}

/* ---------------- none：只接收外部推送 ---------------- */
function noneAdapter() {
  return {
    name: 'none',
    describe: '被动接收模式：不主动采集，等待 POST /api/ingest 推数据',
    fetch: async function () { return []; }
  };
}

/* 多数据源：一个采集服务同时拉多个接口（例如 B站热门 + B站排行，或抖音 + 快手 + 小红书） */
function multiSourceAdapter(config) {
  var subs = config.sources.map(function (src) {
    var merged = Object.assign({}, config, src, {
      sources: undefined,
      headers: Object.assign({}, config.headers || {}, src.headers || {}),
      map: src.map || config.map
    });
    return {
      label: src.name || src.url,
      adapter: httpAdapter(merged)
    };
  });
  return {
    name: 'http（' + subs.length + ' 个源）',
    describe: '多源拉取：' + subs.map(function (s) { return s.label; }).join(' + '),
    fetch: async function (ctx) {
      // 并行拉取：某个源慢或挂了不会拖住其它源，整体耗时取决于最慢的那个
      var results = await Promise.all(subs.map(function (sub) {
        return sub.adapter.fetch(ctx).then(function (rows) {
          return { label: sub.label, rows: rows, error: null };
        }).catch(function (err) {
          return { label: sub.label, rows: [], error: err.message };
        });
      }));
      var out = [], errors = [];
      results.forEach(function (r) {
        out = out.concat(r.rows);
        if (r.error) errors.push(r.label + ' 失败：' + r.error);
      });
      if (!out.length && errors.length) throw new Error(errors.join('；'));
      if (errors.length) process.stderr.write('[adapters] ' + errors.join('；') + '\n');
      return out;
    }
  };
}

function createAdapter(config) {
  var type = String((config && config.adapter) || 'file').toLowerCase();
  if (config && Array.isArray(config.sources) && config.sources.length) return multiSourceAdapter(config);
  if (type === 'http' || type === 'api' || type === 'thirdparty') return httpAdapter(config || {});
  if (type === 'official' || type === 'douyin' || type === 'kuaishou') return officialAdapter(config || {});
  if (type === 'none' || type === 'push') return noneAdapter();
  return fileAdapter(config || {});
}

module.exports = {
  createAdapter: createAdapter,
  asArray: asArray,
  pickPath: pickPath,
  sanitizeHeaders: sanitizeHeaders,
  applyMap: applyMap,
  resolvePath: resolvePath,
  fetchTrends: fetchTrends
};

/* ---------------- 平台热榜（抖音/快手等公开热榜接口） ----------------
   trends 配置示例：
     { "name":"抖音热榜", "platform":"douyin",
       "url":"https://.../word/", "itemsPath":"word_list",
       "map": { "title":"word", "hot_value":"hot_value" } }
   返回统一结构：{ platform, listKey, title, hot, rank, url }
--------------------------------------------------------------------- */
function normNum(v) {
  if (v == null) return 0;
  var s = String(v).replace(/[,%\s]/g, '');
  var multi = 1;
  if (/万$/.test(s)) { multi = 1e4; s = s.replace(/万$/, ''); }
  else if (/亿$/.test(s)) { multi = 1e8; s = s.replace(/亿$/, ''); }
  else if (/[kK]$/.test(s)) { multi = 1e3; s = s.replace(/[kK]$/, ''); }
  var n = Number(s);
  return isFinite(n) ? n * multi : 0;
}

function trendRow(item, def, index) {
  var m = applyMap(item, def.map);
  var title = m.title != null ? m.title : (m.word != null ? m.word : (m.name != null ? m.name : m.hot_word));
  title = String(title == null ? '' : title).trim();
  if (!title) return null;
  var hot = m.hot_value != null ? m.hot_value : (m.hot != null ? m.hot : (m.hotValue != null ? m.hotValue : m.hot_score));
  var rank = Number(m.rank);
  var hotNum = normNum(hot);
  // 榜单里的置顶条目（名次 0、热度为空）不是真实排名，跳过
  if (hotNum <= 0 && (!isFinite(rank) || rank <= 0)) return null;
  return {
    platform: def.platform || def.name || 'unknown',
    listKey: def.listKey || def.platform || 'hot',
    title: title,
    hot: hotNum,
    rank: isFinite(rank) && rank > 0 ? rank : index + 1,
    url: String(m.url || m.link || '')
  };
}

async function fetchTrends(defs, ctx) {
  var out = [];
  var list = Array.isArray(defs) ? defs : [];
  var results = await Promise.all(list.map(function (def) {
    return (async function () {
      var target = String(def.url)
        .replace(/\{date\}/g, ctx.date)
        .replace(/\{from\}/g, ctx.from)
        .replace(/\{to\}/g, ctx.to);
      var isPost = String(def.method || 'GET').toUpperCase() === 'POST';
      var t = withTimeout(def.timeoutMs || 15000);
      var res;
      try {
        res = await fetch(target, {
          method: isPost ? 'POST' : 'GET',
          headers: sanitizeHeaders(Object.assign(
            { Accept: 'application/json, text/plain, */*' },
            isPost ? { 'Content-Type': 'application/json' } : {},
            def.headers || {}
          )),
          body: isPost ? JSON.stringify(def.body || {}) : undefined,
          signal: t.signal
        });
      } finally {
        t.done();
      }
      if (!res.ok) throw new Error((def.name || target) + ' 返回 ' + res.status);
      var json = await res.json();
      var items = asArray(json, def.itemsPath).map(function (item, i) {
        return trendRow(item, Object.assign({ platform: def.platform, listKey: def.listKey }, def), i);
      }).filter(Boolean);
      return { name: def.name || def.platform, items: items };
    })().catch(function (err) {
      return { name: def.name || def.url, items: [], error: err.message };
    });
  }));
  results.forEach(function (r) {
    if (r.error) process.stderr.write('[trends] ' + r.name + ' 失败：' + r.error + '\n');
    out = out.concat(r.items);
  });
  return out;
}
