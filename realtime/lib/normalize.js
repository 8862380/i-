'use strict';
/* 字段归一化：把各平台上来的原始数据统一成内部作品结构 */

var NAME2ID = {
  '抖音': 'douyin', 'douyin': 'douyin', 'dy': 'douyin',
  '快手': 'kuaishou', 'kuaishou': 'kuaishou', 'ks': 'kuaishou',
  '小红书': 'xhs', 'xhs': 'xhs', 'xiaohongshu': 'xhs', 'rednote': 'xhs',
  '视频号': 'shipinhao', 'shipinhao': 'shipinhao', '微信视频号': 'shipinhao',
  'b站': 'bilibili', 'bilibili': 'bilibili', '哔哩哔哩': 'bilibili'
};

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function keyOf(ts) { return dateKey(new Date(ts)); }
function shiftKey(key, days) {
  var a = String(key).split('-');
  var d = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function toNumber(v) {
  if (v == null || v === '') return 0;
  var s = String(v).replace(/[,%\s]/g, '').trim();
  var multi = 1;
  if (/万$/.test(s)) { multi = 1e4; s = s.replace(/万$/, ''); }
  else if (/亿$/.test(s)) { multi = 1e8; s = s.replace(/亿$/, ''); }
  else if (/[kK]$/.test(s)) { multi = 1e3; s = s.replace(/[kK]$/, ''); }
  var n = Number(s);
  return isFinite(n) ? n * multi : 0;
}

function pick(obj, names) {
  for (var i = 0; i < names.length; i++) {
    if (obj[names[i]] != null && obj[names[i]] !== '') return obj[names[i]];
  }
  return null;
}

function parseTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if (/^\d{13}$/.test(s)) { var a = new Date(Number(s)); return isNaN(a.getTime()) ? null : a; }
  if (/^\d{10}$/.test(s)) { var b = new Date(Number(s) * 1000); return isNaN(b.getTime()) ? null : b; }
  var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/);
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  return isNaN(d.getTime()) ? null : d;
}

var PLATFORM_ALIAS = {
  platform: ['platform', '平台', '平台名称', '渠道', 'site', 'source'],
  account: ['account', 'author', 'nickname', '账号', '作者', '达人', 'uname', 'nick_name'],
  authorId: ['author_id', 'mid', 'uid', 'authorId', '达人id', '账号id'],
  title: ['title', 'desc', 'content', '标题', '文案', '作品标题', 'text'],
  tags: ['tags', 'tag', '标签', '话题', 'topic', 'topics'],
  time: ['publish_time', 'publishTime', 'create_time', 'created_at', 'time', 'ts', '发布时间', '发布日期', 'date', 'pub_time'],
  id: ['work_id', 'item_id', 'id', 'aweme_id', 'note_id', '作品id', '作品ID'],
  views: ['views', 'view', 'play', 'play_count', 'playCount', '播放量', '播放', 'view_count', 'vv'],
  likes: ['likes', 'like', 'like_count', 'digg_count', '点赞', '点赞量', 'praise_count'],
  comments: ['comments', 'comment', 'comment_count', '评论', '评论量'],
  shares: ['shares', 'share', 'share_count', '分享', '分享量', 'forward_count'],
  collects: ['collects', 'collect', 'favorites', 'fav', 'collect_count', '收藏', '收藏量'],
  follows: ['follows', 'fans', 'fans_add', 'follower_gain', '涨粉', '新增粉丝', 'followers_add']
};

function normalizeRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var rawP = String(pick(raw, PLATFORM_ALIAS.platform) || '').trim().toLowerCase();
  var pid = NAME2ID[rawP] || NAME2ID[rawP.replace(/\s/g, '')];
  if (!pid) return null;
  var dt = parseTime(pick(raw, PLATFORM_ALIAS.time));
  if (!dt) return null;
  var tagsRaw = pick(raw, PLATFORM_ALIAS.tags);
  var tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(String)
    : String(tagsRaw == null ? '' : tagsRaw).split(/[,\s|、/#]+/).filter(Boolean);
  var rawId = pick(raw, PLATFORM_ALIAS.id);
  var idStr = rawId == null || rawId === '' ? String(dt.getTime()) : String(rawId);
  return {
    id: idStr.indexOf(pid + ':') === 0 ? idStr : pid + ':' + idStr,
    platform: pid,
    account: String(pick(raw, PLATFORM_ALIAS.account) || '未标注账号'),
    authorId: String(pick(raw, PLATFORM_ALIAS.authorId) || ''),
    title: String(pick(raw, PLATFORM_ALIAS.title) || '(无标题)'),
    tags: tags.slice(0, 6),
    ts: dt.getTime(),
    hour: dt.getHours(),
    minute: dt.getMinutes(),
    dateKey: dateKey(dt),
    views: toNumber(pick(raw, PLATFORM_ALIAS.views)),
    likes: toNumber(pick(raw, PLATFORM_ALIAS.likes)),
    comments: toNumber(pick(raw, PLATFORM_ALIAS.comments)),
    shares: toNumber(pick(raw, PLATFORM_ALIAS.shares)),
    collects: toNumber(pick(raw, PLATFORM_ALIAS.collects)),
    follows: toNumber(pick(raw, PLATFORM_ALIAS.follows))
  };
}

function parseCsv(text) {
  var rows = [], cur = [], field = '', i = 0, inQ = false, ch;
  text = String(text).replace(/^\uFEFF/, '');
  while (i < text.length) {
    ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { cur.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  if (!rows.length) return [];
  var head = rows.shift().map(function (h) { return h.trim(); });
  return rows.map(function (r) {
    var o = {};
    head.forEach(function (h, idx) { o[h] = r[idx] == null ? '' : r[idx]; });
    return o;
  });
}

function parseAny(text) {
  var t = String(text).trim();
  if (!t) return [];
  if (t[0] === '[' || t[0] === '{') {
    var json = JSON.parse(t);
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.works)) return json.works;
    if (json && Array.isArray(json.data)) return json.data;
    if (json && json.data && Array.isArray(json.data.list)) return json.data.list;
    if (json && json.data && Array.isArray(json.data.items)) return json.data.items;
    throw new Error('JSON 结构不支持：请提供数组，或 { works: [...] } / { data: { list: [...] } }');
  }
  return parseCsv(text);
}

module.exports = {
  NAME2ID: NAME2ID,
  PLATFORM_ALIAS: PLATFORM_ALIAS,
  pad2: pad2,
  dateKey: dateKey,
  keyOf: keyOf,
  shiftKey: shiftKey,
  toNumber: toNumber,
  pick: pick,
  parseTime: parseTime,
  normalizeRaw: normalizeRaw,
  parseCsv: parseCsv,
  parseAny: parseAny
};
