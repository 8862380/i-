'use strict';
/* 24 小时采集服务：定时拉数据 -> 入库 -> 通过 SSE 实时推给看板。
   启动： node server.js       （改端口/适配器见 config.json 或环境变量）
*/

var http = require('node:http');
var fs = require('node:fs');
var path = require('node:path');
var childProcess = require('node:child_process');

var normalize = require('./lib/normalize.js');
var storeLib = require('./lib/store.js');
var alertsLib = require('./lib/alerts.js');
var notifyLib = require('./lib/notify.js');
var adapters = require('./adapters.js');

var ROOT = path.resolve(__dirname, '..');            // 静态站点根目录（index.html 所在目录）
var DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
var LOG_DIR = path.join(DATA_DIR, 'logs');
var CONFIG_PATH = path.join(__dirname, process.env.CONFIG_FILE || 'config.json');
var EXAMPLE_CONFIG = path.join(__dirname, 'config.example.json');
var STATIC_DIR = path.join(ROOT, 'data');          // GitHub Pages 用的静态数据目录

/* 命令行开关：
     --once    只采集一轮就退出（GitHub Actions / 计划任务用）
     --export  退出前把数据导出成 data/works.json + data/meta.json（纯静态托管用）
     --open    服务就绪后自动打开浏览器
   环境变量：
     STATIC_DAYS  导出保留天数，默认 7
*/
var ARGV = process.argv.slice(2);
var ONCE_MODE = ARGV.indexOf('--once') >= 0;
var EXPORT_MODE = ARGV.indexOf('--export') >= 0;
var STATIC_DAYS = Math.max(1, Number(process.env.STATIC_DAYS || 7));

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensureDir(DATA_DIR);
ensureDir(LOG_DIR);

function loadConfig() {
  var file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG;
  var cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write('[config] 读取失败（' + file + '）：' + err.message + '\n');
  }
  cfg.port = Number(process.env.PORT || cfg.port || 8787);
  cfg.host = process.env.HOST || cfg.host || '0.0.0.0';
  cfg.intervalSeconds = Math.max(30, Number(process.env.INTERVAL || cfg.intervalSeconds || 300));
  cfg.adapter = process.env.ADAPTER || cfg.adapter || 'file';
  cfg.ingestToken = process.env.INGEST_TOKEN || cfg.ingestToken || '';
  cfg.daysBack = Math.max(1, Number(cfg.daysBack || 2));
  cfg.source = path.basename(file) + (file === EXAMPLE_CONFIG ? '（示例配置，建议复制为 config.json）' : '');

  // 环境变量覆盖：服务器 / 容器部署时可以直接用环境变量，不必改 config.json
  function env(name) {
    var v = process.env[name];
    return v == null || v === '' ? undefined : v;
  }
  if (env('URL')) cfg.url = env('URL');
  if (env('ITEMS_PATH')) cfg.itemsPath = env('ITEMS_PATH');
  if (env('PAGES')) cfg.pages = Number(env('PAGES'));
  if (env('PLATFORM')) cfg.platform = env('PLATFORM');
  if (env('PUBLIC_URL')) cfg.publicUrl = env('PUBLIC_URL');
  if (env('AUTH_HEADER') || env('TOKEN_HEADER')) {
    cfg.headers = Object.assign({}, cfg.headers);
    if (env('AUTH_HEADER')) cfg.headers.Authorization = env('AUTH_HEADER');
    if (env('TOKEN_HEADER')) cfg.headers['access-token'] = env('TOKEN_HEADER');
  }
  if (env('ENDPOINTS_TOKEN') || env('ENDPOINTS_LIST')) {
    cfg.endpoints = Object.assign({}, cfg.endpoints);
    if (env('ENDPOINTS_TOKEN')) cfg.endpoints.token = env('ENDPOINTS_TOKEN');
    if (env('ENDPOINTS_LIST')) cfg.endpoints.list = env('ENDPOINTS_LIST');
  }
  if (env('CLIENT_KEY') || env('CLIENT_SECRET') || env('ACCESS_TOKEN')) {
    cfg.credentials = Object.assign({}, cfg.credentials);
    if (env('CLIENT_KEY')) cfg.credentials.client_key = env('CLIENT_KEY');
    if (env('CLIENT_SECRET')) cfg.credentials.client_secret = env('CLIENT_SECRET');
    if (env('ACCESS_TOKEN')) cfg.credentials.access_token = env('ACCESS_TOKEN');
  }
  if (env('NOTIFY_ENABLED') || env('NOTIFY_WEBHOOK') || env('NOTIFY_FORMAT')) {
    cfg.notify = Object.assign({}, cfg.notify);
    if (env('NOTIFY_ENABLED')) cfg.notify.enabled = /^(1|true|yes|on)$/i.test(env('NOTIFY_ENABLED'));
    if (env('NOTIFY_WEBHOOK')) cfg.notify.webhook = env('NOTIFY_WEBHOOK');
    if (env('NOTIFY_FORMAT')) cfg.notify.format = env('NOTIFY_FORMAT');
  }
  return cfg;
}

