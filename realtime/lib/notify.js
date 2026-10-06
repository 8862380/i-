'use strict';
/* 告警推送：企业微信 / 钉钉 / 飞书 机器人，或任意 webhook */

function buildPayload(format, text) {
  switch (String(format || 'wecom').toLowerCase()) {
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    case 'feishu':
    case 'lark':
      return { msg_type: 'text', content: { text: text } };
    case 'generic':
      return { text: text };
    case 'wecom':
    default:
      return { msgtype: 'text', text: { content: text } };
  }
}

function createNotifier(config) {
  var cfg = config || {};
  var cooldown = new Map();
  var lastSentAt = 0;
  var enabled = !!(cfg.enabled && cfg.webhook);

  async function send(text) {
    var res = await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(cfg.format, text))
    });
    if (!res.ok) throw new Error('webhook 返回 ' + res.status);
    return true;
  }

  return {
    enabled: enabled,
    /* 返回本次真正推送出去的告警 */
    push: async function (alerts, context) {
      if (!enabled || !alerts || !alerts.length) return [];
      var now = Date.now();
      var minInterval = Math.max(0, Number(cfg.minIntervalSeconds || 600)) * 1000;
      var cooldownMs = Math.max(60, Number(cfg.cooldownSeconds || 3600)) * 1000;
      var fresh = alerts.filter(function (a) {
        if (a.level !== 'warn') return false;
        var last = cooldown.get(a.key) || 0;
        return now - last > cooldownMs;
      });
      if (!fresh.length) return [];
      if (now - lastSentAt < minInterval) return [];
      var lines = fresh.slice(0, 6).map(function (a) {
        return '· ' + a.title + '\n  ' + a.text;
      });
      var text = '【内容数据监控告警】' + (context && context.date ? ' ' + context.date : '') + '\n' +
        lines.join('\n') + (context && context.url ? '\n看板：' + context.url : '');
      await send(text);
      lastSentAt = now;
      fresh.forEach(function (a) { cooldown.set(a.key, now); });
      return fresh;
    },
    status: function () {
      return { enabled: enabled, format: cfg.format || 'wecom', lastSentAt: lastSentAt, tracked: cooldown.size };
    }
  };
}

module.exports = { createNotifier: createNotifier, buildPayload: buildPayload };
