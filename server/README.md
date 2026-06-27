# 寓你住一起后端接口说明

## 当前数据落点

第一版后端已使用本地 JSON 文件模拟正式数据库：

- 用户数据：`server/data/db.json` 的 `users`
- 普通房源：`server/data/db.json` 的 `listings`
- 敏感查看足迹：`server/data/db.json` 的 `footprints`
- 历史积分流水：`server/data/db.json` 的 `pointLogs`，第一版入口隐藏
- 历史充值账单：`server/data/db.json` 的 `rechargeBills`，第一版入口隐藏
- 历史群聊上传记录：`server/data/db.json` 的 `groupUploads`，第一版入口隐藏
- 管理员账号：`server/data/db.json` 的 `adminAccounts`
- LLM 配置：`server/data/db.json` 的 `llmConfig`
- 视频上传记录：`server/data/db.json` 的 `uploadRecords`

正式上线时，这些表建议迁移到 MySQL、PostgreSQL 或微信云开发数据库。

## 启动方式

```bash
cd server
npm start
```

默认服务地址：

- 小程序接口：`http://127.0.0.1:3000/mini/...`
- 管理后台：`http://127.0.0.1:3000/admin-web/`

小程序联调时，`utils/deploy-config.js` 默认请求 `http://127.0.0.1:3000`。拿到正式 HTTPS API 域名后，可在项目根目录运行：

```bash
node scripts/set-miniapp-api.js https://你的API域名
```

本地联调切回：

```bash
node scripts/set-miniapp-api.js --local
```

暂时没有正式 HTTPS 域名、只做公司内部功能测试时，可先使用阿里云 HTTP 公网地址：

```bash
node scripts/set-miniapp-api.js --internal-http http://公网入口地址
```

写入小程序前，建议先体检公网接口：

```bash
node scripts/verify-api.js http://公网入口地址
```

这种方式需要在微信开发者工具里勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”，只用于内部开发测试。正式版和体验版仍建议准备 HTTPS 域名并在微信后台配置合法域名。

## 阿里 OSS 视频存储

你提供的视频存储入口已作为默认地址写入配置：

```env
ALI_OSS_HOME_URL=https://bj33856.apps.aliyunfile.com/disk/admin/home
```

当前后端已提供上传凭证接口：

```http
POST /mini/uploads/video-policy
POST /mini/uploads/group-screenshot-policy
```

正式直传 OSS 还需要补齐：

```env
ALI_OSS_BUCKET=
ALI_OSS_REGION=oss-cn-beijing
ALI_OSS_ACCESS_KEY_ID=
ALI_OSS_ACCESS_KEY_SECRET=
ALI_OSS_SECURITY_TOKEN=
ALI_OSS_PUBLIC_BASE_URL=
ADMIN_TOKEN_SECRET=
```

这些 `ALI_OSS_ACCESS_KEY_*` 建议使用 RAM 子账号，不要使用主账号 AccessKey。RAM Policy 第一版可见上传链路只需要允许访问 `ynzy-house-videos-bj` 下的 `house-videos/*`，用于房源视频上传；`group-screenshots/*` 仅用于历史群聊截图能力保留，第一版不作为可见入口。小程序端不保存 AccessKey，只从后端获取上传策略和短期读取签名。

上线建议：

