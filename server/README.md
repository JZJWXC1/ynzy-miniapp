# 寓你住一起后端说明

本文档以当前代码为唯一事实来源，覆盖 `server/src`、`deploy`、`utils/deploy-config.js` 和现行 V1 验收脚本。历史入口仍保留在代码中时，会在文档里明确标注为“历史预留，第一版不生效”。

## 当前范围

第一版只面向内部中介使用，底部导航固定为找房、房源、地图、我的。租客端、房东端、房源群、积分充值、换群和微信支付入口第一版不开放。

地图找房仍是核心能力，但地图只展示真实且经过确认的小区坐标。无可靠坐标的房源可以进入普通列表，不能进入地图；禁止用随机坐标、散列坐标、区域估算坐标或默认中心点冒充真实位置。

## 运行与端口

本地运行：

```bash
cd server
npm start
```

本地默认端口来自 `server/src/config.js`：`PORT` 环境变量优先，未设置时为 `3000`。

生产部署端口以 `deploy/install-on-server.sh` 为准：安装脚本会强制把服务器 `server/.env` 写为 `PORT=3101`，并用 `http://127.0.0.1:3101/healthz` 做本机探活。公网访问统一走正式 HTTPS 域名：

```text
https://zf-api.ynzyqbot.cn
```

健康检查：

- `GET /healthz`：进程探活，正常返回 `ok: true`，并在 `data.version` 返回当前运行版本。
- `GET /readyz`：上线就绪检查，依赖配置项完整性，不通过时返回 `503`；同样带 `data.version`。待审核注册申请若通知三次重试耗尽，会新增仅含数量的“注册通知死信 N 条”需处理项，不返回申请姓名、手机号或失败正文；已完成审核的历史申请不再计入待办。

版本追溯（`server/src/version.js` + `server/scripts/gen-version.js`）：`/healthz`、`/readyz` 的 `data.version` 与启动日志都会给出当前运行的代码版本 `{version, commit, shortCommit, branch, builtAt, committedAt, source}`，用于把「链路日志定位到哪条请求」补上「当时跑的是哪版代码」。因为部署是 scp 单文件、生产目录 `/opt/ynzy-miniapp` **不是 git 仓库**，运行时无法 `git rev-parse`，版本信息按优先级来源：① 环境变量 `APP_VERSION`/`APP_COMMIT`/`APP_BRANCH`/`APP_BUILT_AT`；② `server/version.json`（部署/构建期生成）；③ 兜底 `package.json` 的 version + `commit=unknown`。`server/version.json` 为**生成物、已 gitignore、不入库**；部署时在有 git 的本地执行 `node scripts/gen-version.js` 生成它，再随 `src/` 一起 scp 到服务器。缺文件/坏 JSON 均优雅降级、不阻断启动。`source` 字段标明本次版本信息取自哪一层。

发布记录（`server/scripts/record-release.js` + `server/scripts/show-releases.js`）：version.json 记「现网是哪版」，发布记录记「历史每次上线」。每次生产上线向 `server/releases.jsonl`（append-only JSON Lines）追加一条 `{t, commit, shortCommit, branch, version, scope: full|targeted, files, verify, note, host, by}`，形成**可审计的上线台账**——本轮 SEV1 部署漂移、定向部署等就是缺这份历史。`deploy-ecs.ps1` 成套部署成功后自动 `node server/scripts/record-release.js --scope=full --verify=ok`；定向/手工部署也应调用（可传 `--scope=targeted --files=... --note=...`）。查看：`node server/scripts/show-releases.js [--last=20]`。`commit` 默认取 `server/version.json`；`releases.jsonl` 为**生成物、已 gitignore、每环境各自的运行期台账、不入库**；只记非敏感元数据（无密钥/token）。坏行读取时跳过、不崩。

健康巡检（`server/scripts/health-check.js` + `deploy/ynzy-health-check.{service,timer}`）：独立于 `/healthz` 的定时巡检，检查「会拖垮生产但 `/healthz` 未必发现」的信号——**db 可解析**（JSON 有效且含 listings 数组）、**磁盘余量**（`df -Pk`，低于 `DISK_MIN_FREE_PCT`% 告警，默认 10）、**备份新鲜度**（复用 `backup.checkFreshness`，超 `BACKUP_MAX_AGE_HOURS` 小时无新备份告警，默认 24；未配置备份目录则跳过不误报）、**服务端点**（`curl /healthz` 是否 200）。打一行 `[health] {"ok","checks","failures"}` 到 journald，**任一失败非零退出**（systemd 可据此告警）；配了 `HEALTH_ALERT_CMD` 时经环境变量把摘要传给外部通知命令（仓库不写凭据/webhook）。systemd 定时器每 15 分钟跑一次（`install-on-server.sh` 自动加装）；服务单元 `EnvironmentFile=-/etc/default/ynzy-backup` 复用备份环境。不改 `index.js`/`/readyz`，是纯旁路巡检。查看：`journalctl -u ynzy-health-check --since "1 hour ago"`。

需求转化漏斗（`server/src/need-funnel.js` + `server/scripts/metric-readout.js`）：服务端在持久需求的 `funnel` 对象中只保存固定版本和首次里程碑 ISO 时间，包含首次有效推荐、L1 敏感查看、L2 报备、审核通过带看、L3 成交提交与管理员确认；不保存客户、房源、地址或自由文本。业务记录仍保留各自 `needId`，计算时会再次校验需求 `brokerId` 与 trace/足迹/报备/带看/成交的服务端用户字段，串绑记录不计。重复请求不覆盖首次时间；足迹或 trace 达保留上限后，需求里程碑仍可持续读出。

- 主指标 `fillL2_reportPct`：有可信报备的需求数 / 持久需求总数。
- 首次有效推荐耗时：需求创建到首个“绑定同一需求且实际返回房源”的持久 trace，输出 P50/P95 分钟和可测样本数。
- 带看率 `showingRatePct`：有审核通过带看的需求数 / 已报备需求数；待审核或驳回照片不计。
- 成交确认率 `dealConfirmationRatePct`：管理员已确认成交的需求数 / 已提交成交的需求数；提交不能冒充确认。
- 新客户端带看会提交当前持久 `needId` 并由服务端验归属；临时/空需求及旧客户端仍可提交带看证明，但不计入需求漏斗，避免破坏兼容。
- 每日 `ynzy-metric-snapshot.timer` 继续只读追加 `metrics-snapshots.jsonl`；查看当前聚合用 `node scripts/metric-readout.js --pretty`，查看趋势用 `node scripts/show-metric-trend.js --last=14`。两者只输出计数、比例和耗时，不输出任何原始 `needId` 或 PII。

请求链路日志（`server/src/request-log.js`）：每个请求分配一个 `traceId`，通过响应头 **`X-Trace-Id`** 回给客户端，并在响应结束时向 stdout（systemd journal 可见）打一行结构化 JSON：`[req] {"t","lvl","trace","method","path","status","ms","ip"}`。用于「后端查无请求、前端只报统一网络错误」这类真机问题——前端把 `X-Trace-Id` 记下来，后端 `journalctl -u ynzy-miniapp | grep <trace>` 即可看到该请求是否到达、走了哪条路径、状态码与耗时。**只记 `pathname`，不记查询串、请求体、手机号/地址等 PII**。`REQUEST_LOG=0`/`off` 可关闭日志（仍回 `X-Trace-Id` 头便于关联）。userId 关联留作后续（当前无中央鉴权点）。

