'use strict';
/* 存储层：优先用 Node 内置 sqlite，没有就回退到 JSON 文件存储。
   两种后端对外暴露同一套接口，server.js 无需关心底层。 */

var fs = require('node:fs');
var path = require('node:path');

var METRIC_KEYS = ['views', 'likes', 'comments', 'shares', 'collects', 'follows'];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function metricsChanged(a, b) {
  for (var i = 0; i < METRIC_KEYS.length; i++) {
    if (Number(a[METRIC_KEYS[i]] || 0) !== Number(b[METRIC_KEYS[i]] || 0)) return true;
  }
  return false;
}

/* ---------------- SQLite 后端 ---------------- */
function openSqlite(file) {
  var sqlite = require('node:sqlite');
  var db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec([
    'CREATE TABLE IF NOT EXISTS works (',
    '  id TEXT PRIMARY KEY,',
    '  platform TEXT NOT NULL,',
    '  account TEXT,',
    '  author_id TEXT,',
    '  title TEXT,',
    '  tags TEXT,',
    '  ts INTEGER NOT NULL,',
    '  date_key TEXT NOT NULL,',
    '  hour INTEGER NOT NULL,',
    '  minute INTEGER NOT NULL,',
    '  views INTEGER DEFAULT 0,',
    '  likes INTEGER DEFAULT 0,',
    '  comments INTEGER DEFAULT 0,',
    '  shares INTEGER DEFAULT 0,',
    '  collects INTEGER DEFAULT 0,',
    '  follows INTEGER DEFAULT 0,',
    '  first_seen INTEGER,',
    '  updated_at INTEGER',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_works_date ON works(date_key);',
    'CREATE INDEX IF NOT EXISTS idx_works_platform ON works(platform, date_key);',
    'CREATE TABLE IF NOT EXISTS polls (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  ts INTEGER, ok INTEGER, adapter TEXT, fetched INTEGER, upserted INTEGER, message TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS trend_snapshots (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  platform TEXT NOT NULL,',
    '  list_key TEXT NOT NULL,',
    '  captured_at INTEGER NOT NULL,',
    '  rank INTEGER,',
    '  title TEXT NOT NULL,',
    '  hot_value INTEGER,',
    '  url TEXT',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_trends_lookup ON trend_snapshots(platform, captured_at);',
    'CREATE INDEX IF NOT EXISTS idx_trends_title ON trend_snapshots(platform, title);'
  ].join('\n'));
  // 老库补列（升级时不用重建数据库）
  var cols = db.prepare('PRAGMA table_info(works)').all().map(function (c) { return c.name; });
  if (cols.indexOf('author_id') < 0) db.exec('ALTER TABLE works ADD COLUMN author_id TEXT');

  var selectOne = db.prepare('SELECT * FROM works WHERE id = ?');
  var insert = db.prepare([
    'INSERT INTO works (id, platform, account, author_id, title, tags, ts, date_key, hour, minute,',
    '  views, likes, comments, shares, collects, follows, first_seen, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join(' '));
  var update = db.prepare([
    'UPDATE works SET account = ?, author_id = ?, title = ?, tags = ?, views = ?, likes = ?, comments = ?,',
    '  shares = ?, collects = ?, follows = ?, updated_at = ? WHERE id = ?'
  ].join(' '));
  var logStmt = db.prepare('INSERT INTO polls (ts, ok, adapter, fetched, upserted, message) VALUES (?, ?, ?, ?, ?, ?)');
  var statStmt = db.prepare('SELECT COUNT(*) AS n, MIN(date_key) AS minDay, MAX(date_key) AS maxDay FROM works');
  var dayStmt = db.prepare('SELECT COUNT(*) AS n, SUM(views) AS views FROM works WHERE date_key = ?');

  return {
    kind: 'sqlite',
    upsertWorks: function (rows, now) {
      var inserted = 0, updated = 0, changed = [];
      db.exec('BEGIN');
      try {
        rows.forEach(function (w) {
          var prev = selectOne.get(w.id);
          var tags = JSON.stringify(w.tags || []);
          if (!prev) {
            insert.run(w.id, w.platform, w.account, w.authorId || '', w.title, tags, w.ts, w.dateKey,
              w.hour, w.minute, w.views, w.likes, w.comments, w.shares, w.collects, w.follows, now, now);
            inserted++;
            changed.push(w);
          } else {
            var prevObj = {
              views: prev.views, likes: prev.likes, comments: prev.comments,
              shares: prev.shares, collects: prev.collects, follows: prev.follows
            };
            if (metricsChanged(w, prevObj) || prev.title !== w.title || prev.account !== w.account ||
                (prev.author_id || '') !== (w.authorId || '')) {
              update.run(w.account, w.authorId || '', w.title, tags, w.views, w.likes, w.comments,
                w.shares, w.collects, w.follows, now, w.id);
              updated++;
              changed.push(w);
            }
          }
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { inserted: inserted, updated: updated, changed: changed };
    },
    queryRange: function (fromKey, toKey, platforms) {
      var sql = 'SELECT * FROM works WHERE date_key >= ? AND date_key <= ?';
      var args = [fromKey, toKey];
      if (platforms && platforms.length) {
        sql += ' AND platform IN (' + platforms.map(function () { return '?'; }).join(',') + ')';
        args = args.concat(platforms);
      }
      sql += ' ORDER BY ts ASC';
      var stmt = db.prepare(sql);
      return stmt.all.apply(stmt, args).map(function (r) {
        var tags = [];
        try { tags = JSON.parse(r.tags || '[]'); } catch (e) { tags = []; }
        return {
          id: r.id, platform: r.platform, account: r.account, authorId: r.author_id || '',
          title: r.title, tags: tags,
          ts: r.ts, dateKey: r.date_key, hour: r.hour, minute: r.minute,
          views: r.views, likes: r.likes, comments: r.comments,
          shares: r.shares, collects: r.collects, follows: r.follows
        };
      });
    },
    logPoll: function (rec) {
      logStmt.run(rec.ts, rec.ok ? 1 : 0, rec.adapter || '', rec.fetched || 0, rec.upserted || 0, rec.message || '');
    },
    recentPolls: function (limit) {
      return db.prepare('SELECT * FROM polls ORDER BY id DESC LIMIT ?').all(limit || 20);
    },
    stats: function () {
      var s = statStmt.get();
      return { works: Number(s.n || 0), minDay: s.minDay || null, maxDay: s.maxDay || null };
    },
    dayStats: function (key) {
      var s = dayStmt.get(key);
      return { works: Number(s.n || 0), views: Number(s.views || 0) };
    },
    insertTrends: function (rows, capturedAt) {
      var stmt = db.prepare('INSERT INTO trend_snapshots (platform, list_key, captured_at, rank, title, hot_value, url) VALUES (?, ?, ?, ?, ?, ?, ?)');
      var n = 0;
      db.exec('BEGIN');
      try {
        rows.forEach(function (r) {
          stmt.run(r.platform, r.listKey, capturedAt, r.rank, r.title, r.hot, r.url || '');
          n++;
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return n;
    },
    trendPlatforms: function () {
      var groups = db.prepare('SELECT platform, list_key, MAX(captured_at) AS captured_at FROM trend_snapshots GROUP BY platform, list_key').all();
      var cnt = db.prepare('SELECT COUNT(*) AS n FROM trend_snapshots WHERE platform = ? AND captured_at = ?');
      return groups.map(function (g) {
        var c = cnt.get(g.platform, g.captured_at);
        return {
          platform: g.platform, listKey: g.list_key,
          capturedAt: g.captured_at, count: Number(c.n || 0)
        };
      }).sort(function (a, b) { return b.capturedAt - a.capturedAt; });
    },
    trendSnapshot: function (platform, offset) {
      var at = db.prepare('SELECT DISTINCT captured_at FROM trend_snapshots WHERE platform = ? ORDER BY captured_at DESC LIMIT 1 OFFSET ?')
        .get(platform, offset || 0);
      if (!at) return null;
      var items = db.prepare('SELECT rank, title, hot_value, url FROM trend_snapshots WHERE platform = ? AND captured_at = ? ORDER BY rank ASC')
        .all(platform, at.captured_at);
      return {
        platform: platform,
        capturedAt: at.captured_at,
        items: items.map(function (r) { return { rank: r.rank, title: r.title, hot: r.hot_value, url: r.url }; })
      };
    },
    trendHistory: function (platform, sinceTs) {
      return db.prepare('SELECT title, MIN(captured_at) AS first_seen, MIN(rank) AS best_rank, MAX(hot_value) AS peak_hot, COUNT(*) AS seen ' +
        'FROM trend_snapshots WHERE platform = ? AND captured_at >= ? GROUP BY title').all(platform, sinceTs)
        .map(function (r) {
          return { title: r.title, firstSeen: r.first_seen, bestRank: r.best_rank, peakHot: r.peak_hot, seen: r.seen };
        });
    },
    pruneTrends: function (beforeTs) {
      var info = db.prepare('DELETE FROM trend_snapshots WHERE captured_at < ?').run(beforeTs);
      return info && info.changes ? info.changes : 0;
    },
    clearAll: function () {
      db.exec('DELETE FROM works');
      db.exec('DELETE FROM polls');
      db.exec('DELETE FROM trend_snapshots');
      return true;
    },
    close: function () { try { db.close(); } catch (e) { /* ignore */ } }
  };
}

/* ---------------- JSON 文件后端（Node 版本较旧时的兜底） ---------------- */
function openJson(dir) {
  var worksFile = path.join(dir, 'works.json');
  var pollsFile = path.join(dir, 'polls.json');
  var trendsFile = path.join(dir, 'trends.json');
  var map = new Map();
  var polls = [];
  var trends = [];
  var dirty = false;
  var timer = null;

  if (fs.existsSync(worksFile)) {
    try {
      JSON.parse(fs.readFileSync(worksFile, 'utf8')).forEach(function (w) { map.set(w.id, w); });
    } catch (e) { /* 文件损坏则从空开始 */ }
  }
  if (fs.existsSync(pollsFile)) {
    try { polls = JSON.parse(fs.readFileSync(pollsFile, 'utf8')) || []; } catch (e) { polls = []; }
  }
  if (fs.existsSync(trendsFile)) {
    try { trends = JSON.parse(fs.readFileSync(trendsFile, 'utf8')) || []; } catch (e) { trends = []; }
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    var tmp = worksFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Array.from(map.values())), 'utf8');
    fs.renameSync(tmp, worksFile);
    fs.writeFileSync(pollsFile + '.tmp', JSON.stringify(polls.slice(-500)), 'utf8');
    fs.renameSync(pollsFile + '.tmp', pollsFile);
    fs.writeFileSync(trendsFile + '.tmp', JSON.stringify(trends.slice(-2000)), 'utf8');
    fs.renameSync(trendsFile + '.tmp', trendsFile);
  }
  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(function () { timer = null; flush(); }, 1500);
    if (timer.unref) timer.unref();
  }

  return {
    kind: 'json',
    upsertWorks: function (rows, now) {
      var inserted = 0, updated = 0, changed = [];
      rows.forEach(function (w) {
        var prev = map.get(w.id);
        if (!prev) {
          var fresh = Object.assign({ firstSeen: now, updatedAt: now }, w);
          map.set(w.id, fresh);
          inserted++;
          changed.push(fresh);
        } else if (metricsChanged(w, prev) || prev.title !== w.title) {
          var merged = Object.assign({}, prev, w, { firstSeen: prev.firstSeen, updatedAt: now });
          map.set(w.id, merged);
          updated++;
          changed.push(merged);
        }
      });
      if (inserted || updated) schedule();
      return { inserted: inserted, updated: updated, changed: changed };
    },
    queryRange: function (fromKey, toKey, platforms) {
      var set = platforms && platforms.length ? platforms.reduce(function (a, p) { a[p] = 1; return a; }, {}) : null;
      return Array.from(map.values())
        .filter(function (w) {
          return w.dateKey >= fromKey && w.dateKey <= toKey && (!set || set[w.platform]);
        })
        .sort(function (a, b) { return a.ts - b.ts; });
    },
    logPoll: function (rec) {
      polls.push(rec);
      if (polls.length > 500) polls = polls.slice(-500);
      schedule();
    },
    recentPolls: function (limit) { return polls.slice(-(limit || 20)).reverse(); },
    stats: function () {
      var keys = Array.from(map.keys());
      var days = {};
      map.forEach(function (w) { days[w.dateKey] = 1; });
      var list = Object.keys(days).sort();
      return { works: keys.length, minDay: list[0] || null, maxDay: list[list.length - 1] || null };
    },
    dayStats: function (key) {
      var n = 0, views = 0;
      map.forEach(function (w) { if (w.dateKey === key) { n++; views += w.views; } });
      return { works: n, views: views };
    },
    insertTrends: function (rows, capturedAt) {
      var byPlatform = {};
      rows.forEach(function (r) {
        var key = r.platform;
        var snap = byPlatform[key] || (byPlatform[key] = { platform: r.platform, listKey: r.listKey, capturedAt: capturedAt, items: [] });
        snap.items.push({ rank: r.rank, title: r.title, hot: r.hot, url: r.url || '' });
      });
      Object.keys(byPlatform).forEach(function (k) { trends.push(byPlatform[k]); });
      if (trends.length > 2000) trends = trends.slice(-2000);
      schedule();
      return rows.length;
    },
    trendPlatforms: function () {
      var latest = {};
      trends.forEach(function (s) {
        var cur = latest[s.platform];
        if (!cur || s.capturedAt > cur.capturedAt) latest[s.platform] = s;
      });
      return Object.keys(latest).map(function (k) {
        return { platform: k, listKey: latest[k].listKey, capturedAt: latest[k].capturedAt, count: latest[k].items.length };
      });
    },
    trendSnapshot: function (platform, offset) {
      var list = trends.filter(function (s) { return s.platform === platform; })
        .sort(function (a, b) { return b.capturedAt - a.capturedAt; });
      var snap = list[offset || 0];
      if (!snap) return null;
      return {
        platform: platform,
        capturedAt: snap.capturedAt,
        items: snap.items.slice().sort(function (a, b) { return a.rank - b.rank; })
      };
    },
    trendHistory: function (platform, sinceTs) {
      var agg = {};
      trends.forEach(function (s) {
        if (s.platform !== platform || s.capturedAt < sinceTs) return;
        s.items.forEach(function (it) {
          var o = agg[it.title] || (agg[it.title] = { title: it.title, firstSeen: s.capturedAt, bestRank: it.rank, peakHot: it.hot, seen: 0 });
          o.firstSeen = Math.min(o.firstSeen, s.capturedAt);
          o.bestRank = Math.min(o.bestRank, it.rank);
          o.peakHot = Math.max(o.peakHot || 0, it.hot || 0);
          o.seen++;
        });
      });
      return Object.keys(agg).map(function (k) { return agg[k]; });
    },
    pruneTrends: function (beforeTs) {
      var before = trends.length;
      trends = trends.filter(function (s) { return s.capturedAt >= beforeTs; });
      if (trends.length !== before) schedule();
      return before - trends.length;
    },
    clearAll: function () {
      map.clear();
      polls = [];
      trends = [];
      dirty = true;
      flush();
      return true;
    },
    close: function () { if (timer) clearTimeout(timer); flush(); }
  };
}

function openStore(dir) {
  ensureDir(dir);
  try {
    return openSqlite(path.join(dir, 'monitor.db'));
  } catch (err) {
    process.stderr.write('[store] sqlite 不可用（' + err.message + '），回退到 JSON 文件存储\n');
    return openJson(dir);
  }
}

module.exports = { openStore: openStore, METRIC_KEYS: METRIC_KEYS };
