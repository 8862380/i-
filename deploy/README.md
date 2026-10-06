# 部署上线指南

## 先选方案

| 你的场景 | 推荐方案 | 说明 |
| --- | --- | --- |
| 只在公司内网 / 自己电脑看 | Windows 计划任务 + 内网 IP | 最简单，10 分钟搞定 |
| 要给同事、客户用，有域名 | Linux VPS + Docker + Nginx 或 Caddy | 推荐，稳定、能自动重启、HTTPS |
| 已有服务器在跑别的服务 | Linux + systemd + Nginx | 与现有服务共存，改动最小 |
| 不想管服务器 | 托管平台（Railway / Render / Fly.io） | 必须挂持久化磁盘，否则数据每次重启丢失 |

服务器配置要求很低：**1 核 2G、20G 磁盘、1~3Mbps 带宽**就足够（实时推送用的是长连接，几乎不占带宽）。国内机器用域名要备案；不想备案就用「IP + 端口」直连，或者用海外 VPS。

---

## 方案 A：Linux 云服务器 + Docker（推荐）

### 1. 准备机器

Ubuntu 22.04 / Debian 12 都可以，装好 Docker：

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

### 2. 上传项目

把整个 `media-monitor` 目录传到服务器，例如 `/opt/media-monitor`（可以用 `scp -r`、宝塔面板或者 git）。

### 3. 写配置

```bash
cd /opt/media-monitor
cp deploy/env.example deploy/.env
vim deploy/.env
```

必须改的三项：

```ini
ADAPTER=http
URL=https://服务商域名/api/works?date={date}&page={page}
AUTH_HEADER=Bearer 你的密钥
INGEST_TOKEN=一段随机长字符串          # 公网一定要设
DATA_DIR=/app/realtime/data           # Docker 里用这个路径
```

Docker 部署建议把 `HOST` 留在 `127.0.0.1`（compose 已经这么配），由 Nginx 对外，不要把 8787 直接暴露到公网。

### 4. 起服务

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml logs -f --tail=50   # 看日志
curl -s localhost:8787/api/status | head -c 300                      # 自检
```

`restart: unless-stopped` 保证服务器重启、进程崩溃后自动拉起。

### 5. 配域名和 HTTPS

域名 A 记录指向服务器 IP，然后二选一：

**Nginx（配 certbot 证书）**

```bash
apt install -y nginx certbot python3-certbot-nginx
cp deploy/nginx.conf /etc/nginx/conf.d/media-monitor.conf
sed -i 's/monitor.example.com/你的域名/g' /etc/nginx/conf.d/media-monitor.conf
certbot --nginx -d 你的域名
nginx -t && systemctl reload nginx
```

**Caddy（自动申请续期证书，更省事）**

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
sed -i 's/monitor.example.com/你的域名/g' /etc/caddy/Caddyfile
systemctl reload caddy
```

> 关键点：反向代理必须关闭响应缓冲（`proxy_buffering off;` / Caddy 的 `flush_interval -1`），否则 SSE 实时推送会被缓存住，页面就不实时刷新了。这两个配置文件里已经写好。

### 6. 备份

```bash
crontab -e
# 加入这一行：每天 3 点备份，保留 14 份
0 3 * * * docker exec media-monitor node /app/realtime/tools/backup.js 14 >> /var/log/media-monitor/backup.log 2>&1
```

---

## 方案 B：Linux + systemd（不用 Docker）

```bash
# 1. 装 Node 22+（node:sqlite 需要新版本；没有也能跑，会自动回退成 JSON 存储）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

# 2. 放代码 + 建运行用户
mkdir -p /opt/media-monitor && cd /opt/media-monitor        # 把项目文件放进来
useradd -r -s /usr/sbin/nologin media || true
mkdir -p /var/log/media-monitor
chown -R media:media /opt/media-monitor /var/log/media-monitor

# 3. 配置
cp deploy/env.example deploy/.env && vim deploy/.env

# 4. 装服务
cp deploy/media-monitor.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now media-monitor
systemctl status media-monitor --no-pager
journalctl -u media-monitor -f          # 看日志
```

后面接 Nginx / Caddy 的步骤和方案 A 的第 5 步完全一样。

---

## 方案 C：Windows（自己的电脑或内网服务器）

适合「先跑起来、只看内网」：

```bat
cd C:\path\to\media-monitor
realtime\start.bat                       :: 前台常驻，自带崩溃重启
powershell -File realtime\install-autostart.ps1   :: 开机自启 + 崩溃每分钟重启
```

让别人也能访问：

1. `realtime\config.json` 或环境变量里设 `HOST=0.0.0.0`
2. 放行防火墙端口：
   ```powershell
   netsh advfirewall firewall add rule name="MediaMonitor" dir=in action=allow protocol=TCP localport=8787
   ```
3. 同事访问 `http://你的内网IP:8787/`（`ipconfig` 查看 IP）

要暴露到公网又不想碰路由器，推荐内网穿透：

- Cloudflare Tunnel：`cloudflared tunnel --url http://localhost:8787`（免费、自动 HTTPS）
- frp / nps：有自己的服务器时用

---

## 托管平台（Railway / Render / Fly.io）

可以跑，但有两个硬要求：

1. **必须挂持久化磁盘**，把 `/app/realtime/data` 挂上去，否则每次重新部署数据全丢
2. 平台必须支持 SSE 长连接（多数默认支持，Railway/Render 需要把请求超时调大）

用现成的 `Dockerfile` 直接构建即可，环境变量按 `deploy/env.example` 填。

---

## 上线检查清单

部署完照着过一遍，八项都过就算上线成功：

- [ ] 域名（或 IP:端口）能打开页面，浏览器地址栏是 https 或局域网地址
- [ ] `curl -s 域名/api/status` 里 `adapter` 是你配置的数据源，`store` 是 sqlite
- [ ] 页面右下角「采集状态」显示 **正常**，下次采集倒计时在往下走
- [ ] 等一个采集周期（默认 5 分钟），页面数字自己变了，不需要手动刷新
- [ ] `/api/polls` 里最近几条都是 `ok: true`，没有连续失败
- [ ] `INGEST_TOKEN` 已设置成随机长串（不是空、不是示例值）
- [ ] 告警测试：`curl -X POST 域名/api/ingest -H "x-ingest-token: 你的token" -d '[]'` 能返回 200；企业微信/钉钉群能收到告警（可先把 `dropRate` 调到 0.05 触发一次）
- [ ] 服务器 `reboot` 一次，起来后服务自动恢复；备份任务已加进 crontab

```bash
# 一条命令跑完主要检查
curl -s 域名/api/health && curl -s 域名/api/status | python3 -m json.tool | head -30
```

---

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面不实时刷新，手动刷新才有新数据 | 反向代理开了缓冲。Nginx 加 `proxy_buffering off;`，Caddy 加 `flush_interval -1` |
| 页面显示「演示数据」 | 不是通过 http(s) 打开的，或采集服务没起。用 `域名/` 打开，检查 `systemctl status media-monitor` / `docker ps` |
| 采集状态「采集失败」 | 看 `/api/polls` 的 message：密钥过期、接口地址错、服务器出网被安全组限制 |
| 端口被占用 | 改 `PORT` 环境变量 |
| 数据没涨 | 上游接口当天没有新数据；用 `/api/ingest` 推一条测试 |
| 磁盘占用 | 一天两三千条作品约 1~2MB，20G 磁盘够用几年；配合备份脚本定期清理 |
| 时区不对 | 服务器设 `TZ=Asia/Shanghai`（`timedatectl set-timezone Asia/Shanghai`） |
