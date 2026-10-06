'use strict';
/* 清空已采集的数据（切到真实数据源之前建议执行一次，避免测试数据混入）。
   用法：
     node tools/reset-data.js --yes      清空
     node tools/reset-data.js            只提示，不执行
   数据目录同服务端：默认 realtime/data，可用环境变量 DATA_DIR 指定。
*/

var path = require('node:path');
var storeLib = require(path.join(__dirname, '..', 'lib', 'store.js'));

var DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

var store = storeLib.openStore(DATA_DIR);
var before = store.stats();

if (process.argv.indexOf('--yes') < 0) {
  process.stdout.write('当前数据目录：' + DATA_DIR + '\n');
  process.stdout.write('现有作品 ' + before.works + ' 条（' + (before.minDay || '—') + ' ~ ' + (before.maxDay || '—') + '）\n');
  process.stdout.write('这会清空所有已采集数据与采集日志，确认请加 --yes 重新执行：\n');
  process.stdout.write('  node tools/reset-data.js --yes\n');
  store.close();
  process.exit(0);
}

store.clearAll();
var after = store.stats();
store.close();
process.stdout.write('已清空：' + before.works + ' → ' + after.works + ' 条作品（数据目录：' + DATA_DIR + '）\n');