HTTP 内测链路已废弃。不要再使用旧公网 IP、`--internal-http` 或 IP 直连方式做体验版验收；小程序端当前配置见 `utils/deploy-config.js`，默认请求 `https://zf-api.ynzyqbot.cn`。

## 数据文件与备份

当前仍使用 JSON 文件模拟正式数据表，默认路径为 `server/data/db.json`，也可以通过 `DATA_FILE` 指向其他文件。

主要数据结构：

- `users`：中介用户。
- `listings`：房源。
- `rentalNeeds`：需求单；`funnel` 子对象只保存 `need-funnel-v1` 固定里程碑时间。
- `clientReports`：报备记录。
- `dealRecords`：签单记录。
- `commissionRecords`：分佣记录。
- `footprints`：敏感信息查看、视频转发、房态核验等留痕。
- `adminAccounts`：管理后台账号。
- `llmConfig`：LLM 配置。
- `uploadRecords`：上传记录。
- `companySheetSnapshot`：飞书公司房源表快照缓存。

生产部署包含 `db.json` 定时备份：

- `deploy/ynzy-db-backup.timer`：开机 5 分钟后首次执行，之后每 30 分钟执行一次。
- `deploy/ynzy-db-backup.service`：调用 `deploy/backup-db.sh`。
- 默认备份目录：`/opt/ynzy-miniapp-backups/db`。
- 默认保留数量：最近 `48` 份。
- `latest.json` 是指向最新备份的软链。
- 备份前会先用 Node 解析 JSON，避免把损坏文件当成有效备份。

上面是**本地明文**备份（防误删/回滚用）。在此之上另有一层 **异地加密备份 + 恢复演练 + 失败告警**（P0-1），用于机器损毁/勒索/整机丢失时的异地恢复：

### 异地加密备份（P0-1）

- 核心库：`server/src/backup.js`（零外部依赖，仅用 Node 内置 `crypto`/`zlib`）。
- 备份 CLI：`server/scripts/backup-db.js`
  - 读 `DATA_FILE` 指向的 `db.json` → gzip 压缩 → **AES-256-GCM 加密**（口令经 scrypt+随机 salt 派生密钥）→ 以 `db-backup-<UTC时间戳>.ygbak` 落盘。
  - 落盘后**即时自检**：立刻解密演练并做往返数量校验，自检不过的备份会被删除、不外发。
  - 自检通过后调用**异地上传钩子**，再执行**保留清理**。
- 恢复演练 CLI：`server/scripts/restore-drill.js`
  - 解密最新（或 `--file` 指定）备份到系统临时目录，**绝不写回生产 `db.json`**。
  - 校验 JSON 可解析，输出 `listings/users/reports/deals/commissionRecords/footprints` 六项数量。
  - **往返一致性校验**：恢复出的六项数量必须与备份时刻记录的源数量逐项相等，任一不符即判失败。
  - 顺带做**新鲜度巡检**：最近一份备份超过 `BACKUP_MAX_AGE_HOURS`（默认 24h）即告警。
  - 说明：`reports`/`deals` 对应库内真实键 `clientReports`/`dealRecords`，计数已按真实键统计。

#### 环境变量

密钥、异地目标、外部通知命令**只从环境变量读取**，仓库内不写任何真实值：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `BACKUP_ENCRYPTION_KEY` | 是 | 加密/解密口令；缺失时备份 CLI 直接拒绝运行，绝不产出明文备份。请用强随机串并妥善异地保管——**丢失即无法恢复**。 |
| `DATA_FILE` | 否 | 源 `db.json` 路径，默认 `server/data/db.json`（沿用既有变量）。 |
| `BACKUP_STAGE_DIR` | 否 | 本地加密备份暂存目录，默认 `server/backups/`（已在 `.gitignore`）。若自定义，**必须指向仓库外目录或保持默认**，切勿指到仓库内其他位置——加密备份仍是生产数据，禁止入库。`.gitignore` 另加了 `*.ygbak` 全局忽略作纵深防线，但仍以「暂存目录在仓库外」为准。 |
| `BACKUP_RETENTION_DAYS` | 否 | 保留天数，默认 `30`，过期自动清理。 |
| `BACKUP_MAX_AGE_HOURS` | 否 | 新鲜度阈值小时数，默认 `24`。 |
| `BACKUP_REMOTE_CMD` | **生产必填** | 异地上传命令模板；脚本会以环境变量 `BACKUP_FILE`（完整路径）、`BACKUP_FILENAME` 传入，命令内用 `$BACKUP_FILE` 引用。远端目标与凭据全部落在此命令/其引用的凭据文件里，**不写入仓库**。**默认未配置即判失败**（触发 `BACKUP_REMOTE_REQUIRED` 告警、非零退出）——因为 P0-1 目标是「异地备份」，只做本机加密备份不算达成。 |
| `BACKUP_ALLOW_LOCAL_ONLY` | 否 | 显式设为 `1` 时，允许「未配置 `BACKUP_REMOTE_CMD`、仅本地加密备份」成功退出（供本地演练/临时用）。**生产禁止开启**：开启即失去异地容灾能力。 |
| `BACKUP_ALERT_CMD` | 否 | 外部通知命令模板（如企业微信/飞书 webhook 推送）；触发告警时以环境变量 `ALERT_KIND`、`ALERT_MESSAGE`、`ALERT_DETAIL` 传入。**只在此文档说明，不写入仓库**。未配置时告警仍会打到 stderr。 |

`BACKUP_REMOTE_CMD` 示例（放服务器环境文件，勿入库）：

```bash
# 飞书云盘异地备份（推荐；见下「飞书云盘异地备份」一节）
BACKUP_REMOTE_CMD='node scripts/upload-backup-to-feishu.js'
# 或 rsync 到异地主机（SSH 私钥仅本机保存，开 IP 白名单）
BACKUP_REMOTE_CMD='rsync -az -e "ssh -i /root/.ssh/backup_offsite" "$BACKUP_FILE" backup@offsite.example.com:/data/ynzy-db-backups/'
# 或阿里云 ossutil 传到与生产不同地域的 Bucket（异地容灾）
BACKUP_REMOTE_CMD='ossutil cp "$BACKUP_FILE" oss://ynzy-dr-backup-shenzhen/db/ -f'
```

#### 飞书云盘异地备份

`server/scripts/upload-backup-to-feishu.js` 把 `backup-db.js` 落盘的 `.ygbak` 通过飞书开放平台以 **multipart/form-data** 上传到指定云盘文件夹（Node 内置 `fetch`/`FormData`，零依赖）。接线方式就是把上面的 `BACKUP_REMOTE_CMD` 设成 `node scripts/upload-backup-to-feishu.js`——`backup-db.js` 会把刚生成的备份路径经 `BACKUP_FILE` 环境变量传给它。

