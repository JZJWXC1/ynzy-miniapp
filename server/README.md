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

需求转化漏斗（`server/src/need-funnel.js` + `server/scripts/metric-readout.js`）：持久需求的 `funnel` 对象仍兼容读取首次推荐、历史 L1 敏感查看、历史 L2 报备、审核通过带看、历史 L3 成交提交与确认时间，不保存客户、房源、地址或自由文本。M3 起新的敏感查看不再绑定 `needId`、不再制造 L1；报备/签单写入默认暂停，因此不会新增 L2/L3。带看仍可选提交本人持久 `needId`，由服务端验归属后再计漏斗。历史显式恢复模式下，报备/成交仍沿用服务端可信归因与首次时间幂等规则。

- 历史指标 `fillL2_reportPct`：有可信报备的需求数 / 持久需求总数；暂停期只反映存量，不代表当前活动入口。
- 首次有效推荐耗时：需求创建到首个“绑定同一需求且实际返回房源”的持久 trace，输出 P50/P95 分钟和可测样本数。
- 带看率 `showingRatePct`：有审核通过带看的需求数 / 历史已报备需求数；待审核或驳回照片不计。
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
- `favorites`：内部中介账号与房源的最小收藏关系。
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
  - 校验 JSON 可解析，输出 `listings/users/reports/deals/commissionRecords/footprints/favorites` 七项数量。
  - **往返一致性校验**：恢复出的七项数量必须与备份时刻记录的源数量逐项相等，任一不符即判失败。
  - 顺带做**新鲜度巡检**：最近一份备份超过 `BACKUP_MAX_AGE_HOURS`（默认 24h）即告警。
  - 说明：`reports`/`deals` 对应库内真实键 `clientReports`/`dealRecords`，计数已按真实键统计。
  - 计数版本：新备份写入 `countsVersion=2` 并显式记录七项；缺项、非法计数或未知版本均 fail-loud。M7 之前的备份正文和整库 SHA 已覆盖 `favorites`，但 `meta.counts` 尚未单列该项；只允许无计数版本且整库 SHA 有效、匹配的真实旧格式缺省这一项，原六项仍逐项校验。

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

流程：取 tenant_access_token → 列云盘文件夹 → 按文件名时间戳选最新 `.ygbak` → 以二进制下载到临时目录 → 调 `restoreDrill` 解密校验。下载的是加密 `.ygbak`；解密只到临时目录、用完即清，不残留明文，也不写回生产。输出 `listings/users/reports/deals/commissionRecords/footprints/favorites` 的「备份时刻 vs 恢复出」逐项计数，逐项相等即通过；任一步失败（缺凭据/无备份/下载失败/解密失败/数量不符）非零退出。

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

#### 告警条件（均输出明确记录；仅下述“非空自愈”可继续成功）

- `BACKUP_FAILED`：读源/加密/写盘失败。
- `BACKUP_VERIFY_FAILED`：新备份即时自检不过（已删除坏备份）。
- `BACKUP_EMPTY_SOURCE`：跨备份计数回归——本次备份七项计数全为 0 但上一份备份仍有数据，疑似源被截断/读空（已删除该空备份并判失败）。上一份为 M7 前旧格式时，会先验证其整库 SHA，再从完整正文重算七项，避免旧元数据漏掉收藏。
- `BACKUP_BASELINE_UNREADABLE`：上一份最新历史备份因密钥轮换、密文损坏、信封畸形或整库 SHA 不一致而无法作为可信基线。若本次七项全空，会在异地上传前删除本次空备份并判失败；若本次明确非空且已通过即时自检，则保留告警并允许上传，以建立新的可读密钥链基线。告警只记录文件名与汇总计数，不输出密钥或解密错误正文。
- `BACKUP_REMOTE_REQUIRED`：未配置 `BACKUP_REMOTE_CMD` 且未显式 `BACKUP_ALLOW_LOCAL_ONLY=1`，未达成异地目标（本地可信备份已保留，但本轮判失败）。
- `REMOTE_UPLOAD_FAILED`：异地上传命令失败。
- `RESTORE_MISMATCH`：恢复演练往返数量不符。
- `RESTORE_FAILED`：演练解密/解析失败或无备份可演练。
- `BACKUP_STALE`：最近一次备份超过 `BACKUP_MAX_AGE_HOURS`。

上述条件均有锁定测试：`server/scripts/backup-restore-v1-test.js`。除 `BACKUP_BASELINE_UNREADABLE` 的“当前非空自愈”分支外，阻断条件均令 CLI 非零退出。

足迹留痕不再按行数截断。所有新写入严格收敛为 `{id, viewerId, listingId, actionType, occurredAt, idempotencyKey}` 六字段；中介接口只返回最近 7 天，后台返回最近 90 天。可解析且超过 90 天的记录会在数据库写锁内物理清理；无过期记录时读取不触发整库写盘。无法解析时间的存量旧记录不做破坏性猜测：中介接口不下发，后台保守可读且不自动删除，后续只能通过受控迁移处理。旧 `FOOTPRINT_MAX_ROWS` 环境变量已失效，不得再用数量上限提前删除 90 天内审计证据。

数据库 JSON 默认紧凑写入以降低整库重写的磁盘写放大；如需人工排查可设置 `DB_JSON_PRETTY=1` 恢复两空格缩进（`/admin/data/export` 导出始终为美化格式，不受影响）。

**并发写保护（P0-2）**：`server/src/db.js` 的写路径（`updateDb`/`writeDb`）加了一层零依赖的**跨进程 advisory 写锁**（同机 `db.json.lock` 文件锁），防止服务器与运维脚本（如 `backfill-listing-districts.js`、`geocode-listing-communities.js`）同时写库时后写覆盖先写、丢数据。单进程内 `updateDb` 本就被事件循环串行化、锁几乎无争用；锁持有仅毫秒级。锁按「持有者进程存活探测」回收陈旧锁（持有者存活绝不误删活锁），获取有界超时（拿不到就抛错、绝不死锁或无限自旋），并对 Windows 瞬时 `EPERM`/`EBUSY` 做重试。相关环境变量（一般无需设置）：`DB_WRITE_LOCK`（默认开；置 `0`/`off` 紧急退回无锁旧行为）、`DB_LOCK_TIMEOUT_MS`（默认 10000）、`DB_LOCK_STALE_MS`（默认 30000）。**生产不得关闭 `DB_WRITE_LOCK`**：M6 的账号停用/退出与在途写、外部签名能力复验也依赖同一把锁完成跨进程线性化；关闭只允许作为明确知晓风险的短时应急退化。锁定测试：`server/scripts/db-write-lock-v1-test.js`。飞书同步这类「clone→长 await→落盘」路径仍由 `commitDelta` 的三方合并处理 await 窗口内的并发（与本锁互补）。

游客限流按客户端 IP 分桶。`TRUST_PROXY` 默认开启，表示服务部署在 nginx 等可信反向代理之后，取 `X-Forwarded-For` 末段（由代理追加、客户端无法伪造）作为真实 IP；若直连暴露（无反向代理）务必设 `TRUST_PROXY=0`，改用 socket 远端地址，避免客户端伪造 XFF 绕过限流。

