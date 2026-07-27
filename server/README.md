# 寓你住一起后端说明

本文档以当前代码为唯一事实来源，覆盖 `server/src`、`deploy`、`utils/deploy-config.js` 和现行 V1 验收脚本。历史入口仍保留在代码中时，会在文档里明确标注为“历史预留，第一版不生效”。

## 当前范围

第一版只面向内部中介使用，底部导航固定为找房、房源、地图、我的。租客端、房东端、房源群、积分充值、换群和微信支付入口第一版不开放。

地图找房仍是核心能力，但地图只展示真实且经过确认的小区坐标。无可靠坐标的房源可以进入普通列表，不能进入地图；禁止用随机坐标、散列坐标、区域估算坐标或默认中心点冒充真实位置。小程序不读取用户手机实时位置；用户通过拖动、缩放地图并点击“搜索当前区域”选择范围，客户端只读取地图组件当前可视边界。带看水印使用房源位置参考与时间，不采集手机 GPS，因此运行配置不声明 `scope.userLocation` 或 `requiredPrivateInfos/getLocation`。

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
- `companySheetSnapshot`：飞书公司房源固定十列快照缓存；镜像模式下同时保存
  `sourceMode=feishu-mini-mirror-v1` 与 `schemaVersion=1`，未知来源或未知版本不得被首页渲染。
- `listings[].mediaAssets`：服务端私有的已验证多视频清单；每项保存稳定素材 ID、受控 OSS
  对象键、内容摘要、顺序和回读证据。公开接口只投影素材 ID、顺序和 API 域能力地址，不返回
  OSS 对象键、飞书 token、源文件名或源记录 ID。
- `listings[].noteMaterialState`：员工源表“房源笔记”素材同步的私有状态、集合摘要和失败状态；
  不进入公开房源 DTO。

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
- 公共层不只按字段名删除，还对所有可展示/搜索字符串执行同一套值级投影：全角、中文/金融数字、零宽/组合字符、emoji、任意标点、字母或汉字拆分的电话与结构化精确地址都不能夹带到标题、板块、小区、户型、标签、地图、附近、收藏、匹配、LLM 或飞书公开快照。通用裸域名、子域名、端口/路径/查询、协议相对链接、自定义 scheme、punycode/中文后缀、全角点斜杠和希腊/西里尔同形字域名会按原文位置整段清除；`t.me` / `wa.me` 等私聊域名、社交别名和邮箱同样不能留下可重组残片。中文十百千乘位写法的楼栋、单元、房号也不能留下可拼回的残片。清洗会保留完整的合法数字业务 token（如板块、地铁、分钟、公交、户型、面积、年份和租金）、版本/小数/日期/文档 IP，以及 `Vanke.City`、`Node.js` 等正常点号文案和“手机信号好”“密码保护 WiFi”等设施文案；不能用长数字尾部伪装成短地铁号。只有服务端小区词库精确命中的 `address===community` 存量值可按小区名公开，审核或坐标标记不能自我白名单未知完整地址。
- 公开投影性能不能靠放宽上述规则换取：城市、区域、板块只对服务器配置中的精确规范值走快路径，小区只对服务端小区词库精确值走快路径；任一夹带电话、域名、楼栋、单元或房号的污染值立即回到完整值级清洗。跨请求上下文缓存最多 8192 个完整敏感指纹，满载后额外条目不逐项淘汰既有热点；每次完整列表投影前清除已删除/已编辑房源的旧指纹。纯安全投影另有 8192 个、单值最多 256 字符的有界只读结果缓存。`public-listing-projection-performance-v1-test.js` 使用生产同款 8+1 缩小容量并通过生产/Mock 的真实列表接线统计证明无级联全冷；生产/Mock、游客/登录分别 fresh-load 1100 套规范地点与 256 套合法库外地点，兼顾绝对性能和慢机稳定性。
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
- 员工“房源笔记”可为同一房源提供多个视频。服务端私有 `mediaAssets` 按稳定
  `assetId/displayOrder` 保存全部已验证视频，`videoKey` 仅兼容指向第一条；所有视频必须在
  飞书目标目录和 OSS 实际 GET 回读均验证内容摘要与字节数后，才原子替换整套清单。
- 当前有效房源的公开 DTO 只返回 API 域不透明能力地址，默认有效 6 小时；地址不包含 OSS 对象键、历史文件名、AccessKey 或 OSS 签名参数。`GET /mini/listings/:id/media/:kind` 支持 `GET`、`HEAD` 和单段 `Range`，每次请求都重新核对房源仍为前台有效状态，再由服务端生成默认 900 秒的 OSS 短签名并限长流式转发。媒体源只允许配置中的精确 OSS origin 和受控上传目录，不跟随重定向；重复房源 ID 无法唯一解析时 fail-closed。代理默认全局最多 24 路、同一可信客户端最多 6 路，客户端断开、上游 abort/error、超时及正常结束都必须主动销毁上游并只释放一次名额，避免单个来源占满全局并发。
- 多视频能力令牌同时绑定房源、`assetId`、对象键指纹和整套媒体状态；视频被替换、删除、
  调序或房态失效后旧能力立即失效。详情页仍只渲染一个播放器，多素材时显示选择条；切换素材
  会作废旧播放、保存和转发操作，详情刷新时优先保留仍存在的当前素材，否则回到第一条。
- 上传人通过受保护的“我的房源”接口查看本人待审核/暂不可公开房源时，服务端签发独立 `owner` scope 的短时能力 URL。该令牌同时绑定服务端验签账号、房源、媒体对象和当前审核/维护状态；URL 不明文携带账号或状态，不能跨账号、降级成公共令牌或在房态/媒体变化后继续使用。微信原生 `image/video` 读取已签 URL 时无需再附 Authorization，但 URL 只能由可信本人接口取得。
- 当前有效合作房源视频属于公开推广素材，游客可直接播放、转发或保存。播放器 `binderror`、保存视频收到 `401/403/404` 时只允许匿名刷新详情并重试一次，禁止循环；保存下载超时为 300 秒。转发留痕仍只接受已登录账号，留痕失败不得造成视频重复发送。含能力地址的列表/详情 JSON 与媒体响应均禁止共享缓存。
- 小程序 `request` 与 `downloadFile` 域名必须同时配置为合法 HTTPS 且与 API 严格同源（不得含 URL 用户名/密码），并在微信后台将同一 API 域加入 request、downloadFile 与 video 媒体合法域名。发布前在目标数据环境运行 `node scripts/listing-media-readiness-audit.js`；脚本只输出计数和不可逆短指纹，任一前台视频无法解析为受控对象键时退出 `2` 并阻止发布。该脚本只验证“当前仍声明有视频”的行，发布/同步巡检还必须比较前后 `withVideo` 汇总数；无业务解释的减少要停止推进并核对同步对账，不能把“剩余视频都可解析”误当成数量守恒。
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

筛选选项不再由小程序或后台硬编码。公开端先读取：

```http
GET /mini/listing-filter-options
```

该接口只从当前有效且已经安全公开投影的房源生成 `regionOptions`；每个行政区携带自己的
`blocks`。列表、公司房源、收藏和地图选中行政区后，只展示该行政区下真实存在的板块；清空
行政区时才展示全部板块。未来在位置字典加入新行政区、板块、小区并成功同步后，无需再次改
小程序代码。本人上传页会把受保护接口返回的本人房源位置与公开元数据合并；收藏页同样把本
账号全部安全收藏 DTO 的位置合并回来。因此只存在于本人待审核房源、暂不可公开房源或失效
收藏中的新行政区/板块也可筛选，且换号或迟到响应不能沿用上一账号的私有位置选项。

管理后台不能携管理员 Bearer Token 调用上述 `/mini/*` 端点，必须读取：

```http
GET /admin/listing-filter-options
```

它与后台 `/admin/listings` 同源，覆盖全部 active 房源，包括待审核、尚未公开的后台房源；这些
私有地点不会反向进入游客 `/mini/listing-filter-options`。管理员端点走管理员鉴权，不会把管理员
token 当作小程序 token 造成 401 与清会话。后台在租列表查询使用 canonical `district`，服务端
继续兼容旧 `area`。行政区与板块属于结构化字段：所有列表、收藏、地图、本人上传和废房源入口
都先做 NFKC/首尾空白规范化后再等值匹配，行政区额外兼容末尾“区”的差异；板块不得再用包含
匹配误收相近名称。切换行政区先清理从属板块再发唯一请求，并以请求代次拒绝迟到旧响应。地图、
列表、收藏或本人上传页检测到登录账号变化时，会同时清空上一账号的完整筛选条件、板块选项和
需求画像，不能只刷新地点元数据后沿用旧账号条件。

废房源池使用独立的管理员元数据：

```http
GET /admin/expired-listing-filter-options
```