飞书凭据只从环境变量读取（连同 `/etc/default/ynzy-backup` 一起，chmod 600，不入库）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_BACKUP_APP_ID` | 是 | 飞书自建应用 App ID（建议为备份单独建一个应用，权限最小化） |
| `FEISHU_BACKUP_APP_SECRET` | 是 | 该应用 App Secret |
| `FEISHU_BACKUP_FOLDER_TOKEN` | 是 | 目标云盘文件夹 token（folder_token，从飞书云盘该文件夹 URL 取） |
| `FEISHU_BACKUP_UPLOAD_NAME_PREFIX` | 否 | 上传文件名前缀（如 `prod-`），便于区分环境 |
| `FEISHU_BACKUP_API_BASE_URL` | 否 | 飞书开放平台地址，默认 `https://open.feishu.cn/open-apis` |

飞书后台需要用户提供/配置：① 建自建应用拿 App ID / App Secret；② 开通云盘（drive）文件上传权限（`drive:drive` 或等价的文件写权限）；③ 建一个专用文件夹并把该应用加为协作者（可编辑），取 folder_token。

**红线（务必遵守）：**

- 飞书云盘**只存 `.ygbak` 加密备份文件**，严禁上传 `BACKUP_ENCRYPTION_KEY`、`.env`、明文 `db.json` 或任何凭据。
- `BACKUP_ENCRYPTION_KEY` **绝不放飞书**，只放服务器 `/etc/default/ynzy-backup`；并请把它**另存到本机密码管理器 + 手抄一份离线纸质备份**——密钥与加密备份分离存放，任一处泄露都拿不到明文数据；密钥丢失则所有备份都无法解密。

#### 从飞书自动拉回演练（完整闭环）

两层演练互补：
- `ynzy-restore-drill.timer`（每天 03:10）用**服务器本机最新 `.ygbak`**验证本地备份可恢复。
- `ynzy-feishu-drill.timer`（每周日 04:10）跑 `server/scripts/restore-drill-from-feishu.js`：**自动从飞书云盘下载最新 `.ygbak` → 解密 → 往返数量校验**，验证「上传到飞书的那份也真能恢复」，形成「备份→加密→上传飞书→拉回→演练」完整闭环。两个 timer 都由 `install-on-server.sh` 自动安装启用。

手动跑一次飞书拉回演练：

```bash
cd /opt/ynzy-miniapp/server
# 需要 BACKUP_ENCRYPTION_KEY 解密、FEISHU_BACKUP_* 拉回（都在 /etc/default/ynzy-backup）
systemctl start ynzy-feishu-drill.service && journalctl -u ynzy-feishu-drill -n 20
# 或直接：
node scripts/restore-drill-from-feishu.js
```

流程：取 tenant_access_token → 列云盘文件夹 → 按文件名时间戳选最新 `.ygbak` → 以二进制下载到临时目录 → 调 `restoreDrill` 解密校验。下载的是加密 `.ygbak`；解密只到临时目录、用完即清，不残留明文，也不写回生产。输出 `listings/users/reports/deals/commissionRecords/footprints` 的「备份时刻 vs 恢复出」逐项计数，逐项相等即通过；任一步失败（缺凭据/无备份/下载失败/解密失败/数量不符）非零退出。

仍可用本机文件手动演练（不经飞书）：

```bash
BACKUP_ENCRYPTION_KEY=*** node scripts/restore-drill.js --file backups/db-backup-<UTC>.ygbak
```

锁定测试：`server/scripts/feishu-restore-drill-v1-test.js`（mock 飞书 list/download，不触公网）。

#### 手动备份 / 手动恢复演练

```bash
cd server
# 生产手动异地加密备份（必须带异地目标，否则判失败）
BACKUP_ENCRYPTION_KEY=*** BACKUP_REMOTE_CMD='...' node scripts/backup-db.js
# 本地演练/临时（无异地目标）必须显式允许仅本地，否则默认判失败
BACKUP_ENCRYPTION_KEY=*** BACKUP_ALLOW_LOCAL_ONLY=1 node scripts/backup-db.js

# 手动恢复演练（默认演练最新一份；也可 --file 指定）。纯演练用完即删，不残留明文。
BACKUP_ENCRYPTION_KEY=*** node scripts/restore-drill.js
BACKUP_ENCRYPTION_KEY=*** node scripts/restore-drill.js --file backups/db-backup-20260706T120000Z.ygbak

# 真恢复取数：带 --out 把解密出的 db.restored.json 保留到指定目录（演练同时校验一致性）
BACKUP_ENCRYPTION_KEY=*** node scripts/restore-drill.js --file backups/db-backup-20260706T120000Z.ygbak --out /tmp/ynzy-restore
```

真要**恢复到生产**时（区别于只读演练）：先用带 `--out` 的命令确认目标备份可解密、数量吻合并把 `db.restored.json` 落到指定目录，再停服、把该文件覆盖到 `server/data/db.json`，重启并核对 `listings` 数量。恢复前务必先按「本地明文备份」一节把当前 `server/data` 另存，便于回滚。注意：不带 `--out` 的纯演练会把解密产物用完即删，绝不残留明文，因此真恢复必须用 `--out`。

#### 定时任务（systemd，部署脚本自动安装）

`deploy/install-on-server.sh` 会自动安装并启用 `ynzy-offsite-backup.timer`（每 6h 备份）与 `ynzy-restore-drill.timer`（每天 03:10 演练+新鲜度巡检），二者从 `/etc/default/ynzy-backup`（chmod 600，含密钥/异地目标，**不入库**）读环境。在该文件填好 `BACKUP_ENCRYPTION_KEY` 与 `BACKUP_REMOTE_CMD` 前，备份会 fail-loud（属预期）。手动验证：`systemctl start ynzy-offsite-backup.service && journalctl -u ynzy-offsite-backup -n 20`。

#### 定时任务（cron 示例，非 systemd 环境）

```cron
# 每 6 小时异地加密备份一次（环境变量建议写在 /etc/default/ynzy-backup 并 source）
0 */6 * * * . /etc/default/ynzy-backup; cd /opt/ynzy-miniapp/server && node scripts/backup-db.js >> /var/log/ynzy-backup.log 2>&1
# 每天 03:10 跑一次恢复演练 + 新鲜度巡检（失败会以非零码退出并触发告警）
10 3 * * * . /etc/default/ynzy-backup; cd /opt/ynzy-miniapp/server && node scripts/restore-drill.js >> /var/log/ynzy-restore-drill.log 2>&1
```

#### 告警条件（均输出明确错误、非零退出）

- `BACKUP_FAILED`：读源/加密/写盘失败。
- `BACKUP_VERIFY_FAILED`：新备份即时自检不过（已删除坏备份）。
- `BACKUP_EMPTY_SOURCE`：跨备份计数回归——本次备份六项计数全为 0 但上一份备份仍有数据，疑似源被截断/读空（已删除该空备份并判失败）。
- `BACKUP_REMOTE_REQUIRED`：未配置 `BACKUP_REMOTE_CMD` 且未显式 `BACKUP_ALLOW_LOCAL_ONLY=1`，未达成异地目标（本地可信备份已保留，但本轮判失败）。
- `REMOTE_UPLOAD_FAILED`：异地上传命令失败。
- `RESTORE_MISMATCH`：恢复演练往返数量不符。
- `RESTORE_FAILED`：演练解密/解析失败或无备份可演练。
- `BACKUP_STALE`：最近一次备份超过 `BACKUP_MAX_AGE_HOURS`。

上述条件均有锁定测试：`server/scripts/backup-restore-v1-test.js`。