var config = loadConfig();
var store = storeLib.openStore(DATA_DIR);
var adapter = adapters.createAdapter(config);
var notifier = notifyLib.createNotifier(config.notify || {});
var lastAlertAt = new Map();
var sseClients = new Set();
var pollTimer = null;
var heartbeatTimer = null;
var startedAt = Date.now();
var logStream = null;
var loggingClosed = false;

var state = {
  adapter: adapter.name,
  adapterDesc: adapter.describe,
  interval: config.intervalSeconds * 1000,
  lastPollAt: 0,
  nextPollAt: 0,
  lastOk: true,
  lastError: '',
  consecutiveErrors: 0,
  lastFetched: 0,
  lastChanged: 0,
  polls: 0
};

function log(message) {
  var line = '[' + new Date().toISOString() + '] ' + message;
  process.stdout.write(line + '\n');
  if (loggingClosed) return;
  try {
    if (!logStream || logStream.__day !== new Date().toISOString().slice(0, 10)) {
      var day = new Date().toISOString().slice(0, 10);
      logStream = fs.createWriteStream(path.join(LOG_DIR, 'server-' + day + '.log'), { flags: 'a' });
      logStream.__day = day;
    }
    if (logStream && !logStream.writableEnded) logStream.write(line + '\n');
  } catch (err) { /* 日志失败不影响主流程 */ }
}