它只从废房源池的管理员位置真值生成行政区与板块，不能复用公开有效房源元数据，也不能使用
游客公开投影清洗后的地点反推管理员选项；因此某条私有废房源出现在下拉项后，必须能用同一
选项筛回该行。后台和离线 Mock 都按行政区、板块、小区、来源、最低/最高租金、户型、整租/合租
做同一组 AND 筛选，并用请求代次拒绝迟到响应覆盖新结果。

`server/src/config.js` 中既有板块映射和 `communityLocationOverrides` 只保留为旧 Sheet
兼容与位置规范化兜底，不再承担前端选项清单。镜像模式的行政区、板块、小区与坐标以“小程序
位置字典”为权威；新增地点应维护字典并完成同步，而不是在页面里加常量。

地图接口：

```http
GET /mini/map/communities
GET /mini/map/pins
```

地图筛选复用区域、板块、小区、租金、户型和租赁方式等参数，并用 `sourceType` 精确筛选公司/业主/二房东来源，但只返回可靠小区坐标。从官方联想选择的小区在列表、收藏、地图、普通匹配和 LLM 助手中统一按规范化名称精确匹配，不能把“城发天地”扩大成“城发天地大厦”；未命中官方词库的自由文字搜索仍可模糊召回。地图点位按 `district + block + community` 三元组聚合，并返回稳定 `groupId` 区分跨区域或跨板块的同名小区；点击点位再进入列表时必须携带这三个结构化轴，不能只带同名 `community` 而串入另一组。从地图切回列表时还会独立保留当前来源等筛选条件；游客公开字段投影与列表一致。

坐标分级（`verified`/`approximate`/`block-center` 三档，含板块中心兜底）与离线地理编码依赖腾讯位置服务：`QQ_MAP_WEBSERVICE_KEY`（兼容旧名 `QQ_MAP_KEY`）从环境变量读取，`server/scripts/geocode-listing-communities.js` 用它批量补小区坐标。

## 公司房源表快照

小程序端快照接口：

```http
GET /mini/company-sheet-snapshot
```

镜像模式的公开快照固定为以下十列，顺序和语义都属于版本契约：

```text
行政区｜板块/商圈｜小区｜小区+房号｜户型描述｜户型分类｜月租金｜看房方式｜备注｜房源状态
```

后端只从完整回读通过的 canonical 专用表生成这十列，并返回
`sourceMode=feishu-mini-mirror-v1`、`schemaVersion=1`。首页只有在来源、版本、十列表头和
每行列数全部匹配时才生成图片；未知列、旧八列、敏感表头、来源不可用或数据损坏一律关闭图片
生成并保留安全空态，不猜列、不回退旧缓存。

首页图片按“行政区 → 板块/商圈 → 小区”三级合并，房号、户型描述和备注最多两行，其余业务
列一行。为兼容微信设备 Canvas，按最高 2 倍像素输出且任一物理边不得超过 4096px；固定十列
每页最多 37 条原始数据行，超过后严格保持源顺序继续分页：38 条为 `37+1`、46 条为 `37+9`、
74 条为 `37+37`、75 条为 `37+37+1`。每页都重复固定十列表头并独立重算三级合并区，不能按
行政区或板块边界改变硬分页容量；任一页尺寸或绘制失败时整组图片都不发布。首页大图预览会
一次带入全部页，页面分页控件决定当前转发页；“下载全部”按页串行保存、显示进度、防止重复
点击并汇总部分失败。请求代次、共享 Canvas 串行队列和页面卸载门禁共同阻止旧请求或旧绘制
回调覆盖最新完整图片集。前端不会把十列裁成旧八列，也不会偷偷降低清晰度绕过边界。

当前公司房源快照不做游客双视图，匿名与登录中介看到同一份已经公开脱敏的公司待租表。
手机号只允许替换成 `COMPANY_CONTACT_PHONES` 中合法统一号码；座机、邮箱、社交账号、裸域名、
外链、飞书/Lark 地址、密码、内部身份、负责人、部门、OSS key 和源素材信息都不会进入响应。
响应不包含飞书表 URL、sheet token、range、缓存时间或内部起始行列。公司详情继续按既有规则
展示服务器统一号码，未配置时不回退房源自身联系方式。

## 飞书公司房源同步

存量房源更新采用逐房源原子语义：改写状态前快照同一对象，任一领域校验或字段挂载失败都恢复完整快照并继续记失败，不能出现“同步报错但下架房源已变回在租”的半成品。恢复保持原对象引用，确保列表和后续处理看到同一份回滚结果。非 dry-run 素材行还会在任何下载/上传前，用隔离副本执行同一条完整 upsert 预校验；佣金、重复房源或字段挂载失败时 OSS 写入为 0，避免无法自动补偿的孤儿视频。新增与更新路径使用同一门禁。

列表媒体文案也有语义门：有视频但暂时没有封面时必须显示播放/查看动作提示，不能误写成“暂无视频”“视频待补”或裸“视频”；确实无视频才使用无视频空态。否定规则对称覆盖播放、观看、查看、打开、预览的“不能/不可/不支持/无法/禁止/未能”等前缀、失败/不可用等后缀及“打不开”口语，避免“无法观看”“无法打开视频”“预览失败”借正向动作词假绿。测试用正反语义和 13 种可重复变异共同锁定。

管理后台接口：

```http
GET /admin/feishu-sync/status
POST /admin/feishu-sync/run
```

当镜像同步与房源笔记素材同步同时开启时，正式请求必须携带最近一次完整 dry-run 返回的两项
内容计划确认值：

```json
{
  "dryRun": false,
  "expectedContentPlanSha256": "64位小写十六进制摘要",
  "expectedContentAssetCount": 0
}
```

`expectedContentPlanSha256` 与 `expectedContentAssetCount` 必须同时出现；前者只接受精确 64 位小写
十六进制，后者只接受非负安全整数。缺失、单边、错型、负数、小数、超出安全整数或大写摘要都在
取得同步互斥锁及任何飞书读写前返回 HTTP 400。`dryRun=true` 不要求确认值，但若主动携带也必须
满足同一类型契约。只有镜像和房源笔记素材两项开关同时启用时才强制正式确认，关闭素材链或回退
旧非镜像链不会扩大原请求契约。

后台 HTTP 请求只接受 `dryRun`、`runId`、`nowMs`、`expectedContentPlanSha256` 和
`expectedContentAssetCount` 五个公开字段，任何内部适配器、飞书客户端、令牌、私有映射或其他未知
字段都会在进入同步前返回固定文案的 HTTP 400，错误响应不会反射客户端提交的字段名或内容。
`runId` 只能是 8 至 128 位 ASCII 安全标识，首位为字母或数字，其余只允许字母、数字、点、下划线、
冒号和连字符；`nowMs` 只能是正安全整数毫秒时间戳。服务端内部直接调用仍可显式注入测试/受信
适配器，但该能力不属于 HTTP 契约。

同步间隔默认值来自 `server/src/config.js`，当前默认 `60` 分钟；服务器可通过环境变量覆盖：

```env
FEISHU_SYNC_INTERVAL_MINUTES=60
```

### 小程序专用源表模式（默认关闭，完成飞书建表后再启用）

新模式使用“员工源 Base + 小程序专用 Base”两套多维表，员工现有源表保持日常编辑入口且服务端只读：

1. **员工源表（员工源 Base）**：员工继续维护，不由同步程序改名、补列或反向写入；稳定 `record_id` 是房源唯一源键。
2. **小程序位置字典（小程序专用 Base）**：每个标准小区一行，维护 `locationId / 城市 / 行政区 / 板块或商圈 / 标准小区 / 别名 / 经纬度 / 启用`。新增行政区、板块或小区只改字典，不再改服务端硬编码。
3. **小程序专用房源源表（小程序专用 Base）**：只允许服务端写。它保存已按字典归一并完整回读校验的 canonical 房源，库存、地图和固定十列待租表只消费这一批结果。

两套 Base 使用两个资源 token 定位。`FEISHU_SOURCE_BITABLE_APP_TOKEN` 与 `FEISHU_TARGET_BITABLE_APP_TOKEN` 必须成对配置：前者只读取员工源 Base，后者读取位置字典并且只写小程序专用房源源表；只配置其中一个会 fail-closed，绝不偷偷回退到旧 `FEISHU_BITABLE_APP_TOKEN`。两项都未配置时才保留旧单 Base 配置兼容，便于尚未启用镜像的环境安全回滚。Base token 和三个 table ID 在配置解析、资源重叠比较与真实请求前统一去除前后空白，不能用空格把同一资源伪装成两份配置。