足迹留痕写入统一经过后端截断。代码默认 `FOOTPRINT_MAX_ROWS=5000`，最低不会低于 `1000`；生产 systemd 服务显式设置为：

```ini
Environment=FOOTPRINT_MAX_ROWS=30000
```

数据库 JSON 默认紧凑写入以降低整库重写的磁盘写放大；如需人工排查可设置 `DB_JSON_PRETTY=1` 恢复两空格缩进（`/admin/data/export` 导出始终为美化格式，不受影响）。

**并发写保护（P0-2）**：`server/src/db.js` 的写路径（`updateDb`/`writeDb`）加了一层零依赖的**跨进程 advisory 写锁**（同机 `db.json.lock` 文件锁），防止服务器与运维脚本（如 `backfill-listing-districts.js`、`geocode-listing-communities.js`）同时写库时后写覆盖先写、丢数据。单进程内 `updateDb` 本就被事件循环串行化、锁几乎无争用；锁持有仅毫秒级。锁按「持有者进程存活探测」回收陈旧锁（持有者存活绝不误删活锁），获取有界超时（拿不到就抛错、绝不死锁或无限自旋），并对 Windows 瞬时 `EPERM`/`EBUSY` 做重试。相关环境变量（一般无需设置）：`DB_WRITE_LOCK`（默认开；置 `0`/`off` 紧急退回无锁旧行为）、`DB_LOCK_TIMEOUT_MS`（默认 10000）、`DB_LOCK_STALE_MS`（默认 30000）。锁定测试：`server/scripts/db-write-lock-v1-test.js`。飞书同步这类「clone→长 await→落盘」路径仍由 `commitDelta` 的三方合并处理 await 窗口内的并发（与本锁互补）。

游客限流按客户端 IP 分桶。`TRUST_PROXY` 默认开启，表示服务部署在 nginx 等可信反向代理之后，取 `X-Forwarded-For` 末段（由代理追加、客户端无法伪造）作为真实 IP；若直连暴露（无反向代理）务必设 `TRUST_PROXY=0`，改用 socket 远端地址，避免客户端伪造 XFF 绕过限流。

## 小程序端鉴权

小程序登录接口（账号密码制）：

```http
POST /mini/auth/login      body: { phone, password }
POST /mini/auth/register   body: { name, phone, password }
```

- **登录 = 手机号 + 密码**。服务端只匹配未软删用户，并用 `verifyPassword`（scrypt）校验密码。以下一律 403、不发 token：手机号未开通（引导联系管理员开通）、账号未设密码（fail-closed，引导联系管理员重置）、密码错误（统一提示「手机号或密码不正确」，不暴露命中与否）。缺密码返回 400。登录入口按客户端 IP 限流（20/min）防暴力破解。
- **注册 = 申请-审核-开通**。任何人可提交注册申请（含自设密码，服务端立即 scrypt 哈希存进申请记录），但**注册一律不发 token**：新手机号落 `registrationRequests` 待审核并提示「已收到您的注册信息…请联系寓你住一起管理员开通账号权限」（403）；已开通手机号返回 409 引导直接登录（不再免密发 token）。同一手机号处于待审核时，后续提交严格幂等，不改原申请姓名、密码或更新时间，防止后来者凭手机号接管申请；只有已驳回或已通过后账号又被删除时，才允许开启一轮重新申请。管理员在后台 `/admin/registrations` 审核通过后，注册时自设的密码即写入新账号，用户可直接用该密码登录。
- **注册申请飞书提醒**：新申请或驳回/开通后的重新申请落库时，服务端异步推飞书群提醒管理员审核（复用 `scripts/send-feishu-alert.js`）。姓名中的标签边界、换行和控制字符会先转义/清理，手机号只发打码值；子进程 env 只含系统变量与 `HEALTH_ALERT_*`，拿不到 OSS/token 等应用密钥。发送状态与次数写在申请记录的 `notifyStatus` / `notifyAttempts`：只有发送脚本退出码为 0 才记成功，失败默认在 1 秒、5 秒后重试，总次数最多 3 次；进程重启会恢复未完成任务。第三次仍失败时状态进入 `dead_letter`，同时记录 `notifyDeadLetterAt` / `notifyDeadLetterReason`，并通过同一 `HEALTH_ALERT_WEBHOOK` 升级发送 `REGISTRATION_NOTIFY_DEAD_LETTER` 告警；死信告警只包含分组后的申请追踪 id、次数、时间和失败摘要，不包含姓名、手机号、密码或完整申请内容。告警以“成功送达最多一次”为准：若发送失败或进程在 `sending` 中断，重启后会补发；一旦记为 `sent`，后续重启不再重复。通知链始终不阻塞注册响应。启用条件：应用进程能读到 `HEALTH_ALERT_WEBHOOK`——需把该变量**同步写进 `server/.env`**（应用不加载 `/etc/default/ynzy-backup`，是有意隔离：避免备份加密密钥进入应用进程环境），改后 `systemctl restart ynzy-miniapp` 生效；未配置则保留 `pending` 状态且不发送，配置后重启会补发。测试环境可用 `REGISTRATION_NOTIFY_RETRY_DELAYS_MS=40,80` 缩短两次重试间隔，生产通常保持默认值。
- **密码存储**：`scrypt$<salt>$<hash>`（随机 salt + `timingSafeEqual` 恒定时间比对，实现见 `src/auth-util.js`，与后台管理员账号共用）。DB 不存明文；`passwordHash` 绝不随 `/mini/auth/me`、`/mini/profile`、`/mini/auth/login`、`/admin/users`、`/admin/registrations` 等任何响应外泄。
- **存量/后台建号设密**：管理员在后台「账号管理」对中介/员工点「设置/重置密码」，或调 `POST /admin/users/:id/password`（仅超级管理员）为无密码账号发初始密码；后台建号 `POST /admin/users` 也可带可选初始密码。未设密码的账号一律 fail-closed 禁登。
- **绑定管理账号单向同步**：`adminAccounts`（后台登录）与 `db.users`（小程序手机号登录）仍是两套鉴权记录；只有管理账号持久化了有效 `userId` 绑定时，`POST /admin/accounts` 创建和 `POST /admin/accounts/:id/password` 重置才会把同一轮服务端 scrypt 哈希同步给该既有用户，并提升其 `tokenVersion` 撤销全部旧小程序会话。服务端绝不按管理账号文本或手机号猜测绑定，也不自动创建小程序身份；未绑定或绑定用户已删除时只更新后台密码，响应 `miniLoginSynced=false`，后台会明确提示小程序密码未同步。若旧版本已改过后台密码但绑定用户仍缺小程序密码，首次输入正确后台密码登录小程序时，仅在“一个用户唯一绑定一个有效、带哈希管理账号”且 scrypt 验证通过后安全回填；未绑定、多重绑定、停用账号、坏哈希或密码错误均不写入。小程序用户自助改密不会反向修改高权限后台密码。

登录成功后，后端签发小程序 token，并返回 `token` 与 `tokenExpiresAt`。小程序请求需使用：

```http
Authorization: Bearer <token>
```

鉴权密钥只来自服务端环境变量：

```env
AUTH_TOKEN_SECRET=
```

