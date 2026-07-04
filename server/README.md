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

足迹留痕写入统一经过后端截断。代码默认 `FOOTPRINT_MAX_ROWS=5000`，最低不会低于 `1000`；生产 systemd 服务显式设置为：

```ini
Environment=FOOTPRINT_MAX_ROWS=30000
```

数据库 JSON 默认紧凑写入以降低整库重写的磁盘写放大；如需人工排查可设置 `DB_JSON_PRETTY=1` 恢复两空格缩进（`/admin/data/export` 导出始终为美化格式，不受影响）。

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

- 公司房源：公司自营或飞书同步房源，`companyListing=true` 或来源文本包含公司房源。
- 二房东房源：合作房源，`ownerType=二房东房源`。
- 业主房源：合作房源，`ownerType=业主房源`。

视频规则：

- 公司房源免视频，允许无视频进入公司房源列表和详情。
- 二房东房源、业主房源必须带真实视频，`videoUrl` 或 `videoKey` 至少有一个。
- 视频文件本体不进 `db.json`，房源只保存访问地址或 OSS 对象 Key。
- 有 `videoKey` 时，详情接口会生成短期签名播放地址，默认有效期由 `ALI_OSS_READ_URL_EXPIRE_SECONDS` 控制，当前默认 `900` 秒。

房源可见性：

- 前台有效房源会排除已失效、已下架、已成交和待审核未通过房源。
- 公司房源公开完整字段。
- 合作房源列表与详情不直接公开完整地址和房东电话；敏感查看必须登录并留痕。
- 地图只按小区聚合展示，不展示具体楼栋、单元、房号、房东电话或看房密码。

房态规则固定为第 3 天提醒、第 5 天再次提醒、第 7 天未更新自动失效。失效房源保留在后台资产池，可由管理员恢复。

## 分佣规则

分佣由服务端固定计算，客户端提交的 `brokerId`、`uploaderId`、`commissionRate` 或同名字段不能影响结果。

现行规则：

- 成交后按房东实际支付佣金总扣 `20%`。
- 二房东房源：上传人 `15%`，平台 `5%`。
- 业主房源：上传人 `20%`，平台 `0%`。
- 公司房源：不分佣，不生成分佣记录。
- 管理员上传的合作房源：仍记录房源类型，但上传人是管理员；确认签单时上传人分佣为 `0%`，平台拿到总扣 `20%`。

签单只能从报备记录发起。中介提交签单时只填写成交月租、房东实际支付佣金和可选备注；管理员确认后才生成正式分佣记录。金额统一按分存储，避免小数误差。

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

除板块映射外，`config.js` 还提供 `communityDistrictOverrides` 小区级覆盖表（小洋坝家园一/二/三区、大华海派风景、风雅乐府、瑷颐湾等归余杭区）。**小区级覆盖优先级高于板块映射**：命中覆盖表的小区直接按覆盖行政区归属，不再落回板块所属区。飞书同步、快照房源和前台筛选都使用同一套 `districtForLocation` 映射入口，后续扩展行政区时优先改服务端配置。

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
- 飞书表删除、下架、关闭、已租等状态会让对应公司房源自动下架，进入后台资产池。
- 素材缺失的飞书房源不会被静默丢弃，会在后台标记 `missingVideoMaterial=true` 和 `缺视频素材`。
- 公司房源即使缺视频，也可进入普通公司房源列表；地图仍要求真实小区坐标。
- `户型描述` 以 `（整）` 或 `(整)` 开头时解析为整租，并去掉前缀保存净户型；否则按合租处理。
- 板块到行政区映射由服务端配置决定：闸弄口、新塘、元宝塘、东站归上城区，其余现有板块归拱墅区；命中 `communityDistrictOverrides` 的小区（如小洋坝家园、大华海派风景、风雅乐府、瑷颐湾等）优先归余杭区。

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