员工源表最低字段语义为 `community`（小区）、`roomLabel`（小区+房号）、`layoutDescription`（户型描述）、`monthlyRent`（月租金）、`rentMode`（整租/合租）、`listingStatus`（房源状态），这些字段每行必须非空；`viewingMethod`（看房方式）和 `remark`（备注）列必须存在但单元格可空。`roomLabel` 的小区前缀必须等于源小区、字典标准小区或该字典行别名，服务端随后统一重建为“标准小区 + 楼栋 + 可选单元 + 房号”；错小区、含糊格式或与显式楼栋/单元/房号冲突会整批阻断。支持 `1幢1单元101`、`1幢101室`、`1幢-101` 等确定格式；员工现表中恰好四个非空纯数字段的 `1-2-301-01` 按“楼栋=1、单元=2、房号=301-01”完整保留，不能丢弃第三或第四段。四段中含空段/非数字、超过四段、显式房号不一致，或小区列与“小区+房号”的已知位置前缀冲突时仍整批阻断，必须由员工确认真实小区，服务端不得猜测或自动换区。

旧普通三段混合格式 `1幢-1单元-101` 继续按“楼栋=1、单元=1、房号=101”兼容；只有“幢/单元”后的捕获值不以连接符开头时，才优先把房号内部的连接符视为复合房号的一部分。这样 `1幢2单元301-01` 与旧三段格式不会互相误判。

出租方式只接受明确的“整租”或“合租”。房态采用白名单：`上架/已上架/在租/待租/空置/可租/有效/开放/可看/可出租` 公开；`下架/已下架/已租/已出租/已成交/成交/关闭/已关闭/无效/删除/已删除/暂停/暂缓/维修中/不可租/停租/未上架/不上架/未在租/不在租` 不公开；其他值整批阻断，不能默认上架。户型描述是唯一权威，户型分类由服务端派生；源表若也绑定分类列，非空值必须与派生结果一致。

当前员工源 Base 的真实 17 列没有“出租方式”和“房源状态”，且必须继续作为员工只读外部事实源。只有显式设置
`FEISHU_SOURCE_COMPATIBILITY_PROFILE=employee-current-stock-v1` 时，源字段绑定才允许省略 `rentMode/listingStatus`；配置为空时仍执行上面的严格契约，任何其他 profile 名称会在服务启动加载配置时直接失败。该 profile 只兼容这一张“表内即当前在架集合”的现表，不是通用默认值：

- `rentMode` 绑定整体缺失时，依次按确定规则派生：户型描述含“整租”或`（整）/(整)`为整租；否则户型分类含“单间”或房号以英文字母结尾为合租；否则房号以数字结尾且户型分类含一至六室为整租；其余整批阻断。员工现表的“单间”会在专用表中统一为“一室”分类。
- 员工现表把“单间/一室一厅/两室一厅/三室一厅”等完整描述保存在户型分类列。profile 只在分类列和户型描述能够各自独立推导且室数一致时，把分类统一为“一室/两室/三室”等标准粒度；只接受边界明确的一至六室，十以上中文室数、多位阿拉伯室数、多个冲突室数、真实室数冲突、未知分类或严格模式均整批阻断。
- 员工现表少量“小区+房号”末尾带运营用的“月佣”或“数字%月佣”。profile 只剥离这两种精确末尾注记后再解析房号和出租方式，注记不会进入备注、佣金或任何客户端可控字段；未知尾注、非末尾“月佣”文本及严格模式仍整批阻断。
- 员工现表的小区列为空时，profile 只能使用本轮已经完整校验的位置字典，对“小区+房号”执行标准小区名和别名的最长且唯一前缀反解；缺字典、无匹配或歧义都整批阻断。该规则使新增小区继续只需维护位置字典，不在代码里新增小区特判。
- `listingStatus` 绑定整体缺失时，本轮有效源行写为“在租”。源记录从完整快照消失时，专用表同一行原子写入 `listingStatus=已下架 / published=false / enabled=false`；重新出现时按本轮 canonical 结果恢复“在租/true/true”。
- 只要显式配置了 `rentMode` 或 `listingStatus` 绑定，就完全以该列为准；单元格为空或值非法时仍由严格 canonical 层整批阻断，绝不回退上述派生规则。
- 员工现表的“看房方式”混存门锁码、空出说明和联系要求。profile 对这张已核员工表只接受两种高置信旧门锁码：排除 `19xx/20xx` 年份后的 4 位纯数字，或恰好 7 位且仅含数字与 `#`、同时至少各含一个数字和 `#`；其余文本默认收敛为 `viewingMethod=联系房东`。启用 `employee-ai-foundation-v1` 且源绑定中没有独立 `vacancyNote` 时，兼容层会在收敛看房方式前读取原文：只有规范化原文明确包含“空出”才把整段原文写入目标主档私有 `vacancyNote` 并标为“即将空出”；纯日期、门锁码、“租客转租”、提前联系等不含“空出”的值仍标为“待出租”，绝不猜日期或年份。空出原文不得进入 `viewingPassword`、公开备注或固定十列首页快照。手机号、座机、400/800、国家码/分机、微信/QQ/VX 等社交标识、日期年份、腾房/空置/退租/到期/搬离/可看/联系说明均不得进入 `viewingPassword`，原说明和号码也不得转存到备注；电话号码数字之间即使插入任意非数字字符（包括空格、括号、点、横线、斜杠、间隔号、逗号、分号、竖线或字母伪装）仍按敏感号码阻断。含“钥匙/取钥匙”写成 `viewingMethod=钥匙`。若另行显式绑定独立 `viewingPassword` 列，该列保持权威，兼容推导不得覆盖或回填，但仍必须通过同一敏感内容拒绝门：门锁码行的显式密码必须非空且不得是电话、社交账号、日期或联系说明；钥匙或联系房东行的显式密码必须为空，任一矛盾都会整批阻断。
- profile 只忽略“所有已绑定业务字段均为空”的单个模板记录；任一业务字段已有内容但缺少“小区+房号”的半填行仍整批阻断。为了识别这一模板，读取层允许先取回空单元格，但所有已绑定列仍须真实存在且类型正确。
- 月租金只绑定现有“押一付一月租金”。员工源里的“押一付一月租金”和“押二付一 月租金”两列都原样完整保留，后者不参与本 profile 的 canonical 月租金，避免两列自动猜选。

无论是否启用 profile，员工源客户端都只有 GET；同步程序不会向员工 Base 发出 POST/PATCH/DELETE，唯一飞书写目标仍是目标 Base 的 `FEISHU_MINI_TABLE_ID`。启用本 profile 时 source/target Base token 还必须互不相同，避免把只读员工 Base 复用成写目标；管理状态中的 `sourceBaseReadOnlyBoundaryReady` 可直接诊断这道边界。

建议专用表字段类型如下（飞书类型码：文本 `1`、数字 `2`、单选 `3`、多选 `4`、复选框 `7`、手机号 `13`、附件 `17`）：

- 小程序位置字典：ID/城市/行政区/板块/标准小区用文本，别名用多选，经纬度用数字，启用用复选框。
- 小程序专用源表：ID、位置、标准房号、户型、出租方式、房态、看房方式、备注等用文本；租金、佣金、经纬度用数字；标签用多选；视频用附件；`published/canonical/enabled` 用复选框。
- `sourceRecordId/locationId/locationRecordId/city/district/block/community/latitude/longitude/roomLabel/building/roomNumber/layoutDescription/layoutCategory/monthlyRent/rentMode/listingStatus/published/canonical/enabled` 为专用表逐行必填；`unit/viewingMethod/remark` 列必建但值可空。启用 `employee-current-stock-v1` 时 `viewingPassword` 也必须建成文本列，即使源表没有独立密码列，因为兼容层需要把纯门锁码从“看房方式”安全拆入该列；漏配或类型错误会在任何飞书读取/写入前阻断。源表若额外绑定楼栋、单元、房号、分类、电话、密码、佣金、标签或视频，专用表必须存在同语义配对列。

环境绑定只负责提供稳定 `field_id`，字段类型与必填规则由代码固定并在每轮读取前对照飞书元数据；员工改显示列名不会影响同步，同名诱饵列也不会被读取。模板中的占位符必须替换成飞书真实 `field_id`，不得把真实值写进仓库：

每个已经配置的 `field_id` 都必须真实存在；“单元格可空”不等于“列可以删除”。例如员工源表的看房方式、备注，以及专用表的单元、看房方式、备注，允许某一行留空，但整列被删除、重建成新 `field_id` 或改成错误类型时，本轮会在首个 POST 前失败。新增或重建列后必须更新服务器上的 `field_id` 绑定并先跑 dry-run，不能靠显示列名自动猜回。

飞书数字列可能把已写入数字回读成数字字符串；读取层只把有限、标准十进制数字字符串归一为数字，十六/二进制文本、首尾空白、非法数字和非标量值继续失败。专用表可选字段回读时，字段省略、`null`、空字符串或空数组只在“双方都为空”的语义下等价，任何非空旧值或新值差异仍会生成更新。首次读取真正空表时，飞书可能返回 `has_more=false,total=0` 并省略 `items`；只接受首个分页的这一种精确空表响应，非零总数、继续分页或后续页缺 `items` 一律 fail-closed。