token 有效期为 7 天。服务端用 HMAC-SHA256 校验 token，过期、签名错误、用户不存在或被禁用都会返回 `401`。token 还签入账号级 `tokenVersion`：用户自助修改密码时版本递增，服务端向当前设备返回新版本 token，其他设备的旧 token 下一次请求立即 `401`；管理员重置密码同样递增版本，所有小程序旧会话立即失效，用户需用新密码重新登录。上线前签发、未携带版本号的存量 token 按版本 0 兼容，直到该账号首次改密。`tokenVersion` 只保存在服务端 DB 与签名载荷，不作为用户资料字段下发。

`X-User-Id` 已废除，不能再作为鉴权来源。当前鉴权测试覆盖了伪造 `X-User-Id`、篡改 payload 沿用旧签名、换错误密钥重签的场景：无 token 访问需登录接口返回 `401`；有合法 token 时，服务端以 token 内的真实用户为准，忽略伪造请求头。

游客模式边界：

- 匿名用户可以访问首页、公司房源列表、公司房源详情、地图公司房源点位、公司房源表快照和助手匹配中的公司房源结果。
- 公司房源对匿名与登录中介全量公开，包含房号、完整地址、联系方式、看房方式密码、备注等公司公开字段。
- 匿名用户只能看到公司房源；访问二房东房源或业主房源详情返回 `401`。
- 合作房源的完整地址、房东电话等敏感信息仍走登录、实名/需求单校验和留痕机制。
- 上传、我的房源、需求单、报备、签单、分佣、足迹、视频上传策略等操作接口仍强制登录。

## 房源类型、视频与可见性

房源分为：

- 公司房源：公司自营或飞书同步房源，优先信任 `companyListing=true` 或结构化 `source=公司房源`，命中公司后不再进入业主筛选。
- 二房东房源：合作房源，`ownerType=二房东房源`、`houseSourceType=二房东房源` 或结构化 `source=二房东房源`。
- 业主房源：合作房源，`ownerType=业主房源`、`houseSourceType=业主房源` 或结构化 `source=业主房源`。

业主/二房东归类只信结构化枚举字段，标题、描述、户型里出现“业主”等文字不参与判定；存量公司房源若误带 `ownerType=业主房源`，读库迁移会纠正为公司房源。

视频规则：

- 公司房源免视频，允许无视频进入公司房源列表和详情。
- 二房东房源、业主房源必须带真实视频，`videoUrl` 或 `videoKey` 至少有一个。
- 视频文件本体不进 `db.json`，房源只保存访问地址或 OSS 对象 Key。
- 有 `videoKey` 时，详情接口会生成短期签名播放地址，默认有效期由 `ALI_OSS_READ_URL_EXPIRE_SECONDS` 控制，当前默认 `900` 秒。

房源可见性：

- 前台有效房源会排除已失效、已下架、已成交和待审核未通过房源。
- 公司房源公开完整字段。
- 合作房源列表与详情不直接公开完整地址和房东电话；敏感查看必须登录并留痕。
- `GET /mini/listings/:id` 会区分“查无此 id”和“原始房源存在但不可前台查看”：前者仍返回 `404` 与“房源不存在”，后者返回结构化 `{ unavailable: true, reason: 'expired'|'down'|'pending', reasonText }`，且不返回地址、房东电话或视频签名。详情页据此展示已下架/已更新状态，不再渲染空壳。
- 地图只按小区聚合展示，不展示具体楼栋、单元、房号、房东电话或看房密码。

房态规则固定为第 3 天提醒、第 5 天再次提醒、第 7 天未更新自动失效。失效房源保留在后台资产池，可由管理员恢复。

## 分佣规则

分佣由服务端按当前配置计算，客户端提交的 `brokerId`、`uploaderId`、`commissionRate` 或同名字段不能影响结果。

现行规则：

- 成交后按房东实际支付佣金总扣 `20%`。
- 二房东房源：上传人比例来自后台分佣配置，默认 `15%`；平台留存为总比例减上传人比例。
- 业主房源：上传人比例来自后台分佣配置，默认 `20%`；平台留存为总比例减上传人比例。
- 公司房源：不分佣，不生成分佣记录。
- 管理员上传的合作房源：仍记录房源类型，但上传人是管理员；确认签单时上传人分佣为 `0%`，平台拿到总扣 `20%`。

签单只能从报备记录发起。中介提交签单时只填写成交月租、房东实际支付佣金和可选备注；签单时会冻结当时的分佣配置快照，管理员确认后按快照生成正式分佣记录，后续配置调整不影响历史成交。金额统一按分存储，避免小数误差。

## 上传房源

小程序端上传房源使用：

```http
POST /mini/listings
PUT /mini/my/listings/:id
```

必填字段由服务端校验：城市、区域、小区、楼栋、房号、租金、户型和特点标签。非公司房源还必须有真实视频。

小区匹配与人工审核：服务端已知小区 = `server/src/community-library.js` 的 `GONGSHU_COMMUNITIES` 名单 ∪ `server/src/community-coordinates.js` 的坐标表键（归一化去重后的并集）。匹配判定以服务端 `isKnownCommunity` 复核为权威——新建房源或把小区改为库外名称时，服务端判未匹配并进入人工审核、审核通过后才上架；小区名未变且历史已匹配（含兼容字段推导）的存量房源沿用历史判定，不因编辑重新进入审核；普通调用方的库外「已匹配」声明不被采信，申报只允许收紧（可主动申请人工审核，不能豁免）；管理员显式提交 `requiresManualReview=false` 时可豁免人工审核。客户端联想库 `utils/gongshu-communities.js` 由 `node server/scripts/sync-client-community-library.js` 从服务端库自动生成，请勿手改；新增小区只改服务端名单或坐标表后重跑该脚本，两端一致性由 `server/scripts/community-library-parity-test.js` 锁定（客户端缺库内小区会导致编辑/上传被误转人工审核）。

看房方式（`viewingMethod`）为选项字段：`钥匙` / `密码` / `联系房东`，并按所选方式条件必填对应信息——钥匙必填 `viewingKeyLocation`（钥匙位置）、密码必填 `viewingPassword`（看房密码）、联系房东必填 `contact`（房东手机号）。**房东手机号不再无条件必填**，仅看房方式为联系房东时必填；不传看房方式的旧客户端仍要求联系方式（保证房源至少有一种可看房途径）。

存量房源展示口径（未显式指定方式时推导）：公司房源跟飞书表走——「看房方式密码」列是真密码按 `密码`，是「几号空出」这类腾房备注或为空则按 `联系房东`（详情页电话走 `COMPANY_CONTACT_PHONES` 公司统一看房电话）；非公司房源电话优先——有房东电话按 `联系房东`，只有密码才按 `密码`。钥匙位置与看房密码同地址、房东电话一样属敏感信息：非公司房源留痕后才下发，公司房源随公司公开字段直接下发。

公司房源只能由管理员上传或标记；普通中介不能把合作房源伪装成公司房源。

特点标签现行可新选白名单：

```text
近地铁、电梯、燃气、独卫、朝南、带阳台、带露台（阁楼）、可短租、可月付、干湿分离、采光好、首次出租、民水民电、无
```

历史兼容标签：

```text
整租、合租、可带看、急租、免押金、不分佣
```

历史兼容标签只为存量展示与数据兼容保留，不作为新上传可选项；`不分佣` 不能作为客户端控制分佣的开关。