- 小程序先请求 `/mini/uploads/video-policy`
- 后端生成 OSS POST Policy
- 小程序用 `wx.uploadFile` 直传 OSS
- 上传成功后，把 `videoUrl`、`videoKey` 随普通房源提交到 `/mini/listings`
- 普通房源提交和编辑必须带房源视频；无视频房源不能进入前台有效房源、匹配或地图。
- 普通房源提交和编辑必须带 `features` 数组；第一版可见标签以居住特征为主，例如 `带阳台、干湿分离、燃气、阁楼、露台、花园、近地铁、朝南、独卫、电梯、整租、合租、无`，选择 `无` 时不能和其他标签混用；`免押金`、`不分佣` 仅作为旧数据或内部同步兼容标签，不作为中介上传时的分佣开关。
- 中介上传时不能提交或调整分佣比例；签单经管理员确认后，后端固定按房东实际支付佣金的 20% 计算上传人分佣。
- 数据库只保存视频地址和对象 Key，不保存视频文件本身
- Bucket 建议保持私有。房源详情接口会根据 `videoKey` 生成短期签名播放地址，默认有效期为 `ALI_OSS_READ_URL_EXPIRE_SECONDS=900` 秒。
- 地图只展示真实且经过确认的小区坐标；无可靠坐标的房源可以进入普通列表，但不能进入地图。
- `/mini/uploads/group-screenshot-policy`、`/mini/groups/listings`、`/admin/groups/uploads/:id/review`、`/mini/points/recharge`、`/admin/recharges/:id/review` 和微信支付接口均为历史或后续预留能力，第一版不开放房源群、积分、充值、换群、微信支付入口。

## 管理后台鉴权和房态核验

- 后台登录接口：`POST /admin/auth/login`。
- 除登录外，所有 `/admin/*` 接口都需要 `Authorization: Bearer <token>`。
- 管理员可调用 `POST /admin/accounts` 创建后台账号，调用 `POST /admin/accounts/:id/password` 修改密码，调用 `POST /admin/accounts/:id/status` 启用/禁用账号。
- 后台账号新密码会加密存储，不能继续使用内测默认密码。
- 管理员可调用 `GET /admin/data/export` 导出当前 JSON 数据备份。
- 管理员可调用 `GET /admin/env-template` 查看缺失环境变量模板，不返回 Secret 明文。
- 上线检查接口：`GET /admin/launch-check`，用于检查 OSS、后台密钥、默认管理员密码、LLM 和微信域名待办。
- 部署探活：`GET /healthz`；上线就绪检查：`GET /readyz`。
- 普通员工账号无法进入后台，只有 `adminAccounts` 里的启用账号可登录。
- 房态规则固定为第 3 天提醒、第 5 天再次提醒、第 7 天未更新自动失效，失效房源进入后台资产池。
- 上传人可调用 `POST /mini/my/listings/:id/verify` 核验自己的房源。
- 管理员可在后台调用 `POST /admin/listings/:id/verify` 核验任意房源，并同步写入足迹。
- 管理员可调用 `POST /admin/expired-listings/:id/restore` 将废房源池里的房源重新上架。

`/admin/launch-check` 只返回配置是否齐全，不返回任何 AccessKey Secret 或 LLM 密钥明文。

## LLM 配置

后台通过：

```http
GET /admin/llm-config
PUT /admin/llm-config
POST /admin/llm-config/test
```

保存和测试模型配置。密钥只读取服务端环境变量，例如：

```env
LLM_API_KEY=
DEEPSEEK_API_KEY=
QWEN_API_KEY=
ZHIPU_API_KEY=
```

小程序只调用：

```http
POST /mini/llm/match
```

由后端读取房源库和 LLM 配置后统一返回匹配结果。请求可带 `text`、`voiceText` 和 `form.features`；返回房源会带 `relevanceScore`、`relevancePercent`、`relevanceReasons`、`features` 和 `maintenanceText`，列表已按相关性从高到低排序。

## 飞书公司房源同步

公司房源状态以飞书房源表和素材库为准。后台新增：

```http
GET /admin/feishu-sync/status
POST /admin/feishu-sync/run
```

该同步属于内部房源数据维护能力，不新增房东端、租客端或其他角色入口，也不作为中介上传时的分佣设置入口。第一版中介上传和签单分佣仍按后端固定 20% 规则执行。

同步规则：
- 房源表中仍为在租/上架，且素材库匹配到视频素材：同步到小程序公司房源，自动标记公司房源、免押金、不分佣。
- 房源表新增但素材库没有匹配素材：不在小程序上架。
- 房源表已下架、已租、关闭，或表中不再返回该房源：小程序对应飞书公司房源自动下架，进入后台废房源池。
- 已同步房源后续房租、户型、小区、视频素材变化：再次同步时会更新小程序房源。

服务端环境变量：