## 小程序端鉴权

小程序登录接口（账号密码制）：

```http
POST /mini/auth/login      body: { phone, password }
POST /mini/auth/register   body: { name, phone, password }
POST /mini/auth/password   body: { oldPassword, newPassword }  # 需 Bearer
POST /mini/auth/logout     body: {}                              # 需 Bearer，撤销全部设备
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

token 采用 **30 天滑动有效期**。服务端用 HMAC-SHA256 校验 token，过期、签名错误、用户不存在、已删除或被禁用都会返回 `401`。携有效 Bearer 的成功 `2xx JSON` 或语音 multipart 响应会返回 `X-Auth-Token` 与 `X-Auth-Token-Expires-At`（epoch ms），把到期时间顺延到服务端当前时间后 30 天；所有 `/mini/auth/*` 响应及任何携 Authorization 的响应（成功或错误）都返回 `Cache-Control: no-store`、`Vary: Authorization`，续签头通过 `Access-Control-Expose-Headers` 暴露。游客、业务错误和鉴权错误不续签；登录与改密仍在 body 返回 token，退出响应明确不续签。旧客户端忽略新响应头仍可工作，但不会获得滑动延长。

客户端只在“请求实际发送的 token 仍是当前 token、稳定会话键未变化、到期时间合法且单调前移”时通过 App 的事务式方法替换本地 token；任一存储键写失败会回滚，API 层缺少该原子方法时直接拒绝续签。A 请求迟到时不能覆盖 B、退出或改密后的会话；旧 A 的 401 仅允许幂等 GET 用当前 A′ 自动重试一次，POST/上传写不自动重放。稳定会话键仅用于本机异步结果隔离，绝不作为服务端身份、维护人、权限或分佣依据。启动时明确已过期/畸形 expiry 的本地 token 会先清除；缺 expiry 的历史 token 保留并交给服务端兼容验证。

token 还签入账号级 `tokenVersion`：`POST /mini/auth/logout`、用户自助改密、管理员重置密码、小程序账号首次停用和软删都会递增版本并撤销旧 token。当前无设备级 `sid`，因此主动退出的明确语义是**该账号所有设备一起退出**；恢复停用账号不会回退版本，旧 token 不能复活。改密成功仅向当前设备返回新版本 token；其他设备需重新登录。上线前签发、未携带版本号的存量 token 按版本 0 兼容，直到账号首次发生撤销事件。`tokenVersion` 只保存在服务端 DB 与签名载荷，不作为用户资料字段下发。

小程序中介/员工停用与后台管理员账号停用是两套接口：`POST /admin/users/:id/status { action: "enable"|"disable" }` 只允许超级管理员操作；请求体中的 `userId`、角色或权限字段不会改变目标。小程序账号与后台账号的创建、停用、改密、删除及注册审核统一通过 `updateAdminDb` 在写锁内重新验证最新管理员身份/权限，管理员在请求在途时被停用或降权会零副作用拒绝。所有登录态数据库写统一通过 `updateMiniDb` 在 DB 写锁内从最新磁盘重新验签，避免请求通过锁外初验后，账号已退出/停用仍继续落库；外部签名或付费能力在真正调用前通过 `inspectDb` 同锁只读复验，不为纯鉴权制造整库写盘。

三类 OSS 直传策略（视频、群截图、带看照片）的对象键只由服务端随机生成，HTTP 请求中的 `objectKey` 一律忽略；签名 policy 精确绑定这一个 key，不再只限制目录前缀，防止已登录客户端把 multipart `key` 改成同目录的已知对象并覆盖他人素材。

`X-User-Id` 已废除，不能再作为鉴权来源。当前鉴权测试覆盖了伪造 `X-User-Id`、退出 body 中伪造 `userId/tokenVersion/role/permission`、篡改 payload 沿用旧签名、换错误密钥重签的场景：无 token 访问需登录接口返回 `401`；有合法 token 时，服务端只以验签身份和当前数据库账号状态为准。

游客模式边界：

- 匿名用户可以在首页、列表、地图、附近推荐和助手中浏览全部当前有效的公司、业主、二房东房源卡片，也可以打开三类房源详情并播放、转发或保存详情视频。
- 公司房源对匿名与登录中介继续公开房号、完整地址、看房方式密码、备注等既有公司公开字段；联系方式是唯一例外，只能公开服务器 `COMPANY_CONTACT_PHONES` 配置的统一号码，飞书或房源原文中的手机号、座机、邮箱、社交账号、私聊链接均不得下发。
- 业主、二房东房源的公开层只下发城市、区域、板块、小区和非敏感房源信息；楼栋、单元、房号、完整地址、房东电话、看房方式、钥匙位置、密码和敏感备注一律不在游客 DTO 中出现。
- 公共层不只按字段名删除，还对所有可展示/搜索字符串执行同一套值级投影：全角、中文/金融数字、零宽/组合字符、emoji、任意标点、字母或汉字拆分的电话与结构化精确地址都不能夹带到标题、板块、小区、户型、标签、地图、附近、收藏、匹配、LLM 或飞书公开快照。裸 `t.me` / `wa.me` 等私聊域名、社交别名、邮箱，以及希腊/西里尔同形字伪装的 phone/contact/微信/Telegram 标识同样清除；中文十百千乘位写法的楼栋、单元、房号不能留下可拼回的残片。清洗会保留完整的合法数字业务 token（如板块、地铁、分钟、公交、户型、面积、年份和租金）及“手机信号好”“密码保护 WiFi”等正常设施文案，但不能用长数字尾部伪装成短地铁号；只有服务端小区词库精确命中的 `address===community` 存量值可按小区名公开，审核或坐标标记不能自我白名单未知完整地址。
- 公开租金必须是 `0–1000000` 的有限数字，并额外拒绝手机号、座机、400 电话形状；这只防守历史脏值进入公开 DTO，不改变数据库、不从客户端推断身份或佣金。Mock 与真实接口使用相同口径。
- 匿名列表/地图仍精确执行来源筛选：选择“全部”返回三类有效房源并集，选择公司、业主或二房东时只返回对应互斥来源，禁止用展示文案猜来源或把一种房源伪装成另一种。
- 合作房源敏感信息必须由有效账号发起二次确认，并经过每日额度和服务端留痕后单独返回；不再要求需求单或查看用途。客户端提交的身份、角色、维护人、权限或敏感投影字段均不能放宽该边界。
- 游客播放、转发和保存房源视频不要求登录；匿名客户端不调用受保护的视频转发留痕接口。收藏、拨号、带看、敏感查看及其他写操作仍强制登录。
- 上传、我的房源、需求单、分佣、足迹、视频上传策略等活动接口仍强制登录。报备/签单历史查询需要登录，但新增报备、从报备签单、直接签单和管理员确认均默认暂停。

## 房源类型、视频与可见性

房源分为：

- 公司房源：公司自营或飞书同步房源，优先信任公司专用真值 `companyListing/isCompanyListing`、通用真值 `companyOwned`，或 canonical `source/sourceType/listingType/inventoryType` 中的“公司房源/company”。公司专用字段继续兼容 `true/1/yes/y/是/公司/公司房源`，但字符串 `false/0/no` 不是真值；命中公司后不再进入合作来源筛选。仅有 `ownerType/houseSourceType/sourceLabel` 的“公司”文字不能提升公司权限。
- 业主房源：非公司房源按既有 `ownerType || houseSourceType || source` 顺序取第一个非空 canonical 字段，规范化结果为“业主房源”时归入本类。
- 二房东房源：同一第一个非空字段规范化为“二房东房源”时归入本类；该字段非法或三个字段都缺失的非公司存量房源按既有默认归入二房东。派生展示字段 `sourceType/category/sourceLabel` 不得把畸形记录提升为业主审核、额度或分佣口径。

三类来源由服务端计算为单一结果，必须互斥且并集覆盖全部当前有效房源；列表、地图、收藏、Mock 和客户端展示沿用同一口径。标题、描述、小区名、户型等展示文字不参与归类；存量公司房源若误带 `ownerType=业主房源`，读库迁移会纠正为公司房源。客户端提交的来源字段不能改变上传权限或把合作房源升级为公司房源。

旧版迁移若曾在 `companyListing/isCompanyListing` 为字符串假值时运行，可能已经覆写原始来源，且现有字段无法无损判断原本是业主还是二房东。发布前必须在目标数据文件所在环境运行 `node scripts/listing-source-integrity-audit.js`：脚本只读取数据库并输出总数与可疑签名数量，不输出房源 ID、电话或地址；缺文件、读取失败、空文件、非法 JSON、`listings` 非数组分别返回 `FILE_NOT_FOUND`、`READ_ERROR`、`EMPTY_FILE`、`INVALID_JSON`、`INVALID_LISTINGS`，并用 `readable/parseable/structureValid` 明确区分阶段。任一结构错误或可疑数量大于 0 均以退出码 `2` 停止发布，必须结合迁移前备份或飞书等可靠外部来源单独裁决，禁止自动猜测改库。

视频规则：

- 公司房源免视频，允许无视频进入公司房源列表和详情。
- 二房东房源、业主房源必须带真实视频，`videoUrl` 或 `videoKey` 至少有一个。
- 视频文件本体不进 `db.json`；房源只持久化受控目录内的 `videoKey`，并兼容读取可还原为同一受控对象键的历史 OSS 源 URL。
- 当前有效房源的公开 DTO 只返回 API 域不透明能力地址，默认有效 6 小时；地址不包含 OSS 对象键、历史文件名、AccessKey 或 OSS 签名参数。`GET /mini/listings/:id/media/:kind` 支持 `GET`、`HEAD` 和单段 `Range`，每次请求都重新核对房源仍为前台有效状态，再由服务端生成默认 900 秒的 OSS 短签名并限长流式转发。媒体源只允许配置中的精确 OSS origin 和受控上传目录，不跟随重定向；重复房源 ID 无法唯一解析时 fail-closed。代理默认全局最多 24 路、同一可信客户端最多 6 路，客户端断开、上游 abort/error、超时及正常结束都必须主动销毁上游并只释放一次名额，避免单个来源占满全局并发。
- 上传人通过受保护的“我的房源”接口查看本人待审核/暂不可公开房源时，服务端签发独立 `owner` scope 的短时能力 URL。该令牌同时绑定服务端验签账号、房源、媒体对象和当前审核/维护状态；URL 不明文携带账号或状态，不能跨账号、降级成公共令牌或在房态/媒体变化后继续使用。微信原生 `image/video` 读取已签 URL 时无需再附 Authorization，但 URL 只能由可信本人接口取得。
- 当前有效合作房源视频属于公开推广素材，游客可直接播放、转发或保存。播放器 `binderror`、保存视频收到 `401/403/404` 时只允许匿名刷新详情并重试一次，禁止循环；保存下载超时为 300 秒。转发留痕仍只接受已登录账号，留痕失败不得造成视频重复发送。含能力地址的列表/详情 JSON 与媒体响应均禁止共享缓存。
- 小程序 `request` 与 `downloadFile` 域名必须同时配置为合法 HTTPS 且与 API 严格同源（不得含 URL 用户名/密码），并在微信后台将同一 API 域加入 request、downloadFile 与 video 媒体合法域名。发布前在目标数据环境运行 `node scripts/listing-media-readiness-audit.js`；脚本只输出计数和不可逆短指纹，任一前台视频无法解析为受控对象键时退出 `2` 并阻止发布。
- 手机拍摄的 MP4 可能实际使用 HEVC/H.265；Chrome/Edge 无法解码时，后台审核页会在原播放器报错后自动调用管理员鉴权接口，按需转为 H.264/yuv420p + AAC，再以 Blob URL 回填播放器。原 OSS 对象和房源记录保持不变；兼容接口只读取服务端持久且符合 `ALI_OSS_UPLOAD_DIR` 前缀/安全格式的 `videoKey`，不接受客户端提交 URL/Key。

房源可见性：

- 前台有效房源会排除已失效、已下架、已成交和待审核未通过房源。
- 公司房源公开完整地址、看房方式和服务器 `COMPANY_CONTACT_PHONES` 中全部合法 11 位号码；当前页面逐项展示这些统一号码，不显示“联系房东”按钮。`companyContactPhoneText` / `landlordPhone` 仍只保留首个合法号码供旧客户端兼容，未配置合法号码时返回空值且不回退房源原始联系方式。
- 公司公开字符串同样执行私号值级清洗，但服务器统一号码会在清洗前按独立数字边界保护并在清洗后恢复；即使统一号码紧邻四位房号、另一私号或座机，也必须完整保留统一号码并完整移除其他联系方式。
- 合作房源卡片与公开详情可显示城市、区域、板块、小区、户型、租金、特点、来源和视频，但不直接公开楼栋、单元、房号、完整地址、房东电话、看房方式、钥匙位置、密码或敏感备注；敏感查看必须登录并留痕。
- `GET /mini/listings/:id` 对游客开放当前有效三类房源。游客请求不存在或不可前台查看的合作房源统一返回泛化 `404`，不泄露房态、审核或同步元数据；登录用户仍可得到既有结构化失效态。无效 Bearer Token 返回 `401`，不会降级成游客。
- 地图只按小区聚合展示，不展示具体楼栋、单元、房号、房东电话或看房密码；合作房源游客响应使用小区级或降精度坐标，不下发精确房源坐标。

房态规则固定为第 3 天提醒、第 5 天再次提醒、第 7 天未更新自动失效。失效房源保留在后台资产池，可由管理员恢复。仍处于待审核的房源不能通过“未出租”或旧客户端缺省核验改成在租；服务端返回 `409` 且零写入，管理员也必须走审核接口。上传人仍可选择“已出租/不租了”把待审核房源撤下，原撤回通道不变。

## 分佣规则

分佣由服务端按当前配置计算，客户端提交的 `brokerId`、`uploaderId`、`commissionRate` 或同名字段不能影响结果。

现行规则使用两层比例，不能混用：房源 `landlordCommissionPercent` 表示“房东总佣金占成交月租比例”；后台分佣配置表示这笔总佣金在带看人、房源维护人和平台之间的拆分。

- 二房东/业主房源：维护人默认取得房东总佣金的 `20%`，平台默认 `10%`，带看人取得剩余 `70%`。例如房东总佣金为月租 `50%` 时，三方分别占月租 `10%`、`5%`、`35%`。
- 公司房源：带看人取得全部房东总佣金，维护人和平台均为 `0%`，不生成额外分佣记录。
- 自传自带：带看人与房源维护人是同一服务端账号时，带看人取得全部房东总佣金，不重复生成维护人分佣。
- 管理员维护的合作房源：管理员个人维护人比例固定为 `0%`，平台按配置取得默认 `10%`，带看人取得剩余部分。

`GET /mini/commission-config` 继续允许游客读取展示所需比例，但只返回业务字段白名单，不包含后台 `updatedBy/updatedAt` 审计元数据；游客按独立 IP 桶限制为每分钟 30 次。后台读取与修改仍只允许超级管理员。

写配置时，顶层请求与嵌套配置容器都必须是普通对象，并且至少出现一个受支持字段；比例只接受有限 number 或非空严格十进制数字字符串。`null`、空白、布尔、数组、对象、空对象、仅未知字段，以及顶层/别名/嵌套任一负数都明确返回 `400`，配置和足迹零变化。解析优先级固定为 canonical 字段 → 兼容别名 → 嵌套配置；合法的部分更新和显式 `0` 继续支持，“上传人 + 平台不得超过 100%”守恒门保持不变。Mock 使用同一容器、类型、优先级和守恒规则，避免预览假成功。

受支持 canonical 字段为 `secondLandlordRate`、`ownerRate`、`secondLandlordPlatformRate`、`ownerPlatformRate`；兼容上传人别名为 `secondLandlordUploaderRate`、`ownerUploaderRate`；嵌套字段为 `uploaderRates['二房东房源'|'业主房源']` 与 `platformRates['二房东房源'|'业主房源']`。其他字段不会被当成一次有效配置更新。

详情接口只返回服务端计算的 `commissionBreakdown`，不再返回详情旧字段 `uploader`、`commissionRate`、`commissionText`。当前报备/签单写入默认暂停；保留的显式恢复实现中，签单只能从报备记录发起，房东实付佣金由 `成交月租 × 房源 landlordCommissionPercent` 自动计算，并冻结比例、总金额、维护人/带看人身份、拆分规则和月租占比快照。客户端提交任何同名金额、身份、维护人或拆分字段都无效，金额统一按分存储。

历史签单只读列表与恢复确认使用同一冻结规则优先级：顶层 `deal.commissionRule` 存在时以它为准；顶层真正缺失才读取 `dealSnapshot.commissionRule`；两处都真正缺失的老记录才允许按当前房源配置回退。冻结字段只要存在但为 null、非对象、缺项或不守恒，列表不会逐字段拿当前配置补齐，而是保留原始规则、返回 `commissionIntegrity.reason=INVALID_COMMISSION_SNAPSHOT`，派生比例和预计金额均置空并显示“待复核”；确认写路径仍在任何状态/漏斗副作用前 fail-loud。比例只接受有限 number，历史兼容非空严格十进制数字字符串；null、空白、布尔、数组或对象不得借 JavaScript 强制转换伪装成 0%。后台快照摘要同样不得为异常行显示默认比例。

## 上传房源

小程序端上传房源使用：

```http
POST /mini/listings
PUT /mini/my/listings/:id
```

必填字段由服务端校验：城市、区域、小区、楼栋、房号、租金、户型和特点标签。非公司房源还必须有真实视频。`unit`（单元）与 `block`（板块/商圈）均可选：无单元楼栋允许留空；填写板块时会去除首尾空格后独立落库，不能用行政区值冒充板块，否则按板块筛选无法命中。

小区匹配与人工审核：服务端已知小区 = `server/src/community-library.js` 的 `GONGSHU_COMMUNITIES` 名单 ∪ `server/src/community-coordinates.js` 的坐标表键（归一化去重后的并集）。匹配判定以服务端 `isKnownCommunity` 复核为权威——普通中介新建房源或把小区改为库外名称时，服务端判未匹配并进入人工审核、审核通过后才上架；小区名未变且历史已匹配（含兼容字段推导）的存量房源沿用历史判定，不因编辑重新进入审核；普通调用方的库外「已匹配」声明不被采信，申报只允许收紧（可主动申请人工审核，不能豁免）；管理员显式提交 `requiresManualReview=false` 时可豁免人工审核。客户端联想库 `utils/gongshu-communities.js` 由 `node server/scripts/sync-client-community-library.js` 从服务端库自动生成，请勿手改；新增小区只改服务端名单或坐标表后重跑该脚本，两端一致性由 `server/scripts/community-library-parity-test.js` 锁定（客户端缺库内小区会导致编辑/上传被误转人工审核）。

内部员工上传免审：服务端数据库中账号类型确认为 `accountType=staff` 且角色口径一致，或存量角色为 `内部员工` 的非管理员用户，新建或本人编辑业主房源、二房东房源时直接写入 `reviewStatus=已通过`、`status=待确认`，并沿用 `reviewedAt`、`reviewerId`、`reviewNote` 记录“按员工权限自动通过”；即使小区未匹配，也不进入审核队列，但 `communityMatched=false`、`requiresManualReview=true` 和待补坐标事实必须保留，地图仍只按既有可靠坐标规则上图。管理员编辑该自动通过房源不会误退回待审。普通中介的业主房源、库外小区或其他人工审核路径不变；客户端提交的 `role`、`accountType`、`isAdmin`、`uploaderId`、`status`、`reviewStatus`、`reviewNote` 全部不能授予免审权限。该规则对员工新建和本人后续编辑生效，不在服务启动时批量改写历史待审核记录。

看房方式（`viewingMethod`）为选项字段：`钥匙` / `密码` / `联系房东`。业主、二房东房源在小程序、后台人工上传/编辑及三种看房方式下都必须提供合法 11 位房东手机号；钥匙方式额外必填 `viewingKeyLocation`，密码方式额外必填 `viewingPassword`，旧客户端不传看房方式也不能绕过。公司房源可不保存房东手机号，也可不上传视频，因为详情只展示服务器 `COMPANY_CONTACT_PHONES` 配置的三个统一号码；若公司房源显式填写手机号，仍必须是合法 11 位号码，且公开详情不会用它替代统一号码。飞书“公司统一维护”等占位不作为合法电话，无效值会丢弃，落库电话保持空并标记 `missingLandlordPhone=true`、`feishuContactStatus=待补充`。

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

公司房源列表和 `/mini/listings` 支持组合筛选。现行参数名以 `block` 为准，不再使用 `board`。来源筛选是精确枚举，不做拼接文字包含匹配；所有条件按 AND 组合。

常用参数：

| 参数 | 含义 | 示例 |
| --- | --- | --- |
| `district` | 行政区 | `拱墅区`、`上城区` |
| `block` | 板块/商圈 | `东新园`、`闸弄口` |
| `community` | 从官方小区联想中选择时按规范化名称精确匹配；未命中官方词库的自由文字仍兼容模糊匹配 | `长浜龙吟轩` |
| `category` | 列表来源分类 | `公司房源`、`业主房源`、`二房东房源` |
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

地图筛选复用区域、板块、小区、租金、户型和租赁方式等参数，并用 `sourceType` 精确筛选公司/业主/二房东来源，但只返回可靠小区坐标。从官方联想选择的小区在列表、收藏、地图、普通匹配和 LLM 助手中统一按规范化名称精确匹配，不能把“城发天地”扩大成“城发天地大厦”；未命中官方词库的自由文字搜索仍可模糊召回。从地图切回列表时会独立保留 `community` 与当前来源等筛选条件；游客公开字段投影与列表一致。

坐标分级（`verified`/`approximate`/`block-center` 三档，含板块中心兜底）与离线地理编码依赖腾讯位置服务：`QQ_MAP_WEBSERVICE_KEY`（兼容旧名 `QQ_MAP_KEY`）从环境变量读取，`server/scripts/geocode-listing-communities.js` 用它批量补小区坐标。

## 公司房源表快照

小程序端快照接口：

```http
GET /mini/company-sheet-snapshot
```

快照接口按飞书表头动态返回列，不再要求前端硬编码表头。后端会修正区域合并单元格的向下填充，并保证表头与数据行列数一致。当前公司房源快照不做游客双视图，匿名与登录中介看到同一份公司公开表，包含房号、`看房方式密码` 等公司公开字段；表头前简介行、动态联系电话列和其他数据行中的手机号会统一替换为 `COMPANY_CONTACT_PHONES` 中的合法号码，座机、邮箱、Telegram/WhatsApp/微信等社交账号、裸私聊域名和外链会清除，绝不下发飞书原始私联。响应只包含标题、更新时间、行列数据和脱敏标记，不包含飞书表 URL、sheet token、range、缓存时间或内部起始行列。公司房源详情把全部合法统一号码放入 `companyContactPhones` 并逐项展示；首号同时保留在旧客户端兼容字段中。未配置合法号码时返回空列表，不回退房源自身 `contact` / `landlordPhone`。

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
- 飞书行缺少合法联系电话时不再整行跳过：同步结果增加 `missingLandlordPhone` 计数，逐行对账和摘要写“联系电话待补充”，公开租金/房态继续创建或更新。服务端优先采用表内合法号码，其次保留线上已有合法号码；两者都没有时只保存空值和待补标记，绝不把占位文字或无效号码落库。该放宽仅存在于内部飞书同步调用，人工上传/编辑与旧客户端仍由领域校验强制 11 位手机号。
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
# 后台审核 HEVC 兼容预览（均可选；路径必须为绝对路径）
VIDEO_PREVIEW_FFMPEG_PATH=/usr/bin/ffmpeg
VIDEO_PREVIEW_MAX_CONCURRENT=1
VIDEO_PREVIEW_TIMEOUT_MS=300000
VIDEO_PREVIEW_MAX_DURATION_SECONDS=300
VIDEO_PREVIEW_MAX_OUTPUT_MB=200
# 仅当 Node 以 root 运行时，用于把 ffmpeg 子进程降权；不得配置为 0
VIDEO_PREVIEW_UID=65534
VIDEO_PREVIEW_GID=65534
```

不要把 AccessKey、Token、私钥或 `.env` 写入仓库。

兼容预览不把 OSS 签名 URL 放进浏览器地址、ffmpeg 参数或错误正文：Node 只允许 HTTPS、精确 OSS 主机和精确对象路径，拒绝重定向；源对象必须给出合法 `Content-Length`，完整下载时同时累计限长，并要求实际字节数与声明值精确一致。下载内容先进入随机 `0700` 目录内以 `wx` 创建的 `0600` 临时文件；写入关闭后只读打开，立即删除文件路径与空目录，只把匿名文件描述符继承为 ffmpeg 的 fd 3。这样既支持 `moov` 位于文件尾部、必须 seek 的普通手机 MP4，也不会把临时路径或签名地址暴露给子进程。

ffmpeg 只开放 `fd,pipe` 协议，固定用 `-fd 3 -f mov -i fd:` 读取上述匿名可寻址输入，输出仍走 `pipe:1`；输入解码器只允许 HEVC/H.264/AAC，且在解码前限制单帧不超过 4096×4096。子进程使用绝对路径、关闭 stdin、最小无密钥环境和非应用工作目录，Node 为 root 时自动降到非 root UID/GID。解码/编码线程、探测量、流数量、1920×1080 输出盒、30fps、码率、时长和输出字节均受限，响应明确 `Accept-Ranges: none`。

默认最多同时生成 1 路、最长 5 分钟、输出最多 200 MiB；并发名额覆盖“完整下载落盘 + 转码”全过程。成功、源读取失败、长度不一致、临时存储失败、客户端断开、超时、ffmpeg 启动/转码失败和输出越界都会在返回结论前关闭文件描述符并清理临时目录。后台切换栏目、会话失效、页面退出或请求断开都会暂停审核播放器、中止 OSS 上游和 ffmpeg，并回收 Blob URL；BFCache 返回时已释放预览恢复为可重试状态。浏览器只有在响应 MIME 为 `video/mp4` 且播放器触发 `loadedmetadata/canplay` 后才显示成功，Blob 解码失败会恢复重试入口；无 AbortController 时也用请求代次隔离迟到成功/失败。服务器缺 ffmpeg、临时存储不可用、源对象不可读、超时或编码损坏时均返回脱敏错误，不回显对象 Key、签名、临时路径或 OSS 响应正文。

`deploy/install-on-server.sh` 不自动安装或升级 ffmpeg。每次发布前必须在目标服务器只读确认 `VIDEO_PREVIEW_FFMPEG_PATH` 存在、ffmpeg 启用了 `fd` 协议，并用 `mdat` 在前、`moov` 在尾的 HEVC+AAC 样本按本项目固定 fd 3 参数真实转码；`ffprobe` 输出必须为 H.264/yuv420p + AAC。缺少 `fd`、`libx264`、AAC 或任一固定参数即停止发布，不得用 faststart/纯管道样本或模拟测试代替生产预检。

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
- `GET /admin/listings/:id/video-compatible-preview`（Bearer 鉴权；只按受控上传目录内的房源持久 `videoKey` 生成 H.264 审核预览）
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

游客与登录中介都可匹配全部当前可见有效房源；游客卡片和提示词只使用公开白名单字段，来源由服务端形成互斥 canonical 结果，楼栋、房号、完整地址、电话、看房方式、钥匙、密码、敏感备注和视频签名参数不得进入 LLM 提示词或 trace。
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

## 房源体验闭环 M1：录入字段与存量迁移

房源创建、编辑、飞书同步和后台编辑现在统一使用以下服务端字段口径：

- `landlordCommissionPercent`：房东总佣金占月租比例，允许 `0` 至 `100` 的整数；新建请求未传时由服务端固定为 `50`。该字段是房源业务输入，绝不能复用旧 `commissionRate`；旧字段仍仅表示服务端分佣配置中的上传人比例。
- `remark`：可空，最多 200 字。服务端会拦截手机号、微信/weixin/wechat/wx/vx、二维码和联系方式 URL；公共详情不会返回不符合新规则的存量备注。
- `landlordPhone` / `contact`：业主、二房东房源在钥匙、密码、联系房东三种方式下都必须提供合法 11 位手机号；钥匙和密码方式仍分别额外要求钥匙位置、看房密码。公司房源可留空或在编辑时显式清空，非空时仍须合法；公司详情只展示服务器三个统一号码。
- 房源特点白名单新增 `Loft`、`落地窗`，服务端、客户端、后台、筛选、推荐资料与找房需求解析保持一致。

飞书房源表可使用“房东佣金占月租比例”“房东佣金比例”或 `landlordCommissionPercent` 列；缺失按 50 处理，显式 0 保留。缺少合法电话的公司库存行继续同步公开租金/房态：优先保留线上已有合法号码，否则清空历史占位值并标记“联系电话待补充”，不再写入“公司统一维护”等占位联系方式。错误摘要只记录行号和通用原因，不打印号码或备注正文；公司房源人工上传/编辑也可留空，任何非空号码仍强制为合法 11 位手机号。

存量佣金字段迁移必须显式执行，服务启动和普通请求不会自动迁移：

```bash
cd server
# 默认 dry-run，只输出总量、缺失量、覆盖率等汇总
node scripts/migrate-listing-landlord-commission-v1.js

# 经生产数据授权、停写和仓库外加密备份后才可执行
node scripts/migrate-listing-landlord-commission-v1.js --apply

# 使用 apply 返回的备份文件回滚
node scripts/migrate-listing-landlord-commission-v1.js --rollback <备份文件路径>
```

脚本在写入前校验 `listings` 结构和所有已有值；apply 前生成同目录回滚副本，写后核对房源总数及 100% 字段覆盖率，重复 apply 为零修改。任何非法值或异常结构都会在写盘前失败。本仓库只提供脚本和合成数据测试，本轮不执行真实生产迁移。

M1 验收脚本：

```bash
node scripts/listing-experience-fields-v1-test.js
node scripts/listing-landlord-commission-migration-v1-test.js
```

## 房源体验闭环 M2：详情佣金与拨号成功足迹

`GET /mini/listings/:id` 会根据服务端验签用户计算 `commissionBreakdown`：

```json
{
  "landlordPercentOfRent": 50,
  "viewingAgentPercentOfRent": 35,
  "maintainerPercentOfRent": 10,
  "platformPercentOfRent": 5,
  "split": {
    "viewingAgentRate": 70,
    "maintainerRate": 20,
    "platformRate": 10
  }
}
```

这些数值全部来自房源比例、分佣配置、房源维护人和当前用户的服务端记录；页面不写死 `35/10/5`。详情页移除旧佣金条和上传人显示，紧凑展示位置，安全备注仅在有值时渲染。

拨号成功接口：

```http
POST /mini/listings/:id/phone-call-opened
Content-Type: application/json

{ "idempotencyKey": "call_..." }
```

- 接口强制登录，只接受幂等键；`viewerId` 来自验签 token，`listingId` 来自路由，动作和 ISO 时间由服务端固定。
- 别人的合作房源必须先完成敏感信息查看；自己上传的合作房源可直接拨号。当前页面不为公司房源显示“联系房东”按钮，只公开展示环境配置号码；服务端仍保留已发布旧客户端的公司拨号足迹兼容入口，身份、幂等和号码可用性全部由服务端判定。
- 足迹严格只保存 `id`、`viewerId`、`listingId`、`actionType=phone_call_opened`、`occurredAt`、`idempotencyKey`，不保存号码、地址、用途或房源正文。
- 小程序仅在 `wx.makePhoneCall.success` 后把最小记录写入本机账号分区队列；网络失败保留同一幂等键重试，成功后删除，不会因重试重复计数。

M2 验收脚本：

```bash
node scripts/listing-detail-commission-v1-test.js
node scripts/listing-phone-footprint-v1-test.js
```

## 房源体验闭环 M3：报备暂停、敏感查看简化与足迹留存

报备/签单第一版暂停采用仅服务器可控的恢复开关：

```env
REPORT_DEAL_WRITES_ENABLED=0
```

- 默认值为关闭。只有服务器启动环境显式设为 `1/true/on` 才进入历史恢复模式；请求正文、查询参数和客户端同名字段均无效。
- `POST /mini/listings/:id/reports`、`POST /mini/reports/:id/deals`、`POST /mini/listings/:id/deals`、`POST /admin/deals/:id/confirm` 均在路由层与领域层双重封堵，返回 HTTP `410`，响应 `data.reason=REPORT_DEAL_PAUSED`，且不修改数据库。
- `GET /mini/reports`、`GET /mini/deals`、`GET /admin/reports`、`GET /admin/deals`、历史分佣查询继续只读；小程序不再注册历史报备/签单页面，后台无确认按钮。
- `pages/archived-pages.json` 显式登记报备、签单、第一版隐藏群页和旧结构化配房页。四页源码按历史/兼容目的保留，但不注册、不恢复活动入口；静态门禁会枚举 `pages/`，任何新增未注册完整页面必须先明确归档原因，否则直接失败。
- 查看别人上传的合作房源只需有效账号、二次确认和当日额度。请求只提交随机幂等键；操作者、房源、动作和 ISO 时间全部由服务端决定。自己上传仍免留痕直出，公司房源仍直出基础联系信息；实际打开系统拨号页后另记 `phone_call_opened`。
- 同一账号、同一房源在同一上海自然日只写一条敏感查看足迹，即使客户端更换幂等键也不会重复计数；客户端会在一次确认会话内复用同一幂等键。服务端已写但响应丢失时，同一上海自然日内的同键重试会先重新验证当前账号资格，再幂等返回原成功；跨自然日重放旧键必须作为次日新查看重新校验额度、限流并写当日足迹，不能用旧键免额度获取后来更新的地址或电话。角色/实名资格已撤销时始终返回 403。
- 所有新足迹，包括敏感查看、拨号、视频转发、带看审核、房态核验/下架/恢复、坐标修正、分佣配置及飞书同步下架，都经过同一六字段写入口。不得保存电话、地址、需求、用途、分享目标或同步正文。
- 客户端可触发的敏感查看、拨号、视频转发及上传人房态核验按服务端验签账号和动作执行 `30 次/分钟` 滑动窗口；超过后返回 HTTP `429` 与 `data.reason=FOOTPRINT_RATE_LIMITED`，拒绝请求不写库。不同账号、不同动作互不连带，相同幂等键重试优先返回原记录，窗口结束自动恢复。
- 足迹页保留四个统计块，筛选只保留“我的房源被查看”“电话查看”，默认前者。中介最近 7 天、后台最近 90 天；第 7 天记录不会因中介不可见而物理删除。

M3 验收脚本：

```bash
node scripts/report-deal-pause-v1-test.js
node scripts/sensitive-view-simplification-v1-test.js
node scripts/footprint-retention-v1-test.js
node scripts/footprint-route-prune-v1-test.js
node scripts/mini-paused-entry-v1-test.js
node scripts/listing-phone-footprint-v1-test.js
node scripts/video-share-v1-test.js
node scripts/listing-verify-outcome-v1-test.js
node scripts/v1-online-gap-audit.js
```

## 房源体验闭环 M4：账号收藏与我的收藏

收藏只保存服务端账号与房源的最小关系，不把收藏状态或房源快照写进用户/房源对象：

```json
{
  "favorites": [
    {
      "id": "服务端唯一关系编号",
      "userId": "验签账号",
      "listingId": "路由中的房源编号",
      "createdAt": "服务端 ISO 时间"
    }
  ]
}
```

- 旧库缺少 `favorites` 时，纯读取按空数组处理且不落盘；首次收藏才在 `updateDb` 写锁内惰性初始化。已存在但为 `null`、对象、字符串、缺四字段、时间非法或关系 `id` 重复时返回 500，禁止静默清空原数据。
- 关系编号使用随机 UUID；即使 UUID 极端碰撞，也会检查现有关系并追加唯一后缀。重复收藏返回原关系和原 `createdAt`，不会刷新收藏顺序。
- 代码回滚时旧版本会忽略并保留未知的 `favorites` 顶层键，因此不需要数据回滚。禁止用旧整库备份“删除收藏”，否则会同时抹掉备份后的房源、账号和足迹写入；只有停写维护窗口才能做整库恢复。

小程序接口：

```text
GET    /mini/favorites/ids
GET    /mini/favorites
PUT    /mini/favorites/:listingId
DELETE /mini/favorites/:listingId
```

- 四条接口都强制登录。`userId` 只取 HMAC 验签 token，`listingId` 只取路由；PUT/DELETE 不解析请求正文，也不接受客户端 `userId`、角色、维护人、时间或收藏结果。
- PUT/DELETE 是显式目标态而不是 toggle：重复 PUT 只有一条关系，重复 DELETE 继续成功；DELETE 会移除同账号/同房源的全部异常重复关系，但不影响其他账号。
- 写入在数据库跨进程锁内再次用最新用户状态和 `tokenVersion` 验签，封住路由初验后账号停用、删除或改密撤销与落库并发的窗口。
- 新收藏只允许当前前台有效房源。既有收藏后来下架、过期、成交、进入待审、缺视频或被物理删除时仍保留为“暂不可用”，只允许取消，不授予敏感查看、拨号、视频或带看权限。
- 我的收藏安全 DTO 不返回地址、电话、楼栋/单元/房号、密码、钥匙位置、备注、上传人或失效原文；不可用项不返回视频/封面签名。
- `GET /mini/favorites` 的区域、板块、小区、户型、整租/合租、租金区间、特点、可用状态与公司/业主/二房东来源均在服务端执行 AND 筛选。板块只匹配板块字段，不能被同名小区误命中。
- `profileState.favoriteCount` 统计当前账号去重后的全部收藏关系（含暂不可用项），“我的”页据此展示“我的收藏”入口。

客户端不保存匿名或本地收藏。共享收藏爱心组件只维护 token 绑定的进程内缓存，并覆盖首页推荐、房源列表、地图房源卡、找房助手推荐和详情页；“我的房源”管理卡不显示收藏爱心。可见层使用小号 `♡/♥`，外层仍保留 80/88rpx 点击热区并用 `catchtap` 阻止冒泡。无 token 点击只提示登录，不发写请求。显式 PUT/DELETE 串行化并维护最后确认的服务端状态，失败精确回滚；旧 GET、旧 token、旧组件实例或旧页面请求的迟到响应不能覆盖新账号/新操作。

`readDbForRequest` 的自动公司房源迁移与房态过期分支已改为：锁外克隆只做变化探测，发现变化后进入 `updateDb`，基于最新磁盘状态重新执行两项规则。不得恢复旧的“锁外读取 → `writeDb` 整库覆盖”路径，否则另一进程刚提交的收藏会被陈旧快照抹掉。

M4 门禁：

- `favorite-domain-v1-test.js`：关系结构、UUID 碰撞、账号隔离、非法结构、全部不可用类型、脱敏与九类筛选。
- `favorite-http-v1-test.js`：双服务进程并发 PUT/DELETE、伪造身份正文、重复时间不刷新、跨账号隔离和改密撤销。
- `favorite-store-v1-test.js`：GET/写入竞态、token A/B 隔离、失败回滚、相反操作双失败与多组件同步。
- `favorite-component-page-v1-test.js`：游客、重复点击、组件复用、不可用导航、封面迟到错误、筛选/换号/卸载请求竞态。
- `favorite-entry-v1-test.js`：六个规定入口（含我的收藏页）、正确房源 ID、小爱心/独立热区、`catchtap` 和“我的房源”禁收藏契约。
- `favorite-mock-v1-test.js`：开发者工具 Mock 登录假 token、收藏幂等、筛选、失效保留、账号隔离与无请求正文。

## 房源体验闭环 M5：详情 3 公里附近推荐

详情接口会在可用房源正文中附加服务端计算的 `nearby`：

```json
{
  "nearby": {
    "radiusKm": 3,
    "total": 8,
    "hasMore": true,
    "listings": ["最多 6 条白名单卡片"]
  }
}
```

“查看全部附近房源”使用：

```text
GET /mini/listings/:listingId/nearby?all=1
```

- 半径固定为 3 公里。客户端提交的 `radiusKm`、经纬度、身份、角色、来源、`companyOnly` 或候选 ID 均不参与计算；`all=1` 只控制返回权限内全部结果，不改变半径和可见性。
- 锚点与候选都取当前 `publicListings` 有效池：排除当前房源、待审核、下架/过期、成交，以及缺视频的非公司合作房源；公司房源按原规则允许无视频。
- 坐标必须经 `mapCoordinateFromListing` 解析后同时满足 `coordinateLevel=verified` 与 `coordinateVerified=true`。默认中心、估算/历史偏移、未验证手填、腾讯近似地理编码及 `block-center` 均不用于本模块的精确 3 公里计算；找房助手原有板块中心近似兜底不受影响。
- 使用 Haversine 距离，按原始距离升序、相同距离按房源 ID 稳定排序；距离只在请求时计算，不写回房源或数据库。
- 游客和登录中介都可使用当前有效的公司、业主或二房东房源作为锚点，候选与 `total/hasMore` 均从完整有效池计算；游客请求不存在或失效的合作锚点统一得到泛化 `404`，无效 token 不降级为游客。
- 附近卡片为白名单 DTO，只含房源 ID、公开标题/小区、封面、距离、来源、租法、户型、特点和租金；不返回坐标、地址、楼栋单元房号、电话/联系人、密码/钥匙位置、上传人、备注或佣金拆分。
- 锚点无可靠坐标或范围内无候选时返回空结构；详情页完全不渲染附近板块，不展示“附近无房”误导卡。详情 UI 再次截断到 6 条，`hasMore` 时进入独立全部页。
- 全部页和详情卡复用 token 绑定的共享收藏组件。全部页按单调请求序号和 token 隔离换号、退出、卸载及迟到成功/失败；只允许打开当前服务端响应中仍存在的房源 ID。

M5 不新增数据库字段、无需迁移；回滚只撤路由、计算与 UI，不能持久化 nearby ID 或距离快照。开发者工具 Mock 与真实接口保持相同有效房态、verified 坐标、游客三来源公开投影、默认 6/全部和白名单 DTO 口径。

M5 门禁：

```bash
node scripts/listing-nearby-domain-v1-test.js
node scripts/listing-nearby-http-v1-test.js
node scripts/listing-nearby-mock-v1-test.js
node scripts/listing-nearby-page-v1-test.js
```

同时复跑 `map-v1-test.js`、`assistant-radius-search-test.js`、`assistant-coordinate-safety-test.js`、`guest-mode-v1-test.js`、`mini-detail-loading-state-v1-test.js` 与 `favorite-entry-v1-test.js`，防止附近推荐改变地图、助手、游客、详情加载或收藏边界。

## 上线自检

V1 上线自检不再推荐 `npm run smoke`。`server/scripts/smoke-test.js` 是历史综合冒烟脚本，会创建、审核并清理临时业务数据，仍保留但不要作为当前 V1 验收主线。它只能在明确隔离的目标环境且经人工授权后手工运行，统一门禁绝不会自动触发。脚本不再提供地址、后台账号或密码默认值；手工运行前必须只在当前终端/受控执行环境注入 `SMOKE_BASE_URL`、`SMOKE_ADMIN_ACCOUNT`、`SMOKE_ADMIN_PASSWORD`，缺任一项都会在读取数据或发出网络请求前退出。不得把这些值写入仓库、命令历史、协作文档或聊天输出。

PowerShell 7 可在当前进程临时设置变量后运行；以下只展示变量名，不提供任何示例凭据值：

```powershell
$env:SMOKE_BASE_URL = Read-Host 'SMOKE_BASE_URL'
$env:SMOKE_ADMIN_ACCOUNT = Read-Host 'SMOKE_ADMIN_ACCOUNT'
$env:SMOKE_ADMIN_PASSWORD = Read-Host 'SMOKE_ADMIN_PASSWORD' -MaskInput
node scripts/smoke-test.js
Remove-Item Env:SMOKE_BASE_URL, Env:SMOKE_ADMIN_ACCOUNT, Env:SMOKE_ADMIN_PASSWORD -ErrorAction SilentlyContinue
```

当前 V1 基础鉴权/找房验收加 M6 专项脚本如下；完整门禁仍以全部非 smoke 测试和 `v1-final-audit.js` 为准。干净工作树先安装锁文件依赖，再使用统一入口；依赖缺失时 runner 会列出缺项、给出同一安装命令并以退出码 `2` 停止，不会跳过集成测试或假报通过：

```bash
cd server
npm ci --ignore-scripts --no-audit --no-fund
npm run test:v1
```

`test:v1` 稳定排序运行全部 `*-test.js`，明确排除 `smoke-test.js`，即使前面有失败也始终执行 `v1-final-audit.js`，最后按失败总数非零退出。Mock/预览专项同时锁定游客助手三来源公开、合作详情与视频可用、精确地址/联系方式脱敏、失效详情不可枚举、动态佣金、行政区筛选、游客今日任务免请求、当前账号分佣记录与地图小区聚合 DTO；页面专项锁定游客视频播放/转发/保存、转发留痕失败不重复发送、三来源筛选无登录空态、无悬空分隔点、导航栈满回退和足迹单次刷新。

客户端会话与生命周期门禁覆盖首页/任务、房源列表、地图、我的房源、足迹、分佣、找房助手、修改密码、上传和详情长操作：页面卸载、A→游客/B 或旧原生回调迟到后，不得把旧数据写入新页面、弹出旧提示或继续发起旧请求；实际已成功打开系统拨号页的原账号足迹仍进入原账号 outbox，避免安全隔离变成审计丢失。游客填写上传草稿后去登录会保留草稿，已登录账号之间切换会清除上一账号草稿。语音识别只把文字填入输入框，找房请求必须由用户单独点击或回车发起。

跨页待处理筛选统一由 `utils/pending-filter-storage.js` 保存为带版本 envelope。助手/地图产生的私有 `needId/listingIds` 必须绑定稳定会话；首页公开分类显式无 owner。列表或地图只消费同会话私有筛选，owner 不匹配、未知版本、畸形 payload，以及旧版无 owner 的私有字段都 fail-closed 并一次性清理；旧版纯公开分类仍兼容。

```bash
cd server
node scripts/map-v1-test.js
node scripts/assistant-v1-test.js
node scripts/backend-contract-v1-test.js
node scripts/guest-mode-v1-test.js
node scripts/auth-token-v1-test.js
node scripts/mini-login-password-v1-test.js
node scripts/mini-token-revocation-v1-test.js
node scripts/mini-sliding-auth-v1-test.js
node scripts/mini-sliding-auth-client-v1-test.js
node scripts/admin-mini-user-revocation-race-v1-test.js
node scripts/profile-loading-state-v1-test.js
node scripts/profile-faq-v1-test.js
node scripts/mini-page-resume-state-v1-test.js
node scripts/db-cache-v1-test.js
node scripts/db-write-lock-v1-test.js
node scripts/mini-pending-no-data-v1-test.js
```

其中覆盖：

- 地图真实坐标与敏感字段边界。
- 助手需求解析与匹配。
- 后端合同规则：视频、分佣、筛选、公司房源可见性、特点标签，以及报备/签单默认暂停与显式恢复兼容链路。
- 游客模式：匿名三来源有效房源与合作视频可见，合作房源精确地址、联系方式、看房资料和敏感备注严格锁定，所有受保护写操作仍为 `401`。
- Bearer token 鉴权、30 天滑动续期、伪造 `X-User-Id`/篡改 payload/换密钥重签无效。
- 小程序账号密码登录：正确/错误/缺密/存量无密码/待审核/软删登录口径、`passwordHash` 不外泄、DB 只存 scrypt 哈希、后台设初始密码后可登录；显式 `userId` 绑定的管理账号创建/改密会单向同步小程序密码，未绑定账号不按手机号串绑。
- 改密会话撤销：存量无版本 token 平滑兼容；自助改密后当前设备换发新 token、其他旧会话立即 `401`；管理员重置后全部旧会话失效；`tokenVersion` 不向客户端泄露。
- M6 会话撤销：主动退出、首次停用和软删撤销全部旧 token，恢复不复活；退出/停用后的在途数据库写在事务内被 fresh 验签拒绝。
- 客户端同账号续签保持稳定会话键，A→B、A→退出、并发迟到响应不能覆盖或清空当前会话；JSON 与 multipart 都覆盖续签/401，存储故障回滚、管理员慢正文撤权、上传 key 覆盖均有确定性对抗测试；“我的”公开 FAQ 未登录可读且不保留报备/签单活动旧口径。
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