## 列表与地图筛选

公司房源列表和 `/mini/listings` 支持组合筛选。现行参数名以 `block` 为准，不再使用 `board`。

常用参数：

| 参数 | 含义 | 示例 |
| --- | --- | --- |
| `district` | 行政区 | `拱墅区`、`上城区` |
| `block` | 板块/商圈 | `东新园`、`闸弄口` |
| `community` | 小区名模糊匹配 | `长浜龙吟轩` |
| `rentMode` | 租赁方式 | `整租`、`合租` |
| `layout` | 户型 | `一室`、`两室`、`三室`、`三室以上` |
| `rentMin` | 最低租金 | `3000` |
| `rentMax` | 最高租金 | `5000` |

示例：

```http
GET /mini/listings?district=上城区&block=闸弄口&rentMode=整租
GET /mini/listings?district=拱墅区&block=东新园&layout=两室&rentMin=3000&rentMax=5000
```

区域和板块配置来自 `server/src/config.js`：

- 拱墅区：万达、北部软件园、城北万象城、石桥、华丰、永佳、半山、东新园、杭氧、新天地。
- 上城区：闸弄口、新塘、元宝塘、东站。
- 余杭区：暂无固定板块，主要通过下面的小区级覆盖归属。

除板块映射外，`config.js` 还提供 `communityLocationOverrides` 小区级覆盖表（小洋坝家园一/二/三区、大华海派风景、风雅乐府、瑷颐湾等固定为余杭区/城北万象城）。**小区级覆盖优先级高于板块映射**：命中覆盖表的小区直接按覆盖行政区和板块归属，不再落回板块所属区。飞书同步、快照房源和前台筛选都使用同一套 `districtForLocation` 映射入口，后续扩展行政区时优先改服务端配置。

地图接口：

```http
GET /mini/map/communities
GET /mini/map/pins
```

地图筛选复用区域、板块、租金、户型和租赁方式等参数，但只返回可靠小区坐标。

坐标分级（`verified`/`approximate`/`block-center` 三档，含板块中心兜底）与离线地理编码依赖腾讯位置服务：`QQ_MAP_WEBSERVICE_KEY`（兼容旧名 `QQ_MAP_KEY`）从环境变量读取，`server/scripts/geocode-listing-communities.js` 用它批量补小区坐标。

## 公司房源表快照

小程序端快照接口：

```http
GET /mini/company-sheet-snapshot
```

快照接口按飞书表头动态返回列，不再要求前端硬编码表头。后端会修正区域合并单元格的向下填充，并保证表头与数据行列数一致。当前公司房源快照不做游客双视图，匿名与登录中介看到同一份完整公司房源表，包含 `看房方式密码` 等公司公开字段。公司房源详情下发的公司看房电话优先来自 `COMPANY_CONTACT_PHONES`（逗号分隔、服务端配置）；未配置时只回退到房源自身的 `contact` / `landlordPhone` 字段，生产必须显式配置，避免真实号码固化在版本库。

原表头行不会混入数据行；前端应按接口返回的 `rows[0]` 渲染列。

## 飞书公司房源同步

管理后台接口：

```http
GET /admin/feishu-sync/status
POST /admin/feishu-sync/run
```

同步间隔默认值来自 `server/src/config.js`，当前默认 `60` 分钟；服务器可通过环境变量覆盖：

```env
FEISHU_SYNC_INTERVAL_MINUTES=60
```

同步规则：

- 房源表和视频素材库按房号/楼栋单元房号等 Key 对齐。
- 飞书表仍在架的公司房源会写入或更新本地房源，并标记 `companyListing=true`、`noCommission=true`。
- 飞书同步同时用 `feishuRecordId` 和“小区+楼栋+单元+房号”物理房源键复用旧房源；同一物理房源即使 record_id 变化，也必须保持同一个 `listing.id`，避免推荐卡片指向的旧 id 被下架再重建。
- 物理房源键必须具备最小具体性：小区、楼栋、房号缺任一项，或楼栋/房号为 `-`、`无`、`null` 等占位值时，不生成物理合并键，只按 `feishuRecordId` 精确匹配，宁可重复也不误合并。
- 飞书表删除、下架、关闭、已租等状态会让对应公司房源自动下架，进入后台资产池。
- 飞书 `标签`/`房源特点`/`特点` 列的自由文本会作为 `rawFeatures` 参与服务端自动特色推断；真正写入 `listing.features` 的只有白名单特色。示例：`南北通透` 推断为 `采光好`，`独立卫生间` 推断为 `独卫`，`阁楼/露台/花园` 统一推断为 `带露台（阁楼）`；`无燃气`、`不通煤气`、`非近地铁` 这类否定表达不得误打标签。
- 素材缺失、素材下载超时、OSS 转存失败或素材超过当前视频大小上限时，飞书房源不会被静默丢弃，会照常上架并在后台标记 `missingVideoMaterial=true`、`缺视频素材`/`素材转存失败`，同时保留 `videoMaterialFailureReason` 供对账。
- 公司房源即使缺视频，也可进入公司房源专区、全部房源列表、首页推荐、筛选、统计与地图；地图小区聚合和套数统计纳入缺视频公司房源，但 callout 与侧边卡片不显示视频标签，详情页也不展示视频区。二房东房源、业主房源仍必须带真实视频。
- 管理后台房源列表支持 `missingVideoMaterial=missing|ready` 查询，页面里可直接筛“缺视频素材”。
- `server/scripts/feishu-sync-audit.js` 可只读 dry-run 输出逐行对账表：房号、表内状态、匹配素材、同步结果、失败原因。
- 定时同步使用系统任务名触发时，服务端会自动落到库里的真实管理员身份执行新增/更新，避免新增公司房源因 `system-feishu-sync` 不是用户账号而失败。
- `户型描述` 以 `（整）` 或 `(整)` 开头时解析为整租，并去掉前缀保存净户型；否则按合租处理。
- 板块到行政区映射由服务端配置决定：闸弄口、新塘、元宝塘、东站归上城区，其余现有板块归拱墅区；命中 `communityLocationOverrides` 的小区（如小洋坝家园、大华海派风景、风雅乐府、瑷颐湾等）优先固定为余杭区/城北万象城。

常用飞书环境变量：

```env
FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_SHEET_URL=
FEISHU_SHEET_TOKEN=
FEISHU_SHEET_ID=
FEISHU_SHEET_RANGE=A1:ZZ1000
FEISHU_BITABLE_APP_TOKEN=
FEISHU_BITABLE_TABLE_ID=
FEISHU_MATERIAL_FOLDER_TOKEN=
FEISHU_UPLOAD_TO_OSS=true
FEISHU_MATERIAL_TRANSFER_TIMEOUT_MS=120000
FEISHU_MATERIAL_TRANSFER_RETRY_COUNT=2
FEISHU_MATERIAL_TRANSFER_RETRY_DELAY_MS=800
FEISHU_SYNC_INTERVAL_MINUTES=60
```

小程序端不接触飞书密钥、OSS AccessKey 或 RAM 权限。

## OSS 与上传策略

小程序端通过后端获取上传策略：

```http
POST /mini/uploads/video-policy
POST /mini/uploads/showing-photo-policy
```

历史群截图上传策略默认被 V1 历史路由拦截，不作为第一版入口。

