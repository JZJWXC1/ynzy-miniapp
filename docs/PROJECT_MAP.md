# 项目整理图谱：寓你住一起内部房源协作小程序

更新时间：2026-06-27

## 项目定位

这个项目是「寓你住一起」公司内部中介使用的房源共享、配房推荐、防跳单留痕和分佣协作系统。第一版只面向中介，不开放租客端、房东端或其他角色流程。中介可以上传真实可租房源，其他中介可以用这些房源为客户配房、带看和成交；查看房源地址和房东联系方式必须实名留痕；成交后由后端按房东实际支付佣金的 20% 固定计算上传人分佣。

系统包含微信小程序、Node.js 后端、静态 Web 管理后台、阿里 OSS 视频存储、LLM 配房小帮手和本地 JSON 数据库。当前第一版以内部联调和上线准备为主，房源群、积分、充值、换群、微信支付只作为历史代码或后续预留保留，不作为第一版可见入口；后续可替换正式数据库、正式 HTTPS 域名并按需启用支付能力。

## CodeGraph 扫描结果

- CodeGraph 索引文件：40 个 JavaScript 文件
- 项目整理文件：约 118 个，已排除 `.codegraph`、`.tmp`、`dist`、`outputs` 等本地生成目录
- 节点：556 个，其中 function 394 个、constant 122 个、file 40 个
- 边：1499 条，其中 calls 939 条、contains 516 条、references 44 条
- 知识图谱文件：`.codegraph/codegraph.db`
- 可视化 HTML：`outputs/codegraph-visualization.html`

高节点密度文件：

- `server/src/domain.js`：116 个节点，业务规则核心
- `utils/mock-data.js`：85 个节点，小程序本地模拟数据和 mock 行为
- `server/src/index.js`：44 个节点，后端 HTTP 路由入口
- `utils/api-service.js`：35 个节点，小程序接口封装
- `server/src/wxpay.js`：21 个节点，微信支付预留
- `utils/llm-service.js`：20 个节点，小程序端配房推荐服务
- `utils/listing-display.js`：18 个节点，房源展示字段归一
- `server/src/oss.js`：15 个节点，OSS 上传和短期读取签名

## 架构分层

- 小程序入口与页面：`app.js`、`app.json`、`pages/*`
  负责首页、房源列表、配房小帮手、地图找房、上传房源、房源详情、我的页面和底部导航。房源群相关页面属于历史保留，第一版不挂可见入口。

- 小程序接口与展示适配：`utils/api-client.js`、`utils/api-service.js`、`utils/api-config.js`
  负责请求封装、mock/真实后端切换、上传文件、房源列表、足迹、分佣和 LLM 匹配接口调用。积分、群聊、换群接口为历史保留，第一版隐藏入口。

- 房源展示归一与辅助能力：`utils/listing-display.js`、`utils/listing-features.js`、`utils/voice-input.js`、`utils/gongshu-communities.js`
  负责分佣标签、视频房源标签、维护状态、特点标签、语音输入解析、小区名称联想。

- 后端服务入口：`server/src/index.js`
  负责 `/mini/*` 小程序接口、`/admin/*` 后台接口、健康检查、上线检查、LLM 配置、OSS 上传策略和微信支付预留回调。

- 后端业务域：`server/src/domain.js`
  负责用户、房源、足迹、防跳单、上传审核、分佣、房态维护、地图点位和匹配评分。积分、换群、群聊审核逻辑为历史保留，第一版不作为可见业务流程。

- 外部服务适配：`server/src/llm.js`、`server/src/oss.js`、`server/src/wxpay.js`
  负责 LLM 配房回复、OSS 视频/截图直传策略、视频短期签名读取、微信支付预留。

- 数据与配置：`server/src/db.js`、`server/src/config.js`、`server/data/db.json`
  当前用 JSON 文件保存用户、房源、足迹、分佣、后台账号，以及历史积分、充值、群聊数据；环境变量由 `server/.env` 注入。
  TODO：当前 JSON 单文件模式下生产 `FOOTPRINT_MAX_ROWS=30000`，按 30 个中介日均约 300 条敏感查看留痕估算可覆盖约 100 天；超过 90 天以上或更高并发留存需求，后续以迁移正式数据库和归档表方案解决，不继续调大单文件上限。

- Web 管理后台：`admin-web/index.html`
  第一版验收关注数据总览、房源管理、敏感查看足迹、分佣记录和 LLM 配置。群聊上传审核、积分流水、充值账单属于历史或后续模块，第一版不应作为验收入口。

- 部署与验收：`scripts/*`、`deploy/*`、`server/scripts/smoke-test.js`
  负责 API 地址切换、服务器部署、格式修复、接口验证和端到端冒烟测试。

## 核心业务链路

### 1. 配房小帮手推荐链路

