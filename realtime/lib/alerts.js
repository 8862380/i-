'use strict';
/* 服务端预警计算：与看板同一套口径，供 24 小时值守推送使用 */

function median(arr) {
  if (!arr.length) return 0;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}
function fmtPct(x) { return ((Number(x) || 0) * 100).toFixed(2) + '%'; }
function pad2(n) { return String(n).padStart(2, '0'); }

var PLATFORM_NAME = {
  douyin: '抖音', kuaishou: '快手', xhs: '小红书', shipinhao: '视频号', bilibili: 'B站'
};
function pname(id) { return PLATFORM_NAME[id] || id; }

function groupPlatform(rows) {
  var per = {};
  rows.forEach(function (w) {
    var p = per[w.platform] || (per[w.platform] = {
      name: pname(w.platform), works: 0, views: 0, likes: 0, comments: 0, shares: 0, collects: 0,
      hours: new Array(24).fill(0), viewList: []
    });
    p.works++; p.views += w.views; p.likes += w.likes; p.comments += w.comments;
    p.shares += w.shares; p.collects += w.collects;
    p.hours[w.hour]++;
    p.viewList.push(w.views);
  });
  Object.keys(per).forEach(function (k) {
    var p = per[k];
    p.engagement = p.views ? (p.likes + p.comments + p.shares + p.collects) / p.views : 0;
    p.medianViews = median(p.viewList);
  });
  return per;
}

function computeAlerts(todayRows, yesterdayRows, options) {
  var opt = options || {};
  var dropRate = opt.dropRate == null ? 0.3 : opt.dropRate;
  var spikeRate = opt.spikeRate == null ? 0.6 : opt.spikeRate;
  var baseMin = opt.baselineMin == null ? 10 : opt.baselineMin;
  var viralTimes = opt.viralTimes == null ? 20 : opt.viralTimes;
  var engChange = opt.engagementChange == null ? 0.25 : opt.engagementChange;
  var lowShare = opt.lowEffShare == null ? 0.35 : opt.lowEffShare;
  var out = [];
  var today = groupPlatform(todayRows);
  var yest = groupPlatform(yesterdayRows || []);
  // 只比较"今天已经走完的小时"，否则会拿还没到的时段跟昨天比，产生 -100% 之类的假预警
  var nowHour = opt.nowHour == null ? new Date().getHours() : Number(opt.nowHour);
  Object.keys(today).forEach(function (pid) {
    var c = today[pid], y = yest[pid];
    if (y) {
      for (var h = 0; h <= 23; h++) {
        if (h > nowHour - 1) break;
        var base = y.hours[h];
        if (base < baseMin) continue;
        var rate = c.hours[h] / base - 1;
        if (rate <= -dropRate) {
          out.push({
            key: 'drop:' + pid + ':' + h,
            level: 'warn',
            title: c.name + ' ' + pad2(h) + ':00 发布量下滑',
            text: '今日 ' + c.hours[h] + ' 条，昨日同期 ' + base + ' 条（' + Math.round(rate * 100) + '%），可能被限流或发布中断。'
          });
        } else if (rate >= spikeRate) {
          out.push({
            key: 'spike:' + pid + ':' + h,
            level: 'ok',
            title: c.name + ' ' + pad2(h) + ':00 发布量激增',
            text: '今日 ' + c.hours[h] + ' 条，昨日同期 ' + base + ' 条（+' + Math.round(rate * 100) + '%），注意承接流量。'
          });
        }
      }
      if (y.engagement > 0) {
        var d = c.engagement / y.engagement - 1;
        if (Math.abs(d) >= engChange) {
          out.push({
            key: 'eng:' + pid,
            level: d < 0 ? 'warn' : 'ok',
            title: c.name + ' 平均互动率' + (d < 0 ? '下降 ' : '提升 ') + Math.abs(Math.round(d * 100)) + '%',
            text: '昨日 ' + fmtPct(y.engagement) + ' → 今日 ' + fmtPct(c.engagement) + '，当日 ' + c.works + ' 条作品。'
          });
        }
      }
    }
    todayRows.filter(function (w) { return w.platform === pid; }).forEach(function (w) {
      if (c.medianViews > 0 && w.views >= c.medianViews * viralTimes) {
        out.push({
          key: 'viral:' + w.id,
          level: 'hot',
          title: '爆款作品 · ' + c.name,
          text: '《' + w.title + '》（@' + w.account + '）播放 ' + fmtNum(w.views) +
            '，为平台中位数的 ' + Math.round(w.views / c.medianViews) + ' 倍。'
        });
      }
    });
    if (c.works >= 20) {
      var zero = todayRows.filter(function (w) { return w.platform === pid && w.views < 500; }).length;
      if (zero / c.works >= lowShare) {
        out.push({
          key: 'low:' + pid,
          level: 'warn',
          title: c.name + ' ' + Math.round(zero / c.works * 100) + '% 作品播放不足 500',
          text: zero + ' / ' + c.works + ' 条未起量，建议收敛选题方向。'
        });
      }
    }
  });
  return out;
}

module.exports = { computeAlerts: computeAlerts, groupPlatform: groupPlatform };