常用 OSS 环境变量：

```env
ALI_OSS_BUCKET=
ALI_OSS_REGION=oss-cn-beijing
ALI_OSS_ACCESS_KEY_ID=
ALI_OSS_ACCESS_KEY_SECRET=
ALI_OSS_SECURITY_TOKEN=
ALI_OSS_PUBLIC_BASE_URL=
ALI_OSS_UPLOAD_DIR=house-videos
ALI_OSS_MAX_VIDEO_MB=300
ALI_OSS_POLICY_EXPIRE_SECONDS=900
ALI_OSS_READ_URL_EXPIRE_SECONDS=900
```

不要把 AccessKey、Token、私钥或 `.env` 写入仓库。

## 管理后台

后台入口：

```text
https://zf-api.ynzyqbot.cn/admin-web/
```

后台登录：

```http
POST /admin/auth/login
```

除登录外，`/admin/*` 都需要：

```http
Authorization: Bearer <admin-token>
```

后台 token 由 `ADMIN_TOKEN_SECRET` 签发，有效期 8 小时。生产环境（`NODE_ENV=production`）必须显式配置 `ADMIN_TOKEN_SECRET`，否则服务拒绝签发/校验后台 token 并返回 `503`；未配置时不再回退到内置开发密钥，避免任何读过源码的人伪造管理员 token 越权。

后台账号按 `permission` 分级。只有 `全部后台权限` 可以执行高危写操作：整库导出、管理员账号创建/禁用/改密、飞书同步回写、全局 LLM 配置、房态维护规则、房源编辑（租金、联系方式、来源/公司标记、上下架）、资产池恢复、坐标修正、房态核验、房源审核、带看/群素材审核、成交确认、充值审核或同步等。`区域查看权限`、`后台查看权限` 只能查看后台数据，不得改写业务状态。

常用管理接口：

- `GET /admin/dashboard`
- `GET /admin/launch-check`
- `GET /admin/env-template`
- `GET /admin/listings`
- `GET /admin/expired-listings`
- `POST /admin/expired-listings/:id/restore`
- `GET /admin/footprints`
- `GET /admin/reports`
- `GET /admin/deals`
- `POST /admin/deals/:id/confirm`
- `GET /admin/data/export`

`/admin/env-template` 只返回缺失环境变量模板，不返回 Secret 明文。

## 历史接口与充值/支付配置

`V1_DISABLE_LEGACY_ROUTES` 默认开启：

```env
V1_DISABLE_LEGACY_ROUTES=1
```

未显式设置时也等同开启。开启后，以下历史接口默认返回 `404`：

- `POST /mini/points/recharge`
- `GET /mini/groups`
- `/mini/groups/*`
- `POST /mini/uploads/group-screenshot-policy`

充值、积分、房源群、换群、微信群截图审核、微信支付相关代码均为历史预留，第一版不生效。相关后台接口和配置只用于保留历史数据或后续版本，不作为当前验收入口。

需注意：微信支付回调 `POST /wechat/pay/notify` 仍保留在路由表中，**不受 `V1_DISABLE_LEGACY_ROUTES` 拦截**。它依赖 `wxpay.js` 的签名校验：未配置支付证书/公钥时校验直接抛错拒绝，且 V1 下充值入口已被拦截、不会产生微信账单，因此实际不可被利用；但若生产 `.env` 残留支付密钥需留意。后续如需与"统一下线"承诺严格对齐，可让该路由同样受 `disableLegacyRoutes` 控制（V1 下直接 404）。

历史预留配置示例：

```env
RECHARGE_PAYMENT_MODE=manual
WECHAT_APP_ID=
WECHAT_APP_SECRET=
WECHAT_PAY_MCH_ID=
WECHAT_PAY_API_V3_KEY=
WECHAT_PAY_CERT_SERIAL_NO=
WECHAT_PAY_PRIVATE_KEY_PATH=
WECHAT_PAY_PLATFORM_CERT_PATH=
WECHAT_PAY_PLATFORM_CERT_SERIAL_NO=
WECHAT_PAY_NOTIFY_URL=
```

即使切到 `RECHARGE_PAYMENT_MODE=wechat`，也不代表第一版开放微信支付入口；必须先关闭历史路由拦截并完成单独验收。

## LLM 与助手

小程序找房助手入口：

```http
POST /mini/assistant/chat
POST /mini/llm/match
POST /mini/asr/transcribe
WS   /mini/asr/realtime
POST /mini/assistant/feedback
```

找房结果页提交反馈时使用严格契约 `feedbackVersion=match-result-v1`。请求必须带当前登录中介自己的 `needId`、服务端返回的 `threadId`、当前结果的服务端 `feedbackMessageId`（提交字段仍名为 `messageId`）、`feedbackType`（仅 `helpful` / `bad_recommendation`）与固定 `reasonCode`。`feedbackMessageId` 就是该次结果已持久化的 trace ID，不使用客户端页面消息 ID。原因码按有用性分组：

- 有用：`price`、`location`、`layout`、`availability`、`result_count`。
- 没用：`price`、`location`、`layout`、`availability`、`too_few`、`too_many`。

服务端只按对象自有键读取原因白名单并生成固定中文标签，不接收自由文本原因；`needId` 缺失、需求不存在、需求不属于当前中介、`messageId + threadId + 当前用户 + needId` 不能精确命中同一条持久结果 trace、反馈版本不精确匹配或原因码与有用性不匹配时分别按边界返回 4xx。结果 trace 的 `feedbackNeedId` 只来自服务端对持久需求存在性和归属的校验，不采信客户端 `needTemporary`。同一用户 + 服务端结果 `messageId` 的相同需求/反馈重复提交幂等返回原记录，任一关联或分类冲突返回 `409`。

`match-result-v1` 记录只保留 `needId`、服务端结果 `messageId`、有用性、固定原因码/标签和从该精确本人 trace 压缩出的最小元数据（版本、事件数、时间、节点名）；不保存客户端 `threadId`。后台查看完整对话时按服务端结果 ID 反查真实 trace/thread，并继续限制为反馈所属用户。客户端即使额外提交姓名、电话、地址、原始需求、助手回复、房源、期望或地点对象也全部丢弃。后台可流转严格反馈状态，但不能改写用户提交的类型/原因，也不向严格记录追加自由备注、处理结论或期望对象。兼容旧通道仅限请求体完全没有 `feedbackVersion` 属性；显式空白、`null`、数字、布尔值和任何未知版本全部拒绝，不得降级写入自由文本。旧通用反馈仍按最新 200 条保留，结构化找房反馈不受该滚动上限淘汰，以保证持久幂等与冲突保护；已成功写入的反馈即使原结果 trace 后续被 500 条上限滚动清理，相同重试仍返回原记录、冲突仍返回 `409`。严格反馈本身没有原始问题文本，提升评估集时必须由管理员明确提供经过脱敏的评估文本，不能把固定原因标签当作评估问题。

登录中介通过 `/mini/assistant/chat` 提交的 `needId` 只有经服务端确认属于本人持久需求时，响应才返回 `feedbackMessageId`；确认需求后调用 `/mini/llm/match` 同样由服务端查库验证，验证成功才写入带 `feedbackNeedId` 的结果 trace 并返回关联 ID。不存在、临时、他人需求、游客和识别阶段均不返回结果 ID；即使客户端伪造 `needTemporary=false` 也不能改变签发结论。

