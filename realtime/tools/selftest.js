'use strict';
/* 自检数据源：模拟一个「每次请求数据都在变」的上游接口，用来验证整条链路。
   注意：这是联调用的假数据源，不是平台真实数据。
   用法： node tools/selftest.js  [端口，默认 8899]
   然后把 config.json 换成 config.selftest.json 的内容，或直接设：
     adapter=http  url=http://127.0.0.1:8899/api/works?date={date}&page={page}  itemsPath=data.list
*/

var http = require('node:http');
var path = require('node:path');
var normalize = require(path.join(__dirname, '..', 'lib', 'normalize.js'));

var PORT = Number(process.argv[2] || 8899);
var ACCOUNTS = [
  ['元气小食堂', 'douyin', '美食'], ['好物严选', 'douyin', '穿搭'], ['南风测评', 'douyin', '数码'],
  ['甜味厨房', 'kuaishou', '美食'], ['球场老王', 'kuaishou', '健身'], ['职场小满', 'kuaishou', '职场'],
  ['一只柠檬', 'xhs', '美妆'], ['住小帮', 'xhs', '家居'], ['山野计划', 'xhs', '旅行'],
  ['英语角Kiki', 'shipinhao', '教育'], ['糖糖妈', 'shipinhao', '母婴'],
  ['码农小林', 'bilibili', '编程'], ['游戏解说阿凯', 'bilibili', '游戏']
];
var TITLES = ['快手早餐｜10秒学会', '通勤穿搭｜完整版', '数码测评｜对比测评', '家庭烘焙｜实测30天',
  '健身新手计划｜附清单', '职场沟通｜别踩这3个坑', '护肤成分｜保姆级教程', '小户型收纳｜附清单',
  '旅行攻略｜完整版', '英语口语｜第3期', '带娃日常｜新手必看', '零基础编程｜完整版', '游戏上分｜实测30天'];

var works = [];
var seq = 0;

function pad2(n) { return String(n).padStart(2, '0'); }
function todayKey() { return normalize.dateKey(new Date()); }
function nowTime() {
  var d = new Date();
  return todayKey() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// 初始化：今天已发布的一批作品
for (var i = 0; i < ACCOUNTS.length; i++) {
  var h = 7 + Math.floor(Math.random() * 12);
  works.push({
    work_id: 'st-' + (++seq),
    platform: ACCOUNTS[i][1],
    account: ACCOUNTS[i][0],
    title: TITLES[i],
    tags: [ACCOUNTS[i][2]],
    publish_time: todayKey() + ' ' + pad2(h) + ':' + pad2(Math.floor(Math.random() * 60)) + ':00',
    views: 5000 + Math.floor(Math.random() * 400000),
    likes: 200 + Math.floor(Math.random() * 30000),
    comments: 10 + Math.floor(Math.random() * 1500),
    shares: 5 + Math.floor(Math.random() * 900),
    collects: 10 + Math.floor(Math.random() * 3000),
    follows: 5 + Math.floor(Math.random() * 600)
  });
}

function evolve() {
  // 老作品数据继续涨
  works.forEach(function (w) {
    if (Math.random() < 0.75) {
      var add = Math.floor(Math.random() * Math.max(50, w.views * 0.05));
      w.views += add;
      w.likes += Math.floor(add * (0.03 + Math.random() * 0.08));
      w.comments += Math.floor(add * 0.004);
      w.shares += Math.floor(add * 0.003);
      w.collects += Math.floor(add * 0.006);
      w.follows += Math.floor(add * 0.002);
    }
  });
  // 随机有新作品发布
  if (Math.random() < 0.55) {
    var a = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];
    works.push({
      work_id: 'st-' + (++seq),
      platform: a[1],
      account: a[0],
      title: TITLES[Math.floor(Math.random() * TITLES.length)],
      tags: [a[2]],
      publish_time: nowTime(),
      views: 200 + Math.floor(Math.random() * 3000),
      likes: 10 + Math.floor(Math.random() * 300),
      comments: Math.floor(Math.random() * 30),
      shares: Math.floor(Math.random() * 20),
      collects: Math.floor(Math.random() * 40),
      follows: Math.floor(Math.random() * 25)
    });
  }
}

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (url.pathname !== '/api/works') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  evolve();
  var date = url.searchParams.get('date') || todayKey();
  var page = Number(url.searchParams.get('page') || 1);
  var size = Number(url.searchParams.get('size') || 10);
  var list = works.filter(function (w) { return String(w.publish_time).slice(0, 10) === date; });
  var slice = list.slice((page - 1) * size, page * size);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    code: 0,
    data: { total: list.length, page: page, size: size, list: slice }
  }, null, 0));
  process.stdout.write('[selftest] 第 ' + page + ' 页返回 ' + slice.length + ' 条（当日共 ' + list.length + ' 条，累计 ' + works.length + ' 条）\n');
});

server.listen(PORT, function () {
  process.stdout.write('[selftest] 自检数据源已启动： http://127.0.0.1:' + PORT + '/api/works?date=' + todayKey() + '&page=1\n');
  process.stdout.write('[selftest] 这是联调用的假数据源，不是平台真实数据。确认链路通了以后请换成真实数据源。\n');
});