```env
FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_SHEET_URL=https://ccn9urs7d60k.feishu.cn/sheets/H7f8sxOrUhYCK8tev29cwSimnsl
FEISHU_SHEET_TOKEN=H7f8sxOrUhYCK8tev29cwSimnsl
FEISHU_SHEET_ID=
FEISHU_SHEET_RANGE=A1:Z1000
FEISHU_BITABLE_APP_TOKEN=
FEISHU_BITABLE_TABLE_ID=
FEISHU_MATERIAL_FOLDER_TOKEN=
FEISHU_UPLOAD_TO_OSS=true
FEISHU_SYNC_INTERVAL_MINUTES=480
```

当前默认房源表为 `https://ccn9urs7d60k.feishu.cn/sheets/H7f8sxOrUhYCK8tev29cwSimnsl`，`FEISHU_SYNC_INTERVAL_MINUTES=480` 表示每天自动同步 3 次。`FEISHU_UPLOAD_TO_OSS=true` 时，服务端会把飞书素材视频保存到 OSS 后再写入房源；小程序端不接触飞书密钥、OSS AccessKey 或 RAM 权限。没有正式接飞书开放平台前，也可以用 `FEISHU_RECORDS_FILE` 和 `FEISHU_MATERIALS_FILE` 指向导出的 JSON 文件先预演同步。

## 历史保留：积分充值与微信支付

第一版不开放积分、充值、换群或微信支付入口。以下配置和接口仅用于历史代码保留或后续版本预留，不能作为第一版验收入口。历史人工确认模式配置为：

```env
RECHARGE_PAYMENT_MODE=manual
```

历史充值链路中，员工在小程序提交积分充值申请后，管理员在 Web 后台“充值账单”里确认到账，系统再写入积分流水。第一版应隐藏该入口。

后续有正式 HTTPS 域名并准备启用微信支付时，再切换为：

```env
RECHARGE_PAYMENT_MODE=wechat
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

微信支付模式下，小程序调用 `/mini/points/recharge` 后会拿到 `wx.requestPayment` 参数；微信支付回调 `/wechat/pay/notify` 确认成功后，系统写入积分流水。回调处理会先校验微信支付通知签名，再解密通知资源；签名不通过不会加积分。第一版不启用该链路。

## 第一版上线自检

## 阿里云公网内部测试部署

当前公网 IP `114.55.168.97` 的 80 和 22 端口可访问，但 3000 端口不可访问，且 `http://114.55.168.97/healthz` 还不是本项目后端。可使用根目录脚本部署：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-ecs.ps1 -HostName 114.55.168.97 -User root
```

脚本会把 `server/`、`admin-web/`、`utils/mock-data.js` 和部署配置上传到服务器 `/opt/ynzy-miniapp`，创建 `ynzy-miniapp` systemd 服务，并把 Nginx 80 端口反代到本机 `3000`。
服务器端脚本会自动安装 `curl`、`unzip`、`nginx` 和 Node.js 20；如果服务器已有 Node.js 18+，会直接复用。

部署成功后，先运行：

```bash
node scripts/verify-api.js http://114.55.168.97
node scripts/set-miniapp-api.js --internal-http http://114.55.168.97
```

然后用微信开发者工具预览小程序即可内部测试。

部署或改配置后，先运行：

```bash
npm run smoke
```

该命令会临时备份 `server/data/db.json`，自动验证探活、后台登录、首页/列表/地图、登录注册、防跳单、房源上传校验、OSS 上传策略和成交分佣，结束后恢复原数据。脚本中如仍覆盖群聊审核、换群扣积分、充值人工审核等历史保留链路，不代表这些入口进入第一版验收范围。

上线前还需要确认：

- 小程序接口域名必须是正式 HTTPS 域名，不能使用 `127.0.0.1`。
- 微信小程序后台需要配置 request 合法域名为后端 API 域名。
- 微信小程序后台需要配置 uploadFile/downloadFile 合法域名为 OSS 域名。
- Web 后台请通过 `https://你的API域名/admin-web/` 访问。
- 后续版本正式启用微信支付时，支付回调地址为 `https://你的API域名/wechat/pay/notify`。