游客请求会被限制在公司房源数据集内；登录中介可匹配全部当前可见有效房源。
生产服务会为 `POST /mini/llm/match` 和 `POST /mini/assistant/chat` 记录一行耗时日志，格式包含 `status`、`durationMs` 和 `guest`；助手对话还会记录 `degraded`，用于确认真机登录态是否到达后端。日志不记录请求正文、手机号、地址或房源敏感字段。
`/mini/llm/match` 与 `/mini/assistant/chat` 的客户端超时都单独放宽到 60 秒；服务端调用 LLM 供应商时使用 20 秒 provider 级超时。供应商超时、报错或密钥缺失时，接口返回本地真实房源匹配结果并带 `degraded=true`、`degradedNotice=智能解读稍后重试`，前端正常渲染卡片并只显示小字提示，不把供应商失败误报成“网络连接失败”。
`/mini/assistant/chat` 额外有入口级兜底超时，默认 `24` 秒，可用 `ASSISTANT_CHAT_FALLBACK_TIMEOUT_MS` 覆盖；触发时走同一套本地真实房源匹配，不返回 mock。
找房助手意图路由遵循精确优先：明确业务问题仍进入 FAQ；生活化找房诉求（如安静、安全、带娃上学、女生居住）和带上一轮找房条件的续问/指代（如换一套、便宜点、刚才那套的位置）进入找房图，由后续置信门追问或匹配，不能直接落到 FAQ 套话。
`GET /admin/launch-check` 会检查当前 `llmConfig.secretName` 对应的服务端环境变量是否存在；缺失时明示变量名，不返回密钥值。

模型密钥只从服务端环境变量读取：

```env
LLM_API_KEY=
DEEPSEEK_API_KEY=
QWEN_API_KEY=
ZHIPU_API_KEY=
ASR_API_KEY=
DASHSCOPE_API_KEY=
```

实时语音走 WebSocket：小程序连接 `wss://<域名>/mini/asr/realtime`，后端 `server/src/asr-realtime.js` 监听 HTTP `upgrade` 事件代理到 ASR 服务。密钥依次从 `ASR_API_KEY`、`DASHSCOPE_API_KEY`、`LLM_API_KEY` 读取；可选 `ASR_REALTIME_MODEL`、`ASR_REALTIME_URL`（或 `DASHSCOPE_ASR_REALTIME_URL`）覆盖模型与网关地址。生产 Nginx 必须为 `location = /mini/asr/realtime` 转发 `Upgrade`/`Connection` 头（见 `deploy/nginx-zf-api-miniapp.conf`）。

后台可查看和测试 LLM 配置：

```http
GET /admin/llm-config
PUT /admin/llm-config
POST /admin/llm-config/test
```

## 上线自检

V1 上线自检不再推荐 `npm run smoke`。`server/scripts/smoke-test.js` 是历史综合冒烟脚本，会创建、审核并清理临时业务数据，仍保留但不要作为当前 V1 验收主线。脚本不再提供地址、后台账号或密码默认值；手工运行前必须只在当前终端/受控执行环境注入 `SMOKE_BASE_URL`、`SMOKE_ADMIN_ACCOUNT`、`SMOKE_ADMIN_PASSWORD`，缺任一项都会在读取数据或发出网络请求前退出。不得把这些值写入仓库、命令历史、协作文档或聊天输出。

PowerShell 7 可在当前进程临时设置变量后运行；以下只展示变量名，不提供任何示例凭据值：

```powershell
$env:SMOKE_BASE_URL = Read-Host 'SMOKE_BASE_URL'
$env:SMOKE_ADMIN_ACCOUNT = Read-Host 'SMOKE_ADMIN_ACCOUNT'
$env:SMOKE_ADMIN_PASSWORD = Read-Host 'SMOKE_ADMIN_PASSWORD' -MaskInput
node scripts/smoke-test.js
Remove-Item Env:SMOKE_BASE_URL, Env:SMOKE_ADMIN_ACCOUNT, Env:SMOKE_ADMIN_PASSWORD -ErrorAction SilentlyContinue
```

当前 V1 验收脚本为以下八个：

```bash
cd server
node scripts/map-v1-test.js
node scripts/assistant-v1-test.js
node scripts/backend-contract-v1-test.js
node scripts/guest-mode-v1-test.js
node scripts/auth-token-v1-test.js
node scripts/mini-login-password-v1-test.js
node scripts/mini-token-revocation-v1-test.js
node scripts/mini-pending-no-data-v1-test.js
```

其中覆盖：

- 地图真实坐标与敏感字段边界。
- 助手需求解析与匹配。
- 后端合同规则：视频、分佣、筛选、公司房源可见性、特点标签、报备/签单。
- 游客模式：匿名公司房源可见、合作房源详情 `401`。
- Bearer token 鉴权、7 天有效期、伪造 `X-User-Id`/篡改 payload/换密钥重签无效。
- 小程序账号密码登录：正确/错误/缺密/存量无密码/待审核/软删登录口径、`passwordHash` 不外泄、DB 只存 scrypt 哈希、后台设初始密码后可登录；显式 `userId` 绑定的管理账号创建/改密会单向同步小程序密码，未绑定账号不按手机号串绑。
- 改密会话撤销：存量无版本 token 平滑兼容；自助改密后当前设备换发新 token、其他旧会话立即 `401`；管理员重置后全部旧会话失效；`tokenVersion` 不向客户端泄露。
- 待审核/无密码账号拿不到任何 token，无 token 拿不到 `/mini` 数据（公司房源匿名可见口径不变）。

找房助手另有真实需求行为基线：

```bash
cd server
node scripts/assistant-real-need-baseline-test.js
```

该脚本用 16 条真实口语需求锁定精确优先下的行为准星：标准需求应推荐，字段不足或地点歧义应追问，生活化找房诉求与多轮续问不能落到 FAQ，业务/地图使用问题仍保留 FAQ。

房源特色自动打标基线：

```bash
cd server
node scripts/listing-auto-feature-test.js
```

该脚本锁定上传/飞书同步入库时的特色推断：正向自由文本应持久化为白名单特色，否定表达不误打，人工明确选择“无”时不被自动推断覆盖，非白名单自由词不得进入 `listing.features`。

可选汇总审计脚本：

```bash
cd server
node scripts/v1-final-audit.js
```

该脚本会检查关键 V1 脚本存在并运行其中的核心脚本，同时确认 `server/scripts/smoke-test.js` 的三项运行配置仅来自环境变量、缺失时 fail-closed，并执行不会连接真实服务的环境变量门禁测试。

## 部署包与提交红线

部署包脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-deploy.ps1
```

部署包应排除：

- `server/.env`
- `server/data/`
- `server/certs/`
- 飞书本地参数文件
- 私钥、证书、Token、Secret

提交红线：

- 不提交 `.env`、密钥、证书、生产数据。
- `server/scripts/smoke-test.js` 只允许在用户明确授权后做范围受控的安全修复；不得重新加入地址、账号、密码或其他凭据默认值。
- 不把客户端字段当作分佣、上传人或登录身份的可信来源。
- 不在日志中输出完整客户手机号、房东电话、微信号或身份证信息。