```env
FEISHU_SYNC_ENABLED=true
FEISHU_AUTO_SYNC_ENABLED=false
FEISHU_MIRROR_SYNC_ENABLED=true
FEISHU_SOURCE_COMPATIBILITY_PROFILE=employee-current-stock-v1
FEISHU_SOURCE_BITABLE_APP_TOKEN=app_employee_source_placeholder
FEISHU_TARGET_BITABLE_APP_TOKEN=app_mini_target_placeholder
FEISHU_SOURCE_TABLE_ID=tbl_employee_source
FEISHU_MINI_TABLE_ID=tbl_mini_source
FEISHU_LOCATION_TABLE_ID=tbl_location_dictionary
FEISHU_SOURCE_FIELD_BINDINGS={"community":"fld_source_community","roomLabel":"fld_source_room","layoutDescription":"fld_source_layout","layoutCategory":"fld_source_layout_category","monthlyRent":"fld_source_deposit_one_monthly_rent","viewingMethod":"fld_source_viewing","remark":"fld_source_remark","video":"fld_source_video"}
FEISHU_MINI_FIELD_BINDINGS={"sourceRecordId":"fld_mini_source_id","locationId":"fld_mini_location_id","locationRecordId":"fld_mini_location_record_id","city":"fld_mini_city","district":"fld_mini_district","block":"fld_mini_block","community":"fld_mini_community","latitude":"fld_mini_latitude","longitude":"fld_mini_longitude","roomLabel":"fld_mini_room_label","building":"fld_mini_building","unit":"fld_mini_unit","roomNumber":"fld_mini_room_number","layoutDescription":"fld_mini_layout","layoutCategory":"fld_mini_layout_category","monthlyRent":"fld_mini_rent","rentMode":"fld_mini_rent_mode","viewingMethod":"fld_mini_viewing","viewingPassword":"fld_mini_viewing_password","remark":"fld_mini_remark","listingStatus":"fld_mini_status","video":"fld_mini_video","published":"fld_mini_published","canonical":"fld_mini_canonical","enabled":"fld_mini_enabled"}
FEISHU_LOCATION_FIELD_BINDINGS={"locationId":"fld_location_id","city":"fld_location_city","district":"fld_location_district","block":"fld_location_block","community":"fld_location_community","aliases":"fld_location_aliases","latitude":"fld_location_latitude","longitude":"fld_location_longitude","enabled":"fld_location_enabled"}
FEISHU_REQUEST_TIMEOUT_MS=30000
FEISHU_REQUEST_MAX_RETRIES=2
FEISHU_REQUEST_RETRY_DELAY_MS=200
FEISHU_MIRROR_MAX_DEACTIVATE_COUNT=10
FEISHU_MIRROR_MAX_DEACTIVATE_RATIO=0.35
FEISHU_MIRROR_ALLOW_MASS_DEACTIVATE=false
```

#### AI 数据底座与房源生命周期（默认关闭）

在上述跨 Base 镜像已经稳定的基础上，可把兼容配置切换为
`FEISHU_SOURCE_COMPATIBILITY_PROFILE=employee-ai-foundation-v1`。该配置仍把员工现表作为唯一日常编辑入口，但目标 Base 从“两张业务表”扩展为四张相互独立的业务表：

1. **小程序位置字典**：继续负责城市、行政区、板块/商圈、标准小区、别名和坐标归一。
2. **小程序专用房源源表**：既是小程序 canonical 房源源，也是当前房源主档。原业务列不变，另增 18 个内部生命周期字段。
3. **已出租房源**：每次待租周期结束时追加一条不可变快照，不删除当前主档。
4. **房源状态流水**：只追加“进入待租、重新进入待租、检测已出租、房态变化、责任归属变化”等事实事件。

员工源表不新增字段、不改名、不回写。当前 17 列员工现表没有独立“备注多久空出”列，`FEISHU_SOURCE_FIELD_BINDINGS` 只绑定一次原有“看房方式”，不得把同一个 `field_id` 同时绑定为 `viewingMethod` 与 `vacancyNote`。该 profile 在归一看房方式之前，按以下规则派生目标主档的私有 `vacancyNote`：

- “看房方式”规范化原文明确包含“空出”：把整段原文写入目标 `vacancyNote`，规范状态为“即将空出”；例如“8.10空出，不配合提前联系”完整保留，但不解析成绝对日期。
- 不含“空出”：目标 `vacancyNote` 为空，规范状态为“待出租”；门锁密码、纯日期、“租客转租”和联系要求都不得误判。
- 未来标准源表如果真正建立并显式绑定独立 `vacancyNote` 文本列，则该列唯一权威：即使某行为空也不得回退解析“看房方式”，两列内容不自动合并或猜冲突。
- 只有上一轮完整当前主档中存在、本轮完整源快照中消失的房源，才进入“已出租”；同时关闭 `published/enabled`，先追加已出租周期和状态流水并严格回读，再更新当前主档。分页不完整、字段错型、源空表、批量撤下熔断或任一写后回读不一致时，库存与公开十列表都不发布。
- 状态流水事件 ID 必须存在且整表唯一，大小写变体也视为冲突并整批阻断。初始化基线不只核对固定事件 ID，还同时核对实体、周期、事件类型、目标状态、事件时间、runId 和版本；人工复制或伪造同名行不能开启“源消失即已出租”。
- 已出租房源重新出现在员工源表时复用同一个底座房源 ID，并把待租周期号加一；相同周期的归档键和流水事件键稳定幂等，失败重跑只补缺口。
- 同一物理房源换了员工源 `record_id` 时，必须先冻结旧周期并追加“检测已出租”，再开启新周期并追加“重新进入待租”；两条流水的事件时间严格递增。部分写入后重跑仍按稳定事件 ID 只补缺失事件，不能倒序。

稳定身份规则固定如下：

- 整租且有寓小二房源 ID：`YX2:<房源ID>:WHOLE`。
- 合租且同时有寓小二房源 ID、房间 ID：`YX2:<房源ID>:<房间ID>`。
- 缺少真实 ID：由服务端根据唯一物理房源键和源记录 ID 生成持久 `TMP-...` 身份。
- 后续补入真实 ID 时只升级身份类型并保留临时 ID，不更换 `foundationListingId`，历史和周期不会断链。合租缺房间 ID、真实身份/源记录/物理房源键互相冲突，或一个物理房间命中多个身份时整批阻断。

计时起点只使用员工源记录的飞书 `created_time`：状态为“即将空出”时字段 `metricKind=提前挂出天数`，状态为“待出租”时为 `metricKind=待租天数`，`lifecycleDays` 按完整 24 小时向下取整。飞书“列出记录”默认不返回自动字段，因此员工 AI 数据底座读取源记录时必须在每一页请求显式携带 `automatic_fields=true`；其他不需要创建时间的表不无条件扩大响应。创建时间必须是 13 位毫秒量级的安全整数；缺失、秒级误传、非法、冲突或未来创建时间均在首笔写入前阻断，不能用修改时间、合同开始/结束时间或同步时间代替。

当前主档新增字段及类型：

- 文本：`foundationListingId / temporaryListingId / yuxiaoerListingId / yuxiaoerRoomId / identityType / physicalUnitKey / lifecycleStatusText / vacancyNote / availabilityCycleId / metricKind / listingOwner / ownerDepartment / identityAliases`
- 日期时间：`sourceCreatedAt`
- 数字：`availabilityCycleNo / lifecycleDays / lifecycleVersion`
- 复选框：`sourcePresent`

“已出租房源”固定 45 个语义字段：`archiveKey / foundationListingId / temporaryListingId / yuxiaoerListingId / yuxiaoerRoomId / identityType / physicalUnitKey / sourceRecordId / availabilityCycleNo / availabilityCycleId / lifecycleStatusText / vacancyNote / sourceCreatedAt / metricKind / lifecycleDays / listingOwner / ownerDepartment / identityAliases / lifecycleVersion / previousLifecycleStatusText / locationId / locationRecordId / city / district / block / community / latitude / longitude / roomLabel / building / unit / roomNumber / layoutDescription / layoutCategory / monthlyRent / rentMode / viewingMethod / remark / listingStatus / tags / video / published / enabled / sourcePresent / archivedAt`。身份和生命周期字段优先冻结周期事件中的值，事件明确为空时也不得回退为当前主档旧值；位置、房号、户型、租金、出租方式、标签和视频等业务字段冻结当期当前主档快照。

“房源状态流水”固定 13 个语义字段：`historyEventId / foundationListingId / sourceRecordId / availabilityCycleNo / availabilityCycleId / eventType / fromLifecycleStatusText / toLifecycleStatusText / eventAt / runId / listingOwner / ownerDepartment / lifecycleVersion`。所有字段继续使用环境中的稳定 `field_id` 绑定，不依赖显示列名或列顺序。