```mermaid
flowchart LR
  A[首页输入预算/区域/户型] --> B[配房客服 pages/match-chat]
  A --> C[结构化配房 pages/match]
  B --> D[utils/llm-service]
  C --> D
  D --> E[/mini/llm/match]
  E --> F[server/src/llm.js]
  F --> G[server/src/domain.js 本地房源匹配]
  F --> H[真实 LLM 生成客服回复]
  G --> I[返回脱敏推荐房源]
  H --> I
```

关键规则：

- 小程序两种配房入口都统一走 `/mini/llm/match`
- 后端先用内部房源库做本地评分排序，再让 LLM 生成回复
- LLM Prompt 只包含脱敏候选房源，不包含详细地址、房东联系方式、房间号或视频签名链接
- LLM 调用失败时返回本地匹配结果

### 2. 上传房源链路

```mermaid
flowchart TD
  A[上传房源页面] --> B[填写城市/区域/小区/楼栋/房间/联系方式/租金/户型]
  B --> C[选择房源视频]
  C --> D[前端校验]
  D --> E[/mini/uploads/video-policy]
  E --> F[server/src/oss.js 生成 OSS POST Policy]
  F --> G[wx.uploadFile 直传阿里 OSS]
  G --> H[拿到 videoUrl 和 videoKey]
  H --> I[/mini/listings 提交房源]
  I --> J[server/src/domain.js 再次校验并入库]
  J --> K{坐标和视频是否可靠}
  K -->|有视频且有真实确认小区坐标| L[进入列表和地图]
  K -->|有视频但无可靠坐标| M[只进入普通列表]
  K -->|无视频| N[拒绝进入前台有效房源]
```

关键规则：

- 上传房源必须提供视频，无视频房源不能进入前台有效房源、匹配或地图
- 普通房源上传不奖励积分
- 上传时不由前端设置分佣比例；签单经管理员确认后，后端按房东实际支付佣金的 20% 固定计算上传人分佣
- 地图只使用真实且经过确认的小区坐标，无可靠坐标的房源只进入普通列表
- OSS AccessKey 不进入小程序端，只由服务端生成上传策略
- RAM 子账号第一版可见链路只需要访问 `ynzy-house-videos-bj` 下的 `house-videos/*`；`group-screenshots/*` 仅用于历史群聊截图能力保留

### 3. 防跳单敏感信息查看链路

```mermaid
flowchart TD
  A[房源详情页] --> B[地址和房东联系方式默认隐藏]
  B --> C{用户是否实名}
  C -->|未实名| D[引导实名认证]
  C -->|已实名| E[弹窗确认留痕]
  E --> F[/mini/listings/:id/sensitive-view]
  F --> G[写入 footprints]
  G --> H[返回敏感信息]
  G --> I[上传人和管理员后台可查看足迹]
```

关键规则：

- 推荐列表、地图、配房小帮手不展示详细地址和房东电话
- 查看地址或房东联系方式会记录足迹
- 足迹同步给上传人和管理员后台
- 后端负责额度、实名和权限校验

### 4. 历史保留：房源群与积分链路

```mermaid
flowchart TD
  A[房源群页面] --> B[上传群名称和聊天截图]
  B --> C[/mini/uploads/group-screenshot-policy]
  C --> D[截图直传 OSS]
  D --> E[/mini/groups/listings]
  E --> F[后台待审核]
  F --> G[管理员联系用户核对]
  G --> H{审核结果}
  H -->|通过| I[积分 +1]
  H -->|拒绝| J[不加积分]
  I --> K[消耗 1 积分换群一次]
```

关键规则：

- 房源群、积分、充值、换群、微信支付第一版全部隐藏，不作为前台、底部导航或我的页面入口
- 以下规则只说明历史后端代码和后续预留能力，不能作为第一版上线验收入口
- 只有群聊上传审核通过后才加 1 积分
- 普通房源上传不加积分
- 积分只用于换群

### 5. 管理后台链路

```mermaid
flowchart LR
  A[admin-web/index.html] --> B[/admin/auth/login]
  B --> C[管理员 Token]
  C --> D[/admin/dashboard]
  C --> E[/admin/listings]
  C --> F[/admin/footprints]
  C --> G[/admin/groups/uploads 历史保留]
  C --> H[/admin/llm-config]
  C --> I[/admin/launch-check]
```

后台职责：

- 数据总览：区域房源数量、群聊数量、用户数量、敏感查看量
- 房源管理：区域、板块、小区筛选，审核和房态核验
- 足迹管理：查看敏感信息记录
- 分佣记录：成交和分佣状态
- 历史模块：群聊审核、积分流水和充值账单仅作为后续预留，第一版应隐藏或不纳入验收入口
- LLM 配置：供应商、模型、接口地址、密钥变量名和提示词

## 目录地图

