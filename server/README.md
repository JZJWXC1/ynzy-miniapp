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

- `GET /healthz`：进程探活，正常返回 `ok: true`。
- `GET /readyz`：上线就绪检查，依赖配置项完整性，不通过时返回 `503`。

HTTP 内测链路已废弃。不要再使用旧公网 IP、`--internal-http` 或 IP 直连方式做体验版验收；小程序端当前配置见 `utils/deploy-config.js`，默认请求 `https://zf-api.ynzyqbot.cn`。

## 数据文件与备份

当前仍使用 JSON 文件模拟正式数据表，默认路径为 `server/data/db.json`，也可以通过 `DATA_FILE` 指向其他文件。

主要数据结构：

- `users`：中介用户。
- `listings`：房源。
- `rentalNeeds`：需求单。
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

小程序登录接口：

```http
POST /mini/auth/login
POST /mini/auth/register
```

登录成功后，后端签发小程序 token，并返回 `token` 与 `tokenExpiresAt`。小程序请求需使用：

```http
Authorization: Bearer <token>
```

鉴权密钥只来自服务端环境变量：

```env
AUTH_TOKEN_SECRET=
```

token 有效期为 7 天。服务端用 HMAC-SHA256 校验 token，过期、签名错误、用户不存在或被禁用都会返回 `401`。

`X-User-Id` 已废除，不能再作为鉴权来源。当前鉴权测试覆盖了伪造 `X-User-Id` 的场景：无 token 访问需登录接口返回 `401`；有合法 token 时，服务端以 token 内的真实用户为准，忽略伪造请求头。

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

必填字段由服务端校验：城市、区域、小区、楼栋、房号、联系方式、租金、户型和特点标签。非公司房源还必须有真实视频。

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

V1 上线自检不再推荐 `npm run smoke`。`server/scripts/smoke-test.js` 是历史综合冒烟脚本，仍保留但不要作为当前 V1 验收主线。

当前 V1 验收脚本为以下五个：

```bash
cd server
node scripts/map-v1-test.js
node scripts/assistant-v1-test.js
node scripts/backend-contract-v1-test.js
node scripts/guest-mode-v1-test.js
node scripts/auth-token-v1-test.js
```

其中覆盖：

- 地图真实坐标与敏感字段边界。
- 助手需求解析与匹配。
- 后端合同规则：视频、分佣、筛选、公司房源可见性、特点标签、报备/签单。
- 游客模式：匿名公司房源可见、合作房源详情 `401`。
- Bearer token 鉴权、7 天有效期、伪造 `X-User-Id` 无效。

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

该脚本会检查关键 V1 脚本存在并运行其中的核心脚本，同时确认 `server/scripts/smoke-test.js` 未被修改。

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
- 不修改 `server/scripts/smoke-test.js`。
- 不把客户端字段当作分佣、上传人或登录身份的可信来源。
- 不在日志中输出完整客户手机号、房东电话、微信号或身份证信息。