合同 Excel 不是持续状态源，只允许一次性读取 `房源ID / 房间ID / 房源负责人 / 所属部门` 四项白名单用于补全当前主档；不得导入租客姓名、手机号、证件、合同状态、起止日期或其他租客数据，也不得用合同状态覆盖员工待租表。无法唯一匹配的当前房源继续使用临时 ID；负责人或部门缺失可以留空，但身份冲突必须人工复核。负责人、部门发生变化时允许形成可审计交接：`lifecycleVersion` 加一，先追加并回读“责任归属变化”流水，再更新当前主档；新增寓小二身份同时写入排序稳定的 `identityAliases`。负责人、部门、真实/临时身份和物理房源键只保存在目标 Base 内部主档、归档和流水中，不进入服务器公开库存投影或固定十列待租表。

一次性补全使用 `server/scripts/feishu-foundation-enrich.js`，映射 JSON 必须放在仓库之外，每行必须且只能包含 `sourceRecordId / yuxiaoerListingId / yuxiaoerRoomId / listingOwner / ownerDepartment` 五项。工具默认只预演：

```powershell
node server/scripts/feishu-foundation-enrich.js --mapping D:\private\foundation-mapping.json
node server/scripts/feishu-foundation-enrich.js --mapping D:\private\foundation-mapping.json --apply --confirm-sha256 <上一条命令输出的 planSha256>
```

预演同时输出映射原始字节的 `mappingSha256` 和实际写入计划的 `planSha256`。正式执行确认的是后者；计划摘要绑定目标 Base、当前主档表、流水表、映射原始字节、两张表的完整语义快照、当前表更新补丁和待追加流水。任一目标记录、流水、表资源或映射字节发生变化，都在首笔写入前拒绝旧摘要。即使绕过命令行直接调用执行入口，正式模式也必须提供同一计划摘要。命令行只输出计数与摘要，业务错误使用固定单行分类，不回显源记录 ID、寓小二 ID、负责人、部门、文件路径或飞书原始错误。

AI 数据底座在旧镜像配置上增加以下环境项；示例只使用占位符，真实 token、table ID 和 field ID 不得写入仓库：

```env
FEISHU_SOURCE_COMPATIBILITY_PROFILE=employee-ai-foundation-v1
FEISHU_RENTED_TABLE_ID=tbl_rented_placeholder
FEISHU_HISTORY_TABLE_ID=tbl_history_placeholder
FEISHU_RENTED_FIELD_BINDINGS={"archiveKey":"fld_archive_key","foundationListingId":"fld_foundation_id","temporaryListingId":"fld_temp_id","yuxiaoerListingId":"fld_yx_listing_id","yuxiaoerRoomId":"fld_yx_room_id","identityType":"fld_identity_type","physicalUnitKey":"fld_physical_key","sourceRecordId":"fld_source_record_id","availabilityCycleNo":"fld_cycle_no","availabilityCycleId":"fld_cycle_id","lifecycleStatusText":"fld_lifecycle_status","vacancyNote":"fld_vacancy_note","sourceCreatedAt":"fld_source_created_at","metricKind":"fld_metric_kind","lifecycleDays":"fld_lifecycle_days","listingOwner":"fld_listing_owner","ownerDepartment":"fld_owner_department","identityAliases":"fld_identity_aliases","lifecycleVersion":"fld_lifecycle_version","previousLifecycleStatusText":"fld_previous_status","locationId":"fld_location_id","locationRecordId":"fld_location_record_id","city":"fld_city","district":"fld_district","block":"fld_block","community":"fld_community","latitude":"fld_latitude","longitude":"fld_longitude","roomLabel":"fld_room_label","building":"fld_building","unit":"fld_unit","roomNumber":"fld_room_number","layoutDescription":"fld_layout_description","layoutCategory":"fld_layout_category","monthlyRent":"fld_monthly_rent","rentMode":"fld_rent_mode","viewingMethod":"fld_viewing_method","remark":"fld_remark","listingStatus":"fld_listing_status","tags":"fld_tags","video":"fld_video","published":"fld_published","enabled":"fld_enabled","sourcePresent":"fld_source_present","archivedAt":"fld_archived_at"}
FEISHU_HISTORY_FIELD_BINDINGS={"historyEventId":"fld_history_event_id","foundationListingId":"fld_foundation_id","sourceRecordId":"fld_source_record_id","availabilityCycleNo":"fld_cycle_no","availabilityCycleId":"fld_cycle_id","eventType":"fld_event_type","fromLifecycleStatusText":"fld_from_status","toLifecycleStatusText":"fld_to_status","eventAt":"fld_event_at","runId":"fld_run_id","listingOwner":"fld_listing_owner","ownerDepartment":"fld_owner_department","lifecycleVersion":"fld_lifecycle_version"}
```

启用 AI profile 前，`FEISHU_MINI_FIELD_BINDINGS` 必须补齐上述 18 个当前主档字段，其中目标 `vacancyNote` 仍是必建文本列；当前 17 列员工现表的 `FEISHU_SOURCE_FIELD_BINDINGS` 保持既有 `viewingMethod` 绑定且省略 `vacancyNote`。只有未来确有独立空出列时才可额外绑定源 `vacancyNote`，并继续通过 `field_id` 不重复门禁。员工源表、位置字典、当前主档、已出租表和流水表五个“Base token + table ID”资源必须互不重叠；一次性补全入口还会在取得 token、创建客户端或读取表前再次核验员工源 Base 与目标 Base 分离、当前主档与流水表独立，以及两表字段契约完整。上线顺序固定为：保持自动同步关闭 → 用应用身份完成五表字段与只读/写权限校验 → dry-run 对账源记录、当前主档、拟归档、拟流水和公开十列表数量 → 一次人工正式同步并回读四张目标表 → 核对公开库存和待租表 → 再单独授权打开自动同步。紧急止写必须关闭同步总开关，不能把 profile 改回 `employee-current-stock-v1` 当作数据回滚；代码会在旧 profile 写入时保护 17 个底座专有字段不被 full write 清空。旧 profile 只有在源表确有独立 `vacancyNote` 绑定时才同步该字段，且不负责从“看房方式”维护生命周期语义。正式回滚仍按本节既有总开关流程执行，禁止直接删表或用员工源反向覆盖归档。

启用顺序必须是：在小程序专用 Base 内复制/新建位置字典与专用源表并核对字段类型 → 在飞书文档的应用权限中授予所配置自建应用对员工源 Base 的读取权限、对小程序专用 Base 的可编辑权限 → 用应用身份分别验证员工源可读、位置字典/专用表可读以及专用表可写 → 成对配置 source/target Base token、三个 table ID 与 `field_id`；仅当前 17 列员工现表使用上述兼容 profile，新建标准源表应清空 profile 并显式绑定 `rentMode/listingStatus` → 保持 `FEISHU_AUTO_SYNC_ENABLED=false` → 后台先执行 dry-run → 人工携同次内容计划确认执行一次正式同步并核对专用表、库存和十列待租表计数。若房源笔记素材同步同时开启，当前内置定时任务没有自动生成确认摘要的能力，自动开关必须继续保持 `false`；未来只有经过独立审计的两阶段自动控制器可以恢复它。目标 Base 没有应用“可编辑”权限时，dry-run 仍可能完成全量只读校验，但正式同步会被飞书写权限拒绝且不会进入库存发布，不能把 dry-run 通过误认为已具备写权限。

未启用员工 profile 的旧单 Base 配置仍受兼容支持，但运行时也会为同一个 Base 分别创建硬只读源客户端和可写目标客户端；源读取与目标表写入不得复用同一客户端。员工 profile 继续强制源、目标 Base 分离。

管理接口的 `dryRun` 只接受 JSON 布尔值 `true/false`，字符串、数字、对象或数组均返回 400，避免“响应显示预演但实际写专用表”。公开 `GET /mini/company-sheet-snapshot` 在镜像模式只读最后一次完整快照，绝不因游客访问触发飞书写入。任一分页、字段、位置、附件、回读、库存或快照阶段失败都不提交数据库；撤下熔断以“专用表历史公开 ID + 当前线上活跃飞书库存 ID”的并集为基线，因此专用表为空或被重建也不能绕过，数量阈值和比例阈值任一超限即在首个专用表写请求前停止。当前内置定时任务不会生成或保存人类确认摘要；镜像与笔记素材同时开启时，它会因缺少确认在源表读取和目标写入前 fail-closed。除非后续另行实现并审计“先 dry-run、再绑定同计划正式执行”的自动控制器，否则必须保持 `FEISHU_AUTO_SYNC_ENABLED=false`，不得把手动确认值长期写入环境变量或复用上一轮摘要。

紧急止写应设置 `FEISHU_SYNC_ENABLED=false`。需要回滚到旧模式时，先关闭自动同步和镜像开关，确认没有在途任务，再同时清空 source/target 两项新 token 并恢复旧 Base/Sheet 配置，重启后先 dry-run 和计数对账；不得只清一个新 token，也不要在未对账时直接切回旧 Sheet，避免半配置或重新形成双事实源。