```text
小程序/
├─ app.js / app.json / app.wxss
├─ pages/
│  ├─ index/               首页、小帮手入口、房源筛选入口
│  ├─ match-chat/          聊天式配房客服主入口
│  ├─ match/               表单式结构化配房
│  ├─ listings/            房源列表和基础筛选
│  ├─ listing-detail/      房源详情、视频、敏感信息留痕
│  ├─ upload/              中介房源上传；业主/公司类型历史或内部预留
│  ├─ map/                 地图找房
│  ├─ groups/              房源群、群聊上传、换群（第一版隐藏）
│  ├─ my-listings/         我的房源
│  ├─ footprint/           房源足迹
│  ├─ commissions/         分佣记录
│  ├─ auth/                登录实名
│  └─ profile/             我的页面；积分充值入口第一版隐藏
├─ utils/
│  ├─ api-client.js        请求和上传底层封装
│  ├─ api-service.js       小程序业务接口聚合
│  ├─ llm-service.js       配房小帮手客户端服务
│  ├─ listing-display.js   房源展示字段归一
│  ├─ listing-features.js  房源特点标签
│  ├─ mock-data.js         本地模拟数据
│  └─ voice-input.js       语音输入和需求解析
├─ server/
│  ├─ src/index.js         HTTP 路由入口
│  ├─ src/domain.js        核心业务规则
│  ├─ src/llm.js           LLM 配房回复
│  ├─ src/oss.js           OSS 上传和签名读取
│  ├─ src/wxpay.js         微信支付预留
│  ├─ src/db.js            JSON 数据读写
│  └─ scripts/smoke-test.js 冒烟测试
├─ admin-web/
│  └─ index.html           静态 Web 管理后台
├─ scripts/                本地配置、验证和导入修复
├─ deploy/                 服务器部署脚本和 Nginx/systemd 配置
├─ docs/
│  └─ PROJECT_MAP.md       当前项目整理图谱
└─ outputs/
   └─ codegraph-visualization.html 可视化关系图
```

## 关键文件职责

- `pages/index/index.*`
  首页入口，包含城市搜索、小帮手入口、房源筛选、地图找房和我的房源。

- `pages/match-chat/match-chat.*`
  聊天式配房客服。支持连续补充租客需求，展示匹配房源和公开推荐理由。

- `pages/upload/upload.*`
  房源上传表单。负责小区联想、户型选择、视频选择、上传确认和提交；分佣比例不由前端修改，第一版按后端固定 20% 规则计算。

- `pages/listing-detail/listing-detail.*`
  房源详情。负责视频展示、敏感信息查看确认、足迹写入和成交登记。

- `utils/api-service.js`
  小程序业务 API 聚合。页面不直接拼后端接口，大部分请求通过这里走。

- `utils/llm-service.js`
  小程序端配房服务。负责将聊天/表单需求提交给 `/mini/llm/match`，并在 mock 环境做本地兜底。

- `server/src/index.js`
  后端路由总入口。小程序接口、管理后台接口、上线检查、OSS 上传策略、LLM 配置和支付回调都从这里进入。

- `server/src/domain.js`
  业务规则核心。房源上架、审核、固定 20% 分佣、防跳单、足迹、地图、匹配评分都在这里；积分、换群、群聊为历史保留逻辑。

- `server/src/llm.js`
  LLM 推荐客服。先调用本地匹配，再用脱敏候选房源让 LLM 生成回复。

- `server/src/oss.js`
  阿里 OSS 适配。生成视频/截图上传策略和短期签名读取地址。

- `admin-web/index.html`
  管理后台。第一版是静态前端加后端接口，管理员账号可登录查看全公司数据。

## 当前风险与约束

- 当前本地 `server/data/db.json` 房源数量为 0，本地完整推荐效果需要同步真实房源数据后再测。
- 仍未接正式 HTTPS 域名，小程序正式上线前必须配置 request/upload 合法域名。
- 房源群、积分、充值、换群、微信支付第一版均隐藏；相关后端历史代码保留，不作为验收入口。
- OSS 当前建议使用 RAM 子账号 AccessKey，后续正式上线可升级为 STS 临时凭证。
- 后端当前使用 JSON 文件存储，适合内测；正式多人并发使用建议迁移到 MySQL/PostgreSQL 或云数据库。
- `server/src/domain.js` 业务规则较集中，后续功能继续增加时建议按用户、房源、积分、分佣、群聊拆模块。

## 下一步建议

- 同步真实房源数据后重新跑 `server/scripts/smoke-test.js`
- 在 Web 后台增加“上传链路监控”：视频上传成功、房源入库成功、审核状态、失败原因
- 为上传房源补一条独立端到端测试：字段校验、OSS policy、视频直传、房源入库、列表可见
- 为 LLM 配房补一条测试：同一需求在聊天页和表单页返回一致候选
- 准备正式域名、HTTPS 证书、微信合法域名和 OSS CORS 配置