/* 服务就绪后自动打开浏览器（OPEN_BROWSER=1 或命令行加 --open） */
function openBrowser(url) {
  var want = process.env.OPEN_BROWSER === '1' || process.argv.indexOf('--open') >= 0;
  if (!want) return;
  try {
    if (process.platform === 'win32') {
      childProcess.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      childProcess.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      childProcess.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    log('已尝试打开浏览器：' + url);
  } catch (err) {
    log('自动打开浏览器失败（不影响使用，请手动访问上面的地址）：' + err.message);
  }
}

/* ---------------- 汇总（服务端口径，与前端一致） ---------------- */
function summarize(rows) {
  var per = {}, hours = new Array(24).fill(0), tags = {};
  var t = { works: 0, views: 0, likes: 0, comments: 0, shares: 0, collects: 0, follows: 0 };
  rows.forEach(function (w) {
    var p = per[w.platform] || (per[w.platform] = {
      platform: w.platform, works: 0, views: 0, likes: 0, comments: 0,
      shares: 0, collects: 0, follows: 0, hours: new Array(24).fill(0)
    });
    p.works++; p.views += w.views; p.likes += w.likes; p.comments += w.comments;
    p.shares += w.shares; p.collects += w.collects; p.follows += w.follows;
    p.hours[w.hour]++;
    hours[w.hour]++;
    t.works++; t.views += w.views; t.likes += w.likes; t.comments += w.comments;
    t.shares += w.shares; t.collects += w.collects; t.follows += w.follows;
    (w.tags || []).forEach(function (tag) {
      var o = tags[tag] || (tags[tag] = { tag: tag, works: 0, views: 0 });
      o.works++; o.views += w.views;
    });
  });
  var list = Object.keys(per).map(function (k) {
    var p = per[k];
    p.engagement = p.views ? (p.likes + p.comments + p.shares + p.collects) / p.views : 0;
    p.avgViews = p.works ? p.views / p.works : 0;
    return p;
  }).sort(function (a, b) { return b.views - a.views; });
  t.engagement = t.views ? (t.likes + t.comments + t.shares + t.collects) / t.views : 0;
  return {
    totals: t,
    hourly: hours,
    platforms: list,
    tags: Object.keys(tags).map(function (k) { return tags[k]; })
      .sort(function (a, b) { return b.works - a.works; }).slice(0, 30)
  };
}

function statusPayload() {
  var today = normalize.dateKey(new Date());
  return Object.assign({}, state, {
    ok: state.lastOk,
    running: true,
    store: store.kind,
    configSource: config.source,
    today: today,
    storeStats: store.stats(),
    todayStats: store.dayStats(today),
    notify: notifier.status(),
    trends: {
      enabled: !!(config.trends && config.trends.length),
      sources: (config.trends || []).map(function (t) { return t.name || t.platform; }),
      lastCount: store.trendPlatforms().reduce(function (s, t) { return s + t.count; }, 0),
      platforms: store.trendPlatforms().map(function (t) { return t.platform + ':' + t.count; })
    },
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    clients: sseClients.size,
    recentPolls: store.recentPolls(8).map(function (p) {
      return { ts: p.ts, ok: !!p.ok, fetched: p.fetched, upserted: p.upserted, message: p.message };
    })
  });
}

/* ---------------- SSE ---------------- */
function broadcast(event, data) {
  if (!sseClients.size) return;
  var payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  sseClients.forEach(function (res) {
    try { res.write(payload); } catch (err) { sseClients.delete(res); }
  });
}

/* ---------------- 采集调度 ---------------- */
function scheduleNext(delay) {
  if (pollTimer) clearTimeout(pollTimer);
  var ms = Math.max(5000, delay);
  state.nextPollAt = Date.now() + ms;
  pollTimer = setTimeout(pollOnce, ms);
}

/* 给 Promise 套一个截止时间，超时后抛错并清理定时器（定时器 unref，不阻塞进程退出） */
function withDeadline(promise, ms, message) {
  var timer = null;
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error(message)); }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).then(function (value) {
    if (timer) clearTimeout(timer);
    return value;
  }, function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

/* ---------------- 预警：广播给看板 + 可选外部推送 ---------------- */
function staticRow(w) {
  return workStaticRow(w);
}

/* 热榜数据（抖音/快手热搜等）：最新一次 + 上一次快照 + 每条的上榜历史 */
function trendsPayload(limit) {
  var out = [];
  store.trendPlatforms().forEach(function (p) {
    var latest = store.trendSnapshot(p.platform, 0);
    var prev = store.trendSnapshot(p.platform, 1);
    var hist = {};
    store.trendHistory(p.platform, Date.now() - 7 * 86400000).forEach(function (h) { hist[h.title] = h; });
    var prevMap = {};
    if (prev) prev.items.forEach(function (it) { prevMap[it.title] = it; });
    out.push({
      platform: p.platform,
      listKey: p.listKey,
      capturedAt: p.capturedAt,
      previousCapturedAt: prev ? prev.capturedAt : null,
      count: latest ? latest.items.length : 0,
      items: (latest ? latest.items : []).slice(0, limit || 100).map(function (it) {
        var h = hist[it.title] || {};
        var pv = prevMap[it.title];
        return {
          rank: it.rank,
          title: it.title,
          hot: it.hot,
          url: it.url,
          firstSeen: h.firstSeen || null,
          bestRank: h.bestRank != null ? h.bestRank : it.rank,
          peakHot: h.peakHot != null ? h.peakHot : it.hot,
          seen: h.seen || 1,
          prevRank: pv ? pv.rank : null,
          prevHot: pv ? pv.hot : null,
          isNew: !pv
        };
      })
    });
  });
  return { generatedAt: Date.now(), platforms: out };
}

function workStaticRow(w) {
  return {
    work_id: w.id,
    platform: w.platform,
    account: w.account,
    author_id: w.authorId || '',
    title: w.title,
    tags: w.tags || [],
    publish_time: w.dateKey + ' ' + normalize.pad2(w.hour) + ':' + normalize.pad2(w.minute) + ':00',
    views: w.views,
    likes: w.likes,
    comments: w.comments,
    shares: w.shares,
    collects: w.collects,
    follows: w.follows
  };
}

/* 导出静态数据：GitHub Pages / 任何静态托管都能直接读 */
function writeStaticExport() {
  if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR, { recursive: true });
  var to = normalize.dateKey(new Date());
  var from = normalize.shiftKey(to, -(STATIC_DAYS - 1));
  var rows = store.queryRange(from, to, []).sort(function (a, b) { return b.ts - a.ts; });
  var maxRows = Number(process.env.STATIC_MAX || 20000);
  if (rows.length > maxRows) rows = rows.slice(0, maxRows);
  var works = rows.map(staticRow);
  var meta = {
    generatedAt: Date.now(),
    generatedAtText: new Date().toISOString(),
    days: STATIC_DAYS,
    count: works.length,
    adapter: adapter.name,
    adapterDesc: adapter.describe,
    configSource: config.source,
    lastPollAt: state.lastPollAt,
    lastOk: state.lastOk,
    lastError: state.lastError,
    minDay: rows.length ? rows[rows.length - 1].dateKey : null,
    maxDay: rows.length ? rows[0].dateKey : null
  };
  fs.writeFileSync(path.join(STATIC_DIR, 'works.json'), JSON.stringify(works), 'utf8');
  var trends = trendsPayload(100);
  // 热榜按天留存：每天最后一次快照，方便回看"昨天的抖音热榜"
  var trendsHistory = {
    generatedAt: Date.now(),
    platforms: store.trendPlatforms().map(function (p) {
      return { platform: p.platform, days: store.trendDays(p.platform, Date.now() - 30 * 86400000) };
    })
  };
  meta.trends = trends.platforms.map(function (p) { return { platform: p.platform, count: p.count, capturedAt: p.capturedAt }; });
  meta.trendDays = trendsHistory.platforms.map(function (p) {
    return { platform: p.platform, days: p.days.length };
  });
  fs.writeFileSync(path.join(STATIC_DIR, 'trends.json'), JSON.stringify(trends), 'utf8');
  fs.writeFileSync(path.join(STATIC_DIR, 'trends-history.json'), JSON.stringify(trendsHistory), 'utf8');
  fs.writeFileSync(path.join(STATIC_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  log('已导出静态数据：' + works.length + ' 条作品（' + (meta.minDay || '—') + ' ~ ' + (meta.maxDay || '—') + '）→ data/works.json' +
    (meta.trends.length ? '，热榜 ' + meta.trends.map(function (t) { return t.platform + ' ' + t.count + ' 条'; }).join('、') : ''));
  return meta;
}

/* GitHub Actions 每次都是干净环境，先把仓库里已有的历史数据载回存储，再采集，数据才能累积 */
function seedFromStatic() {
  var file = path.join(STATIC_DIR, 'works.json');
  if (!fs.existsSync(file)) return 0;
  try {
    var rows = normalize.parseAny(fs.readFileSync(file, 'utf8')).map(normalize.normalizeRaw).filter(Boolean);
    if (!rows.length) return 0;
    var out = store.upsertWorks(rows, Date.now());
    log('已载入仓库里的历史数据：' + rows.length + ' 条（新增 ' + out.inserted + '，更新 ' + out.updated + '）');
    return rows.length;
  } catch (err) {
    log('载入历史数据失败：' + err.message);
    return 0;
  }
}

async function evaluateAlerts() {
  var day = normalize.dateKey(new Date());
  var yday = normalize.shiftKey(day, -1);
  var todayRows = store.queryRange(day, day, []);
  if (!todayRows.length) return [];
  var alerts = alertsLib.computeAlerts(todayRows, store.queryRange(yday, yday, []),
    (config.notify && config.notify.rules) || {});
  var now = Date.now();
  var fresh = alerts.filter(function (a) {
    var last = lastAlertAt.get(a.key) || 0;
    return now - last > 30 * 60 * 1000;
  });
  if (fresh.length) {
    broadcast('alert', { at: now, alerts: fresh });
  }
  if (notifier.enabled) {
    try {
      var sent = await notifier.push(alerts, {
        date: day,
        url: config.publicUrl || ('http://localhost:' + config.port + '/')
      });
      if (sent.length) {
        log('已推送 ' + sent.length + ' 条告警到 webhook');
        sent.forEach(function (a) { lastAlertAt.set(a.key, now); });
      }
    } catch (err) {
      log('告警推送失败：' + err.message);
    }
  }
  return alerts;
}

async function pollOnce() {
  var today = normalize.dateKey(new Date());
  var ctx = {
    date: today,
    from: normalize.shiftKey(today, -(config.daysBack - 1)),
    to: today
  };
  state.polls++;
  try {
    // 整体超时兜底：上游集体变慢时也要让采集周期正常结束、排下一次采集
    var pollTimeout = Number(config.pollTimeoutMs || 180000);
    var rawRows = await withDeadline(adapter.fetch(ctx), pollTimeout,
      '采集整体超时（' + Math.round(pollTimeout / 1000) + ' 秒），本轮放弃');
    var rows = [];
    var bad = 0;
    (rawRows || []).forEach(function (raw) {
      var w = normalize.normalizeRaw(raw);
      if (w) rows.push(w); else bad++;
    });
    var now = Date.now();
    var res = store.upsertWorks(rows, now);
    state.lastPollAt = now;
    state.lastOk = true;
    state.lastError = '';
    state.consecutiveErrors = 0;
    state.lastFetched = rows.length;
    state.lastChanged = res.changed.length;
    store.logPoll({
      ts: now, ok: true, adapter: adapter.name, fetched: rows.length,
      upserted: res.inserted + res.updated,
      message: '新增 ' + res.inserted + ' 更新 ' + res.updated + (bad ? ' 跳过 ' + bad : '')
    });
    log('采集成功：拉取 ' + rows.length + ' 条，新增 ' + res.inserted + '，更新 ' + res.updated +
      (bad ? '，跳过 ' + bad + ' 条无法识别' : ''));
    broadcast('status', statusPayload());
    if (res.changed.length) {
      if (res.changed.length <= 800) {
        broadcast('update', { at: now, changed: res.changed, fetched: rows.length, clientCount: sseClients.size });
      } else {
        broadcast('update', { at: now, fullSync: true, fetched: rows.length });
      }
    }
    evaluateAlerts().catch(function (err) { log('预警计算失败：' + err.message); });
    if (config.trends && config.trends.length) {
      try {
        var trendRows = await adapters.fetchTrends(config.trends, ctx);
        if (trendRows.length) {
          store.insertTrends(trendRows, now);
          state.lastTrends = trendRows.length;
          broadcast('trends', {
            at: now,
            platforms: trendsPayload(30).platforms.map(function (p) {
              return { platform: p.platform, count: p.count, capturedAt: p.capturedAt };
            })
          });
          log('热榜采集成功：' + trendRows.length + ' 条');
        }
      } catch (err) {
        log('热榜采集失败：' + err.message);
      }
      try { store.pruneTrends(Date.now() - 30 * 86400000); } catch (e) { /* ignore */ }
    }
    scheduleNext(state.interval);
  } catch (err) {
    state.lastPollAt = Date.now();
    state.lastOk = false;
    state.lastError = err.message;
    state.consecutiveErrors++;
    store.logPoll({
      ts: state.lastPollAt, ok: false, adapter: adapter.name,
      fetched: 0, upserted: 0, message: err.message
    });
    var backoff = Math.min(state.interval * Math.pow(2, state.consecutiveErrors - 1), 30 * 60 * 1000);
    log('采集失败（第 ' + state.consecutiveErrors + ' 次）：' + err.message + '，' + Math.round(backoff / 1000) + ' 秒后重试');
    broadcast('status', statusPayload());
    scheduleNext(backoff);
  }
}

/* ---------------- HTTP ---------------- */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function sendJson(res, obj, code) {
  var body = JSON.stringify(obj);
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > (limit || 8 * 1024 * 1024)) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function platformFilter(url) {
  var raw = url.searchParams.get('platforms') || url.searchParams.get('platform') || '';
  return raw ? raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
}

function toCsv(rows) {
  var head = ['平台', '账号', '标题', '标签', '发布时间', '播放量', '点赞', '评论', '分享', '收藏', '涨粉', '互动率'];
  var lines = rows.map(function (w) {
    var eng = w.views ? (w.likes + w.comments + w.shares + w.collects) / w.views : 0;
    return [
      w.platform, w.account, w.title, (w.tags || []).join('|'),
      w.dateKey + ' ' + normalize.pad2(w.hour) + ':' + normalize.pad2(w.minute) + ':00',
      w.views, w.likes, w.comments, w.shares, w.collects, w.follows, (eng * 100).toFixed(2) + '%'
    ].map(function (c) {
      var s = String(c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  });
  return '\uFEFF' + head.join(',') + '\n' + lines.join('\n');
}

function serveStatic(req, res, url) {
  var rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  var filePath = path.resolve(ROOT, '.' + rel);
  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': st.size
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleApi(req, res, url) {
  var p = url.pathname;

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, statusPayload());
  }

  if (p === '/api/works' && req.method === 'GET') {
    var platforms = platformFilter(url);
    var from = url.searchParams.get('from') || url.searchParams.get('date') || normalize.dateKey(new Date());
    var to = url.searchParams.get('to') || from;
    var rows = store.queryRange(from, to, platforms);
    return sendJson(res, { from: from, to: to, count: rows.length, works: rows });
  }

  if (p === '/api/summary' && req.method === 'GET') {
    var day = url.searchParams.get('date') || normalize.dateKey(new Date());
    var rows2 = store.queryRange(day, day, platformFilter(url));
    return sendJson(res, Object.assign({ date: day, count: rows2.length }, summarize(rows2)));
  }

  if (p === '/api/export' && req.method === 'GET') {
    var day2 = url.searchParams.get('date') || normalize.dateKey(new Date());
    var rows3 = store.queryRange(day2, day2, platformFilter(url));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="works-' + day2 + '.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end(toCsv(rows3));
  }

  if (p === '/api/trends' && req.method === 'GET') {
    var onlyPlatform = url.searchParams.get('platform') || '';
    var payload = trendsPayload(Number(url.searchParams.get('limit') || 100));
    if (url.searchParams.get('history')) {
      payload.history = {
        generatedAt: Date.now(),
        platforms: store.trendPlatforms().map(function (t) {
          return { platform: t.platform, days: store.trendDays(t.platform, Date.now() - 30 * 86400000) };
        })
      };
    }
    if (onlyPlatform) {
      payload.platforms = payload.platforms.filter(function (x) { return x.platform === onlyPlatform; });
    }
    return sendJson(res, payload);
  }

  if (p === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 5000\n\n');
    res.write('event: status\ndata: ' + JSON.stringify(statusPayload()) + '\n\n');
    sseClients.add(res);
    req.on('close', function () { sseClients.delete(res); });
    return undefined;
  }

  if (p === '/api/ingest' && req.method === 'POST') {
    var token = req.headers['x-ingest-token'] || url.searchParams.get('token');
    if (config.ingestToken && token !== config.ingestToken) {
      return sendJson(res, { ok: false, error: 'token 不正确' }, 401);
    }
    return readBody(req).then(function (body) {
      var raw;
      try {
        raw = normalize.parseAny(body);
      } catch (err) {
        return sendJson(res, { ok: false, error: err.message }, 400);
      }
      var rows = [], bad = 0;
      raw.forEach(function (r) {
        var w = normalize.normalizeRaw(r);
        if (w) rows.push(w); else bad++;
      });
      var now = Date.now();
      var out = store.upsertWorks(rows, now);
      store.logPoll({
        ts: now, ok: true, adapter: 'ingest', fetched: rows.length,
        upserted: out.inserted + out.updated,
        message: '外部推送：新增 ' + out.inserted + '，更新 ' + out.updated + (bad ? '，无效 ' + bad : '')
      });
      log('接收推送：' + rows.length + ' 条，新增 ' + out.inserted + '，更新 ' + out.updated);
      broadcast('status', statusPayload());
      if (out.changed.length) {
        broadcast('update', { at: now, changed: out.changed, source: 'ingest' });
      }
      evaluateAlerts().catch(function (err) { log('预警计算失败：' + err.message); });
      return sendJson(res, { ok: true, received: raw.length, accepted: rows.length, skipped: bad, inserted: out.inserted, updated: out.updated });
    }).catch(function (err) {
      return sendJson(res, { ok: false, error: err.message }, 400);
    });
  }

  if (p === '/api/polls' && req.method === 'GET') {
    return sendJson(res, { polls: store.recentPolls(Number(url.searchParams.get('limit') || 30)) });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    var rtoken = req.headers['x-ingest-token'] || url.searchParams.get('token');
    if (config.ingestToken && rtoken !== config.ingestToken) {
      return sendJson(res, { ok: false, error: 'token 不正确' }, 401);
    }
    var cleared = store.stats().works;
    store.clearAll();
    log('已清空历史数据（' + cleared + ' 条作品）');
    broadcast('status', statusPayload());
    broadcast('update', { at: Date.now(), fullSync: true, fetched: 0, cleared: true });
    return sendJson(res, { ok: true, cleared: cleared });
  }

  if (p === '/api/health') {
    return sendJson(res, { ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  }

  return sendJson(res, { ok: false, error: '未知接口 ' + p }, 404);
}

var server = http.createServer(function (req, res) {
  var url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (url.pathname.indexOf('/api/') === 0) {
    Promise.resolve()
      .then(function () { return handleApi(req, res, url); })
      .catch(function (err) {
        log('接口错误 ' + url.pathname + '：' + err.message);
        if (!res.headersSent) sendJson(res, { ok: false, error: err.message }, 500);
      });
    return;
  }
  serveStatic(req, res, url);
});

function startServer() {
  heartbeatTimer = setInterval(function () {
    sseClients.forEach(function (res) {
      try { res.write(': ping ' + Date.now() + '\n\n'); } catch (err) { sseClients.delete(res); }
    });
  }, 15000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  server.listen(config.port, config.host, function () {
    log('监控服务已启动');
    log('  看板地址   http://localhost:' + config.port + '/');
    log('  数据源     ' + adapter.describe);
    log('  采集间隔   ' + config.intervalSeconds + ' 秒');
    log('  存储后端   ' + store.kind + '（' + DATA_DIR + '）');
    log('  配置文件   ' + config.source);
    pollOnce();
    setTimeout(function () {
      openBrowser('http://localhost:' + config.port + '/');
    }, 700);
  });
}

/* 一次性模式：GitHub Actions / 计划任务（采集一轮 → 可选导出 → 退出）
   注意不要用 process.exit 强退：Windows 上 undici 句柄还在收尾时强退会触发 libuv 断言，
   GitHub Actions 会因此把这一步判为失败。这里只设置退出码，让事件循环自然结束。 */
function runOnce() {
  log('单轮采集模式启动（--once' + (EXPORT_MODE ? ' --export' : '') + '）');
  log('  数据源     ' + adapter.describe);
  log('  存储后端   ' + store.kind + '（' + DATA_DIR + '）');
  log('  配置文件   ' + config.source);
  seedFromStatic();
  pollOnce().then(function () {
    if (pollTimer) clearTimeout(pollTimer);
    var meta = null;
    if (EXPORT_MODE) {
      try {
        meta = writeStaticExport();
      } catch (err) {
        log('导出静态数据失败：' + err.message);
      }
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    var ok = !!(state.lastPollAt && state.lastOk);
    try { store.close(); } catch (e) { /* ignore */ }
    if (logStream) { try { logStream.end(); } catch (e) { /* ignore */ } logStream = null; }
    loggingClosed = true;
    process.exitCode = ok ? 0 : 1;
    log('单轮采集结束：' + (ok ? '成功' : '失败') + '，作品 ' + (meta ? meta.count : 0) +
      ' 条，退出码 ' + process.exitCode);
  });
}

if (ONCE_MODE) {
  runOnce();
} else {
  startServer();
}

function shutdown(signal) {
  log('收到 ' + signal + '，正在退出…');
  if (pollTimer) clearTimeout(pollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  sseClients.forEach(function (res) { try { res.end(); } catch (e) { /* ignore */ } });
  try { store.close(); } catch (e) { /* ignore */ }
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('uncaughtException', function (err) { log('未捕获异常：' + (err && err.stack || err)); });
process.on('unhandledRejection', function (err) { log('未处理的 Promise 拒绝：' + err); });