#### 小程序专用素材库复制

`server/scripts/feishu-material-copy.js` 用于把员工旧素材库中的视频复制到小程序专用素材库。它默认只做只读预演；实现只允许列目录、创建子目录和复制文件，不提供移动或删除操作，因此员工原素材目录保持原样，“历史归档”目录也不参与本工具的读取、计划或写入。

计划输入和续传状态都必须保存在仓库外的私有 JSON 文件中；工具会对逻辑路径、真实路径和现存父目录逐层校验，路径位于仓库内或经 junction/符号链接绕回仓库时均在创建 Drive 客户端前阻断。不得把目录 token、真实房源或其他生产数据写进仓库。三项根目录含义固定如下：

- `sourceRootToken`：员工当前“房源素材”根目录，只读。
- `activeRootToken`：新素材库的“在架素材”根目录；必须传“在架素材”本身，不能传它下面的“杭州”子目录。
- `pendingRootToken`：新素材库的“待确认”根目录，用于承接重复、未知别名、房源键异常、目录名与文件名身份冲突或未匹配素材。

三个根目录必须各不相同，且任意两者不得互为父子目录。示例仅包含占位值：

```json
{
  "sourceRootToken": "source_root_placeholder",
  "activeRootToken": "active_root_placeholder",
  "pendingRootToken": "pending_root_placeholder",
  "maxDepth": 12,
  "locations": [
    {
      "locationId": "location_placeholder",
      "city": "城市占位",
      "district": "行政区占位",
      "block": "板块占位",
      "community": "小区占位",
      "aliases": ["别名占位"],
      "enabled": true
    }
  ],
  "listings": [
    {
      "sourceRecordId": "source_record_placeholder",
      "locationId": "location_placeholder",
      "building": "1",
      "unit": "1",
      "roomNumber": "101",
      "published": true,
      "canonical": true,
      "enabled": true
    }
  ]
}
```

位置字典只有原生 JSON 布尔值 `enabled: true` 才参与计划；房源也必须同时满足 `published/canonical/enabled` 三项原生布尔值为 `true`。工具会同时解析视频所在叶子目录和文件名：只有一方可解析，或双方都解析到同一物理房源时，才可继续匹配；双方分别指向不同房源时固定进入“待确认/身份冲突”，禁止按先到候选静默归档。唯一精确匹配的素材复制到 `在架素材/城市/行政区/板块/位置ID__标准小区/楼栋__单元__房号/`，歧义或未匹配素材复制到“待确认”的原因分组。支持的视频扩展名固定为 `.mp4/.mov/.m4v/.avi/.webm`。

先执行只读预演并保存输出中的计数、阻断项和计划 SHA-256：

```powershell
node server/scripts/feishu-material-copy.js --input D:\private\feishu-material-plan.json
```

只有预演 `blockers=0`、人工核对计数与目录去向无误，并且输入文件及三处目录内容未变化时，才可用同一输入文件和该次输出的完整 SHA-256 二次确认真实复制。`--resume-state` 必须指向仓库目录之外的私有 JSON 文件；它包含目录 token、素材身份与回读 token，不得提交、外发或写入普通日志：

```powershell
node server/scripts/feishu-material-copy.js --input D:\private\feishu-material-plan.json --resume-state D:\private\feishu-material-resume.json --apply --confirm-plan-sha256 <64位计划摘要>
```

`--apply` 会重新读取三处目录并重算摘要；任何清单、修改时间、映射或目标冲突变化都会拒绝使用旧摘要。Drive 目录分页必须同时提供数组清单和严格布尔 `has_more`，继续分页必须提供新的非空、非重复字符串 token，缺项、错型、循环或超过安全页数都会 fail-closed。首次执行会用最终状态路径独占创建空回执；回执 v3 为每个 `inFlight` 增加阶段。每项操作在创建目标子目录或复制文件之前先原子落盘 `phase=preparing`；只有内部 Drive 客户端证明复制 HTTP 请求已经进入，并收到 500、`1061001`、超时、网络中断或畸形成功响应这类结果不确定错误，才会再原子落盘 `phase=request-uncertain`。`preparing` 的安全含义是“缺少可自动晋升的可信请求结果证明”，不承诺 POST 一定为 0；建目录失败、复制前同名冲突、确定性 4xx、进程在 POST 前中断，以及正常复制响应后严格回读冲突/超时都会保持该阶段并硬阻断，即使之后出现唯一同名文件也不得自动晋升或重发。目录创建、正常复制和不确定复制的回读都先统计全部同名项目，只有总数恰为 1、类型正确，且正常响应路径 token 与接口返回一致时才接受；同名 `file + folder/shortcut` 必须阻断，不能靠先筛预期类型制造“唯一”假象。只有正常复制响应和该严格回读一致后才把该项转入完成前缀并清空 `inFlight`。回执包含原计划证明、源/目标指纹和回读 token；临时文件使用不可预测名称和独占创建，再原子替换状态文件。

复制接口发生 500/超时这类结果不确定错误时，工具只轮询目标目录；仅 `request-uncertain` 阶段允许在唯一同名文件出现后按回读结果收敛，绝不盲目重发复制请求制造重复文件。若回读仍无结果则保留 `inFlight` 并停止；后续回读仍不可见时继续硬阻断，迟到且唯一的目标文件出现后才可零重发收敛。`preparing` 阶段无论目标是否出现都硬阻断，必须人工查明来源，不得把外来同名文件认作复制结果。恢复时必须先重新 dry-run；工具会重读源与两个目标，校验状态结构与 SHA-256 一致性、源计划未变、已完成项是原动作的严格连续前缀、`inFlight` 恰为下一动作、每个目标 token 唯一匹配且没有额外冲突，然后只生成剩余动作的新 SHA-256。v2 及更早回执不含可信阶段证明，v3 工具一律拒绝自动迁移、晋升或重发；必须原样保留旧回执和外部请求证据，另行完成一次性只读审计后才能制定人工迁移方案。`stateSha256` 是无密钥的一致性校验，不是抵抗持有文件写权限者的认证；状态文件必须放在可信、仅运维账号可写的私有路径，未来若需跨账号托管应另配 HMAC：

```powershell
node server/scripts/feishu-material-copy.js --input D:\private\feishu-material-plan.json --resume --resume-state D:\private\feishu-material-resume.json
node server/scripts/feishu-material-copy.js --input D:\private\feishu-material-plan.json --resume --resume-state D:\private\feishu-material-resume.json --apply --confirm-plan-sha256 <新的64位续传摘要>
```

状态文件缺失、落在仓库内、原计划或源清单变化、完成项不是严格前缀、目标 token 不一致、存在额外目标冲突时均拒绝续传且写入为 0。普通 `--apply` 发现状态文件已存在会拒绝覆盖；初次执行和续传的整个 build/重验/Drive 写生命周期还会独占 `${resumeState}.lock`，并发任务只有一个可以进入。不得改用移动、删除、覆盖或直接重跑原计划来“修复”。

若进程被强杀或机器断电，锁文件可能保留。只允许在确认没有任何素材复制进程后处理：先备份并保留原状态文件，核对同路径 `.lock` 确属这次中断，再只删除该 `.lock`；随后必须使用 `--resume` 重新 dry-run 和续传，禁止普通 `--apply`。不要按文件年龄自动清理锁，也不要删除或改写状态文件。

#### 员工源表“房源笔记”素材同步

该链路与上面的历史素材库复制工具互相独立。它只在
`employee-current-stock-v1` / `employee-ai-foundation-v1` 员工源 profile 下读取员工源 Base
中稳定字段 ID `fldyeAGJHV`，并要求飞书字段 API 回读类型为超链接（类型码 `15`）。员工改显示列名
不会影响读取；同步客户端以 `readOnly=true` 建立，任何员工源 POST/PATCH/DELETE 都会在发请求前
被拒绝。“房源笔记”不会复制进小程序专用房源表，也不会把原始链接写入数据库或公开接口。

单元格只接受白名单租户 HTTPS 下的 `folder/file/docx/wiki` 路径，禁止用户名、密码、非 443
端口、重定向、编码路径分隔符和非白名单主机。文件夹、文档和 Wiki 会完整分页并递归展开；
默认最大深度 8、最多检查 5000 项，重复引用会去重，循环、跨房源复用同一源 token、分页异常或
超过上限都会在首个目标写入前阻断。飞书客户端在分页累计超过 `maxItems` 的当页立即停止，不会
先读完最多数万条元数据再由解析层拒绝。当前进入小程序的素材只支持 `.mp4/.mov/.m4v/.webm` 视频；
图片和普通文件只计入 `nonVideo` 对账，不复制、不公开，验收时必须单独报告，不能声称已经同步。

每套房的规范飞书目录固定为：

```text
目标素材根目录/
  房源笔记导入-v1/
    行政区/
      板块/
        locationId__标准小区/
          楼栋__单元__房号/
```

