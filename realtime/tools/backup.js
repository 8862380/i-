'use strict';
/* 备份已采集数据。
   用法： node tools/backup.js [保留份数，默认 14]
   数据目录同服务端：默认 realtime/data，可用环境变量 DATA_DIR 指定。
   SQLite 用 VACUUM INTO 做一致性快照，服务在跑的时候也能备份。
*/

var fs = require('node:fs');
var path = require('node:path');

var DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
var KEEP = Math.max(1, Number(process.argv[2] || 14));
var BACKUP_DIR = path.join(DATA_DIR, 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function stamp() {
  var d = new Date();
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function prune() {
  var files = fs.readdirSync(BACKUP_DIR).filter(function (f) { return /^(monitor-|works-)/.test(f); }).sort();
  while (files.length > KEEP) {
    var victim = path.join(BACKUP_DIR, files.shift());
    try { fs.unlinkSync(victim); } catch (err) { /* ignore */ }
  }
}

var dbFile = path.join(DATA_DIR, 'monitor.db');
if (fs.existsSync(dbFile)) {
  var target = path.join(BACKUP_DIR, 'monitor-' + stamp() + '.db');
  var sqlite = require('node:sqlite');
  var db = new sqlite.DatabaseSync(dbFile);
  db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
  var rows = db.prepare('SELECT COUNT(*) AS n FROM works').get().n;
  db.close();
  prune();
  process.stdout.write('已备份 ' + rows + ' 条作品 → ' + target + '\n');
} else {
  var src = path.join(DATA_DIR, 'works.json');
  if (!fs.existsSync(src)) {
    process.stderr.write('没有找到 monitor.db 或 works.json（数据目录：' + DATA_DIR + '）\n');
    process.exit(1);
  }
  var dest = path.join(BACKUP_DIR, 'works-' + stamp() + '.json');
  fs.copyFileSync(src, dest);
  prune();
  process.stdout.write('已备份 → ' + dest + '\n');
}
