# 批改 worker 部署与维护

## 为什么需要独立 worker

Vercel 是请求级的无服务器环境，函数执行完进程就回收，跑不了常驻的批改轮询循环。
`server.js` 里的 `wholePaperWorker.start()` 只在常驻 Node 进程里生效，所以线上站点把整卷批改任务交给一台常驻服务器上的独立 worker 处理。

## 当前部署

| 项目 | 值 |
| --- | --- |
| 服务器 | `root@43.155.216.162`（Ubuntu 24.04，Node 22） |
| 目录 | `/opt/scan-grading-worker` |
| 服务 | systemd `scan-grading-worker.service`（已 enable，`Restart=always`） |
| 入口 | `worker.js`（本仓库同名文件） |
| 数据库 | 与线上共用 Neon，配置在服务器 `/opt/scan-grading-worker/.env`（权限 600，不入库） |
| 端口 | 不监听任何端口，只主动出站连接 Neon 和 DeepSeek，不占用服务器现有服务 |

服务器上的文件清单：

```text
/opt/scan-grading-worker/
  worker.js
  db.js
  schema.sql
  package.json
  node_modules/        # 只装 pg / sharp / xlsx
  lib/ai-grader.js
  lib/whole-paper-worker.js
  .env
```

## 可用性判断：心跳表

- worker 每 20 秒向 `worker_heartbeats` 写一次 `last_seen_at`，前提是自己判定为健康（`worker.isAvailable()`）
- 接口侧 `api/mvp.js` 调 `db.isWorkerHeartbeatFresh()`，90 秒内有心跳才允许 `desk-start` / `desk-retry`
- 心跳表由 `schema.sql` 创建，`initDatabase()` 在 worker 启动和每次 Vercel 请求时都会确保它存在
- worker 停机超过 90 秒，页面会重新提示“后台批改工作进程不可用”，任务不会静默卡住
- 不需要在 Vercel 配置 `WORKER_EXTERNAL` 之类的开关

## 运维命令

```bash
# 状态 / 开机自启状态
systemctl status scan-grading-worker
systemctl is-enabled scan-grading-worker

# 实时看日志（正常每 60 秒一行 healthy=true）
journalctl -u scan-grading-worker -f

# 重启
systemctl restart scan-grading-worker

# 查看心跳是否新鲜（true 表示 90 秒内有心跳）
cd /opt/scan-grading-worker && node --env-file=.env -e \
  "const db=require('./db');db.isWorkerHeartbeatFresh().then(v=>{console.log(v);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
```

## 改代码后必须同步

服务端跑的是 `/opt/scan-grading-worker` 里的副本，**不随 git push 自动更新**。
修改以下任一文件后，需要重新上传并重启：

`worker.js`、`db.js`、`schema.sql`、`lib/whole-paper-worker.js`、`lib/ai-grader.js`（依赖变化时还有 `package.json`）

```bash
scp worker.js db.js schema.sql root@43.155.216.162:/opt/scan-grading-worker/
scp lib/whole-paper-worker.js lib/ai-grader.js root@43.155.216.162:/opt/scan-grading-worker/lib/
ssh root@43.155.216.162 'systemctl restart scan-grading-worker'
```

依赖有变动时补一次：

```bash
ssh root@43.155.216.162 'cd /opt/scan-grading-worker && npm install --omit=dev'
```

## 排障顺序

1. `journalctl -u scan-grading-worker -n 50` 看报错
   - `database init failed`：检查 `.env` 里的 `DATABASE_URL` / `DATABASE_SSL`
   - `heartbeat failed`：查 Neon 连通性和连接数上限
   - `Whole-paper worker:` 开头：批次恢复、租约或 AI 调用失败
2. `systemctl status` 确认不是反复重启
3. 页面仍报 503：确认心跳新鲜度（90 秒窗口）和 Vercel 是否部署到最新提交

## 其他注意点

- 同一批次的任务靠租约（lease）互斥，本机 `node server.js` 的 worker 与服务器 worker 可以同时运行，不会重复批改
- 批改任务单次超时 15 分钟；Vercel 函数 60 秒上限与 worker 无关
- `.env` 含 Neon 和 DeepSeek 密钥，不要提交进仓库；更换密钥后需同步更新服务器上的副本并重启
- 迁移服务器时：复制上述文件 → `npm install --omit=dev` → 新建同名 systemd 服务并 enable → 确认日志 `healthy=true`，代码侧无需改动