目录和文件都在写后按同名全量回读验证；同名异类型或多项冲突立即失败。素材 ID 只由员工源
`sourceRecordId + 资源类型 + 源 token` 生成，因此文件改版不会改变素材身份；每次同步都先受限
下载当前源文件并计算完整 SHA-256，完整内容摘要进入目标文件名与 OSS 对象键。相同 token 即使
文件名、大小和修改时间都未变化，只要实际内容变化，也会生成新的 Drive 文件名与 OSS 对象键，
旧版本不会被覆盖；同一内容重跑则复用同名同键且零重复写。计划阶段逐项下载后只保留摘要、
大小和类型，不在内存计划中保存视频 Buffer；正式阶段先逐项完成全批第二遍内容预检，全部通过后
再第三遍逐项重下并核对计划摘要。Drive 不再按可变源 token 调服务端复制，而是上传第三遍刚校验的
同一 Buffer，随后把目标文件下载回读，再把回读一致的内容写 OSS 并释放。因此内存上界由单个视频
而不是 64 个视频总和决定。每个视频验证目标云盘内容摘要后，确定性写入
`ALI_OSS_UPLOAD_DIR/feishu-note-v1/...`，并通过 OSS 鉴权 GET 回读实际字节数和 SHA-256。
源发现集合、目标云盘集合、OSS 集合、私有清单集合不完全相等时，整套房视频不得发布。
复用已有目标前仍必须按相同源 token 重新下载当前源内容；即使文件名、大小、修改时间均未变化，
内容摘要不同也必须重新物化。单套房最多 64 个视频；第 65 个视频会在创建目录、上传 Drive 或写
OSS 之前整套拒绝，避免外部孤儿写入后才被领域层上限驳回。

每次完整的素材 dry-run 和正式 apply 还会返回私有聚合字段
`contentPlanSha256`（64 位小写十六进制）与 `contentPlanAssetCount`。摘要使用固定
`feishu-note-content-plan-v1` 版本，按源记录不可逆 SHA-256 指纹、`assetId`、本次受限下载得到的
真实内容 SHA-256、真实字节数、规范 MIME 类型和 `displayOrder` 排序后计算；输入记录或素材数组
换序不会漂移，但任一归属、内容、大小、类型或展示顺序变化都会改变摘要。摘要响应不包含员工源
记录 ID、源/目标 Drive token、链接、目录、Buffer、OSS 对象键或源文件名；这些计划字段也不写入
房源、公开投影或普通同步日志。零视频有固定的空计划摘要。只要任一记录失败、状态冲突或最终
`complete=false`，两个字段都省略，禁止把部分摘要用于确认正式同步。正式 apply 会返回本轮实际
内容的同一聚合摘要；第二遍全批预检和第三遍写前下载继续核对内容 SHA-256、字节数与 MIME 类型，
任一变化都在对应写入前失败。需要双次 dry-run 确认的运维控制器必须把这两个字段纳入外层
`PLAN_SHA`，不能只比较链接、token、文件数量或易失元数据。

当镜像与房源笔记素材两项开关同时开启时，正式同步入口会先固定本轮 `runId/nowMs`，用正式
working DB 的隔离 clone、同一源/目标表只读适配器和同一素材只读适配器完整重跑
“镜像 dry-run → 新源行应用到 clone → 素材 dry-run → 首页快照预演 → 最终阶段分类”。正式入口
在该预检之前还会先核对固定素材字段、白名单，以及满足
`^[A-Za-z0-9_-]{8,160}$`、独立且非旧源目录的目标根。若服务端内部显式注入素材 Drive 适配器，
它必须同时实现目录分页、源下载、目标目录创建、视频落盘和目标回读校验五项能力；显式注入 OSS
适配器必须同时实现确定性写入和鉴权回读校验两项能力。任一确定性配置或适配器合同不成立，都会
在员工源或目标 Base 的首个镜像读写前返回 503。该预检得到的聚合摘要
和数量必须与请求的 expected 两项精确一致，才允许开始目标 Base、工作 DB、Drive 或 OSS 的正式
阶段；同一 token 若在人类 dry-run 后、服务端完整正式预检开始前已经原位换字节，会在首个正式
写入前阻断。预检私下还保留仅由不可逆记录指纹、素材 ID、内容摘要、大小、MIME 和顺序组成的
行级计划，不进入 JSON 响应、日志、房源或公开投影。

正式素材阶段再次先为全部 `resolvedRows` 做只读计划并与上述私有行级计划聚合比对，早于任一
素材目录、Drive、OSS 或媒体清单写入；随后逐行正式处理时还会在该行首个 Drive/OSS 写入前重新
下载并逐项比对同一行计划，之后继续保留原有全批复核和单素材写前下载门。若任一层变化，错误按
内容计划确认失败分类，失败响应不生成可复用摘要；最终正式响应的
`contentPlanSha256/contentPlanAssetCount` 也必须与 expected 完全一致，否则顶层强制
`inventoryCommittable=false`，数据库不得提交。

全批第二遍预检保证预检期间任一素材变化时三类外部写入均为 0。飞书源没有可锁定的内容快照；
若后序素材在全批预检通过后、第三遍逐项写入期间才发生变化，任务会在该素材写入前失败关闭，
不会发布私有清单或公开能力，但此前已写的内容寻址目录/对象可能暂留并供后续同内容重跑复用。
遇到该状态只允许先只读对账后重跑，禁止按名称盲删、覆盖或跳过摘要门禁。

素材 dry-run 仍会只读下载源文件并计算上述真实内容摘要与聚合 `contentPlanSha256`，确保正式计划
不会只凭易失元数据假绿；但不得创建 Drive 目录/文件、写 OSS 或改数据库。只有两次完整预演的
`contentPlanSha256/contentPlanAssetCount` 与外层计划摘要都一致后，才允许执行一次正式同步。

同一房源的全部视频成功后，服务端才通过领域层原子替换 `mediaAssets`。空链接只清除
`feishu-note-v1` 管理的视频，保留人工上传或旧视频；永久错误、物理房间变化、房源不在架或
链接指纹变化会清除笔记管理视频。只有相同链接指纹、相同且非空物理房间、房源仍在架、已有
视频且错误属于网络、限流、临时权限或 5xx 时，才允许保留上轮已验证清单。库存同步失败时素材
阶段完全不启动；素材失败不会回滚已经成功的库存字段，但本轮 `noteMaterials.published=false`，
必须单独处理后才能声称素材同步完成。服务端明确拆分两个状态：`inventoryCommittable=true`
表示库存与首页快照可原子提交；只有素材也完整成功时顶层 `success=true`。库存提交后素材失败时
顶层固定为 `success=false/status=inventory-published-materials-failed`，后台面板和定时任务日志
必须显示“库存已提交，但素材同步未完整成功”，不得写成整体完成。

每条记录在开始解析时固定完整媒体状态键；目标处理前后、发布以及失败清理都必须继续使用同一
旧键做 CAS。若另一同步任务已更新任一素材字段，旧任务只记录 `state-conflict`，不得用重新计算
出的新键清空或覆盖新状态。目录分页必须逐页核验 `has_more/page_token`，缺失或重复 token 立即
失败；上传后的飞书目标文件还必须下载回读并核对字节数和 SHA-256，不能只相信上传接口响应。

新增环境变量如下，真实 token、租户域名和凭据只放服务器环境，不写仓库：

```env
FEISHU_NOTE_MATERIAL_SYNC_ENABLED=false
FEISHU_NOTE_MATERIAL_FIELD_ID=fldyeAGJHV
FEISHU_NOTE_MATERIAL_ALLOWED_HOSTS=tenant.example
FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN=
FEISHU_NOTE_MATERIAL_MAX_DEPTH=8
FEISHU_NOTE_MATERIAL_MAX_ITEMS=5000
```

新链路默认关闭，且目标根目录必须显式配置，不能回退或等于旧
`FEISHU_MATERIAL_FOLDER_TOKEN`。首次启用顺序固定为：先关闭
`FEISHU_AUTO_SYNC_ENABLED` → 配置独立目标根和白名单 → 显式把
`FEISHU_NOTE_MATERIAL_SYNC_ENABLED` 改为 `true` → 重启后连续运行两次 `dryRun=true` →
核对两次内容计划一致且预演零目标 Base/Drive/OSS/数据库写入 → 把最后一次 dry-run 的两项确认值
原样放入一次性正式请求 → 人工正式同步一次并完整对账。当前内置定时任务没有两阶段确认能力，
所以笔记素材开关保持开启期间自动同步必须继续关闭；只有未来独立实现并审计自动两阶段控制器后
才可恢复自动同步。
dry-run 允许解析源集合但不得创建目录、上传云盘、写 OSS 或替换媒体。正式同步后必须同时回读
顶层 `success=true`、`noteMaterials.complete=true`、
`noteMaterials.published=true`，并对账 `video/nonVideo/duplicateReference/failed/retained/cleared`
等汇总，同时核对 `contentPlanSha256/contentPlanAssetCount` 与已确认计划一致。公开响应只允许
`assetId/kind/displayOrder/label` 和 API 能力地址，不得出现原始链接、
飞书 token、云盘路径、OSS key、源文件名、源记录 ID 或私有同步状态。

同步规则：

- 房源表和视频素材库按房号/楼栋单元房号等 Key 对齐。
- 飞书表仍在架的公司房源会写入或更新本地房源，并标记 `companyListing=true`、`noCommission=true`。
- 飞书行缺少合法联系电话时不再整行跳过：同步结果增加 `missingLandlordPhone` 计数，逐行对账和摘要写“联系电话待补充”，公开租金/房态继续创建或更新。服务端优先采用表内合法号码，其次保留线上已有合法号码；两者都没有时只保存空值和待补标记，绝不把占位文字或无效号码落库。该放宽仅存在于内部飞书同步调用，人工上传/编辑与旧客户端仍由领域校验强制 11 位手机号。
- 飞书同步同时用 `feishuRecordId` 和“小区+楼栋+单元+房号”物理房源键复用旧房源；同一物理房源即使 record_id 变化，也必须保持同一个 `listing.id`，避免推荐卡片指向的旧 id 被下架再重建。
- 物理房源键必须具备最小具体性：小区、楼栋、房号缺任一项，或楼栋/房号为 `-`、`无`、`null` 等占位值时，不生成物理合并键，只按 `feishuRecordId` 精确匹配，宁可重复也不误合并。
- 飞书表删除、下架、关闭、已租等状态会让对应公司房源自动下架，进入后台资产池。
- 飞书 `标签`/`房源特点`/`特点` 列的自由文本会作为 `rawFeatures` 参与服务端自动特色推断；真正写入 `listing.features` 的只有白名单特色。示例：`南北通透` 推断为 `采光好`，`独立卫生间` 推断为 `独卫`，`阁楼/露台/花园` 统一推断为 `带露台（阁楼）`；`无燃气`、`不通煤气`、`非近地铁` 这类否定表达不得误打标签。
- 素材缺失、素材下载超时、OSS 转存失败或素材超过当前视频大小上限时，飞书房源不会被静默丢弃，会照常上架并在后台标记 `missingVideoMaterial=true`，同时保留失败原因供对账。新建公司房源没有素材时仍以无视频状态创建。旧视频保留采用双门：更新前状态必须是明确正向的持续在架值，且旧持久化物理键、旧房源字段计算出的物理键与本轮完整“小区/楼栋/单元/房号”键必须全部一致；成交、签单、已出租、不租了、暂停、失效、未上架/不上架/未在租/不在租、物理键变化或证据不完整均 fail-closed。同一房源通过双门且已有可解析为受控上传目录对象键的视频时，本轮暂时未匹配素材或转存失败才保留规范化 `videoKey`，并用 `videoMaterialStatus=沿用上次视频·素材待核` 区分本轮成功，推荐画像继续按可播放处理。同 token 的旧对象复用也受同一双门约束；本轮显式新视频优先，URL-only 新素材会清空旧 key，避免新 URL 与旧房源对象键拼接。沿用时只保留旧素材 token、名称/路径与规范化 key，`videoUrl/sourceMaterialUrl` 和派生短签一律清空。任意外链和畸形 key 仍会全部清空。素材重新成功后状态恢复“已匹配视频素材”；飞书删除、下架、关闭或已租仍按原规则下架。曾下架/过期后重新出现的房源必须以本轮素材为准，无素材时清空旧视频，不能让旧装修或旧租期视频随恢复状态重新公开。本保护只能作用于同步开始时仍有受控旧视频证据的房源，不能自动重建此前已被清空的媒体；备份回填或生产修复必须另行只读核源并取得授权。
- 公司房源即使缺视频，也可进入公司房源专区、全部房源列表、首页推荐、筛选、统计与地图；地图小区聚合和套数统计纳入缺视频公司房源，但 callout 与侧边卡片不显示视频标签。小程序列表明确显示“暂无视频”，详情显示无保存/转发按钮的“暂无房源视频”空态；有真实视频时播放器、匿名播放、保存和转发规则不变。二房东房源、业主房源仍必须带真实视频。
- 管理后台房源列表支持 `missingVideoMaterial=missing|ready` 查询，页面里可直接筛“缺视频素材”。
- `server/scripts/feishu-sync-audit.js` 可只读 dry-run 输出逐行对账表：房号、表内状态、匹配素材、同步结果、失败原因。
- 定时同步使用系统任务名触发时，服务端会自动落到库里的真实管理员身份执行新增/更新，避免新增公司房源因 `system-feishu-sync` 不是用户账号而失败。
- 旧模式兼容规则：`户型描述` 以 `（整）` 或 `(整)` 开头时解析为整租，否则按合租处理；镜像模式默认必须使用明确出租方式列，只有显式 `employee-current-stock-v1` profile 会按本节列出的封闭规则兼容真实 17 列员工现表。
- 旧模式兼容规则：板块到行政区仍使用服务端既有映射；镜像模式的行政区、板块、小区与坐标只来自小程序位置字典。
- 旧模式即使出现 `mapLatitude/mapLongitude` 同名列也不会把它们标成已核坐标；只有经过位置字典完整校验的 canonical 镜像适配器可以写入逐套地图坐标。公开待租快照会二次清除电话、微信、密码以及 HTTP(S)、FTP、文件、飞书、Lark、data、javascript、mailto、tel 和 `www` 形式的链接。

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
FEISHU_SYNC_ENABLED=true
FEISHU_AUTO_SYNC_ENABLED=true
FEISHU_MIRROR_SYNC_ENABLED=false
FEISHU_MATERIAL_FOLDER_TOKEN=
FEISHU_NOTE_MATERIAL_SYNC_ENABLED=false
FEISHU_NOTE_MATERIAL_FIELD_ID=fldyeAGJHV
FEISHU_NOTE_MATERIAL_ALLOWED_HOSTS=tenant.example
FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN=
FEISHU_NOTE_MATERIAL_MAX_DEPTH=8
FEISHU_NOTE_MATERIAL_MAX_ITEMS=5000
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
- `GET /admin/listing-filter-options`
- `GET /admin/listings`
- `GET /admin/expired-listing-filter-options`
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

小程序当前 `paymentMode=manual` 时，`app.bindWechatOpenid()` 在方法入口直接结束，不调用 `wx.login`，也不请求预留的 `POST /mini/auth/wechat-openid`。该门禁放在公共方法自身，而不是只依赖启动调用方，避免手机号登录成功后仍误发 OpenID 绑定请求。只有未来显式切到 `wechat` 模式时才执行绑定；code 返回前或接口返回前若本机会话已切换，迟到结果不得覆盖新账号。

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

## 小程序手机号登录注册的协议同意门

- `pages/auth/auth` 的协议勾选默认值固定为未同意；登录和注册共用同一提交守卫，未主动勾选《用户服务协议》和《隐私政策》时只给本地提示，不调用 `/mini/auth/login` 或 `/mini/auth/register`。
- 两份协议是无需登录的独立小程序页面。运营主体固定展示为“杭州初寓网络科技有限公司”，联系邮箱为对外公开业务邮箱；隐私政策按真实链路明确手工填写的手机号/姓名、密码哈希、持久登录凭证与内存会话标识、房东手机号、业务姓名展示、请求日志、实时 ASR、语音自动找房、脱敏助手追踪记录、可配置大模型、保存期限、软删除、共享/委托边界与用户权利，并明确当前版本不获取用户实时地理位置。
- 打开任一协议页面不会自动勾选；取消勾选会立即恢复提交阻断。同意状态只存在于当前登录注册页面实例，不写入本地持久化，也不混入登录/注册 API 参数。原服务端账号审核、密码哈希、token、游客会话、权限和数据库结构均不变。
- 后台管理员可查看注册审核所需的姓名和完整手机号；企业协作通知（飞书）只发送姓名与打码手机号。上传房源时提交房东手机号的用户必须已获得信息主体合法授权或具备其他合法处理依据。
- 微信公众平台“用户隐私保护指引”必须与小程序内文案保持一致，尤其是处理主体、手工填写手机号/姓名、麦克风实时传输和自动找房用途、实际启用的 ASR/大模型服务类型、保存期限、软删除、第三方处理与权利联系入口；本地页面不能替代公众平台后台声明。不得申报未使用的 `wx.getPhoneNumber` 或重新加入精确定位。
- 承重门禁为 `server/scripts/mini-auth-consent-v1-test.js`：锁定默认未同意、未同意零 API、同意后原参数恰好一次、取消同意、协议入口不触发勾选、页面四件套、主体/邮箱/关键披露与禁止回流 `getPhoneNumber`。该脚本已纳入 `v1-final-audit.js`。

```bash
cd server
node scripts/mini-auth-consent-v1-test.js
```

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
