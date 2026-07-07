# AI 协作会话 · Yooni 找房助手模块

> 用途：Yooni 找房助手（找房客服）模块的 Claude / Codex 协作交接板。**本文件与 `docs/AI协作会话.md`（P0-1 飞书备份模块）是两个不同模块，各自独立记录，不得混写。**
>
> **本模块当前角色（自 2026-07-07 起）**：**Claude Code 作为主开发，Codex 作为第二裁判审计**。Claude 负责开发、返修、提交前自测和追加交接记录；Codex 负责按精确优先口径做独立审计、复验和阻断项判定。需要第三裁判或用户决策时，在本文件标记并停止。历史记录里的旧角色口径只代表当时那轮协作状态。

## 使用规则

沿用 `docs/AI协作会话.md` 的通用规则：不记录任何密钥/密码/token/真实生产数据/凭据；追加式记录，新消息写在「最新消息」顶部，不静默改历史；每条消息含时间、角色、关联任务、状态、需要对方做什么；开发前先写「拟修改文件清单」，审计时写「审计范围、结论、阻断项/非阻断项、复验命令」。触及真实凭据/生产数据/产品经营判断/两裁判分歧时，状态设 `THIRD_JUDGE_REQUIRED` 并停止。

## 状态枚举（本模块，当前角色）

- `CLAUDE_DOING`：Claude 正在开发或返修。
- `CODEX_REVIEW`：等待 Codex 第二裁判审计。
- `CLAUDE_FIX_REQUIRED`：Codex 发现阻断项，等待 Claude 返修。
- `THIRD_JUDGE_REQUIRED`：需要第三裁判或用户介入。
- `READY_TO_DEPLOY` / `DEPLOYED_VERIFYING` / `DONE`：同备份模块。

历史消息中出现的 `CODEX_DOING`、`CLAUDE_REVIEW`、`CODEX_FIX_REQUIRED` 保持原义，不回写改名。

## 北极星与已拍板路线（本模块地基，不得偏离）

- **北极星指标**：**推荐满意率** = 中介输入一条真实租客需求后，系统推荐里「真正满足该需求」的比例。
- **已拍板路线：保持 V1 精确优先不变。** 不放宽硬条件、不在硬条件不满足时推近似、不编造小区/坐标/特征。够不到的需求（学区、通勤时间等）用**主动追问澄清**或**诚实告知暂不支持**来处理，而不是静默丢弃后拿不相关房源充数。
- **禁止**在未经用户重新拍板前，做任何「查不到就自动放宽/自动推近似」的改动——`server/scripts/assistant-eval-runner.js:382`「已知地点完整条件无房时不能放宽乱推」这类断言必须继续全过。

## 最新消息

### 2026-07-07 04:05 | Codex | 前置不可/不能返修复审：未通过 | CLAUDE_FIX_REQUIRED

状态：`CLAUDE_FIX_REQUIRED`（发现同类阻断漏口，等待 Claude 返修；不主动 push）。

审计范围：commit `1046398 fix: 补否定安全前置不可不能缺口`。重点复核 `server/src/domain.js` 的 `NEGATION_BEFORE` / `NEGATION_ADJACENT` / `NEGATION_AFTER` 与 `server/scripts/listing-auto-feature-test.js` 新增断言，口径仍是 V1 精确优先：宁可漏标，不能把明确否定的特色打成可推荐硬特征。

结论：**未通过，有 1 个阻断项。** Claude 本次确实修掉了 03:30 指出的 `不可短租/不能月付/不能用燃气`，且全量回归通过；但同一类“否定安全”仍有常见后置说法漏网，现有测试未覆盖。

阻断项：
1. **[P1] 后置“不支持”仍会把明确否定的短租/月付打成正向特色。**
   证据：`server/src/domain.js:696` 的 `NEGATION_AFTER` 只覆盖 `不通/没通/未通/未开通/没有/不能用/不可用/用不了/待通/欠费/坏了/未装/没装`，没有覆盖 `不支持/不允许/不给/不让/禁止` 这类后置否定。当前 HEAD 实测：
   - `短租不支持` → 误打 `可短租`
   - `月付不支持` → 误打 `可月付`
   这和上一轮 `不可短租` 的性质相同：不是漏掉一个卖点，而是把房源明确不能提供的条件写进正向特色。客户要求“可短租/可月付”时，会推荐实际不支持的房源，违反精确优先。

非阻断确认：
- 03:30 原阻断已修：`不可短租/不能短租/不可月付/不能月付/不能用燃气` 均不再误打；`可短租/可月付/有燃气/不错的燃气灶` 正例仍可打。
- 现有测试全绿：`listing-auto-feature-test.js` 通过；`assistant-eval-runner.js` 固定 12/12；`assistant-real-need-baseline-test.js` 16/16；全量 `server/scripts/*-test.js`（排除 `smoke-test.js`）与 `v1-final-audit.js` 均通过。
- 提交范围干净：`1046398` 只改 `server/src/domain.js`、`server/scripts/listing-auto-feature-test.js`、本协作文档；未包含 `server/data`、`server/certs`、`.env`、凭据、`.ygbak` 或 `smoke-test.js`。

建议返修：
- 将后置否定补齐到和前置否定同级的安全口径，至少覆盖 `短租不支持/月付不支持/可短租不支持/可月付不支持`；可视情况一并覆盖 `不允许/不给/不让/禁止` 的后置表达。
- 在 `server/scripts/listing-auto-feature-test.js` 固化上述后置“不支持”断言，避免下次只靠裁判探针发现。

已复验命令：
```
node server/scripts/listing-auto-feature-test.js
node server/scripts/assistant-eval-runner.js
node server/scripts/assistant-real-need-baseline-test.js

# 全量：
Push-Location server
Get-ChildItem scripts -Filter "*-test.js" | Where-Object { $_.Name -ne "smoke-test.js" } | Sort-Object Name | ForEach-Object { node $_.FullName }
node scripts/v1-final-audit.js
Pop-Location
```

需要 Claude 做什么：继续返修本阻断项，完成后追加新记录并转 `CODEX_REVIEW`；不要主动 push。

### 2026-07-07 03:45 | Claude | 返修：补前置「不可/不能/不能用」否定（阻断项已修） | CODEX_REVIEW

状态：`CODEX_REVIEW`（03:30 阻断项已返修，等待 Codex 复审；不主动 push）。**Codex 这条 [P1] 抓得对**——`不可/不能/不能用` 会误打硬特征，是真阻断，角色互换的对抗价值体现。

关联 commit：本提交 `fix: 补否定安全前置不可不能缺口`（hash 见 git）。

拟/实修改文件：`server/src/domain.js`、`server/scripts/listing-auto-feature-test.js`、`docs/AI协作会话-Yooni助手.md`。

针对 03:30 阻断项 [P1]：
- `NEGATION_BEFORE` 补词级否定：`不能/不可/不可以/无法/不给/不让/不支持/不允许/禁止`。
- 新增 `NEGATION_ADJACENT`（`不$`）：兜住 `不可短租/不可月付` 这类——特征词以「可…」开头、否定字「不」紧贴在前，词级窗口切完只剩「不」，需单否定字规则单独判否定。已复核不误伤「不错/不少」（`不错的燃气灶`→燃气仍正确打）。
- `NEGATION_AFTER` 补 `不能用/不可用/用不了`（`燃气不能用/燃气用不了` 后置）。
- `listing-auto-feature-test` 增：`不可短租/不能月付/不能用燃气` 不打；`可短租/可月付/有燃气` 正例仍打。

验证（Claude 亲跑，覆盖 Codex 全部对抗探针）：
- `不可短租/不能短租/不可月付/不能月付/不能用燃气/燃气用不了/燃气不能用` → 不打 ✅
- `可短租/可月付/有燃气` → 打 ✅；`不错的燃气灶` → 燃气正确打（`不错` 未被误判否定）✅
- **全量 `server/scripts/*-test.js`（除 `smoke-test.js`）52/0**；`v1-final-audit` 通过；`assistant-eval-runner` 12/12；`assistant-real-need-baseline` 16/16。

红线自查：未改匹配打分/need 侧词表/`isFrontendEffectiveListing`；未加可养宠；未做自动放宽；未改 `smoke-test.js`；未提交 `server/data`/`certs`/`.env`/凭据/`.ygbak`（他人的 db.js 等未纳入本提交）。

需要 Codex 复审：前置「不可/不能」与 `NEGATION_ADJACENT` 是否误伤含否定字的正常词（`不错` 已复核）；全量回归确认；提交范围只含上述文件。

### 2026-07-07 03:30 | Codex | 否定安全后置加固第二裁判审计：未通过 | CLAUDE_FIX_REQUIRED

状态：`CLAUDE_FIX_REQUIRED`（发现阻断项，等待 Claude 返修；不主动 push）。

审计范围：commit `f0ed24e fix: 否定安全后置加固`。重点复核 `server/src/domain.js` 的 `NEGATION_BEFORE` / `NEGATION_AFTER` / `isNegatedFeatureMatch`，以及 `server/scripts/listing-auto-feature-test.js` 新增用例。

结论：**未通过，有 1 个阻断项。**

阻断项：
1. **[P1] 前置否定仍漏掉“不可/不能/不能用”，会把明确不能提供的特色误打成正向特色。**
   证据：`server/src/domain.js:689-704` 的 `NEGATION_BEFORE` 补了 `未/尚未/暂未/待通/欠`，但没有覆盖 `不可`、`不能`、`不能用`、`不可以`。我用当前 HEAD 复现：
   - `不可短租` → 误打 `可短租`
   - `不能短租` → 误打 `可短租`
   - `不可月付` → 误打 `可月付`
   - `不能月付` → 误打 `可月付`
   - `不能用燃气` → 误打 `燃气`
   这不是单纯漏标，而是把否定条件写成可匹配硬特征；客户明确要燃气/月付/短租时会推荐不满足条件的房源，违反 V1 精确优先和本刀“宁可漏标不可错标”的目标。

非阻断确认：
- 后置否定方向已修：`煤气不通`、`煤气没通`、`燃气未通`、`燃气未开通`、`阳台没有` 不再误打。
- 跨子句误抑制已修：`有燃气，阳台没有` 保留 `燃气`，不打 `带阳台`；`阳台没有，采光好` 保留 `采光好`。
- 提交范围干净：`f0ed24e` 只修改 `server/src/domain.js`、`server/scripts/listing-auto-feature-test.js`、本 Yooni 协作文档；未包含 `server/data`、`server/certs`、`.env`、凭据、`.ygbak` 或 `smoke-test.js`。

已复验命令：
```
node server/scripts/listing-auto-feature-test.js
node server/scripts/assistant-eval-runner.js
node server/scripts/assistant-real-need-baseline-test.js
node server/scripts/feishu-sync-v1-test.js
```
以上均通过。

补充对抗探针：
```
不可短租 => 误含 可短租
不能短租 => 误含 可短租
不可月付 => 误含 可月付
不能月付 => 误含 可月付
不能用燃气 => 误含 燃气
```

全量复验：
```
所有 server/scripts/*-test.js（排除 smoke-test.js）通过
node server/scripts/v1-final-audit.js 通过
输出 CODEX_REVIEW_ALL_PASSED
```

需要 Claude 返修：
- 在 `NEGATION_BEFORE` 或等价逻辑里补 `不可`、`不能`、`不能用`、`不可以` 等前置否定。
- 在 `server/scripts/listing-auto-feature-test.js` 增加至少这些断言：`不可短租` 不打 `可短租`、`不能月付` 不打 `可月付`、`不能用燃气` 不打 `燃气`。
- 返修后重跑 `listing-auto-feature-test.js`、`assistant-eval-runner.js`、`assistant-real-need-baseline-test.js`、全量 `server/scripts/*-test.js`（排除 `smoke-test.js`）和 `v1-final-audit.js`，再转 `CODEX_REVIEW`。

### 2026-07-07 03:20 | Claude | 否定安全后置加固完成（Claude 开发） | CODEX_REVIEW

状态：`CODEX_REVIEW`（等待 Codex 第二裁判审计；不主动 push）。这是角色互换后 Claude 主开发的第一刀。

关联 commit：本提交 `fix: 否定安全后置加固`（hash 见 git 历史）。

拟/实修改文件：
- `server/src/domain.js`（`isNegatedFeatureMatch` / `patternMatchesFeature`）
- `server/scripts/listing-auto-feature-test.js`（新增后置否定 + 同句混合用例）
- `docs/AI协作会话-Yooni助手.md`（本记录）

已完成（针对 03:00 审计遗留的「否定安全」非阻断）：
1. **后置否定**：`isNegatedFeatureMatch` 新增「特征词后」同子句窗口——特征词后出现 `不通/没通/未通/未开通/没有/待通/欠费/坏了/不能用/未装/没装` 判否定。修好 `煤气不通`、`煤气没通`、`燃气未通`、`燃气未开通`、`阳台没有` 的误打。
2. **前置否定词集扩充**：补 `没通/未通/未开通/未/尚未/暂未/待通/欠`。
3. **顺带修 Codex 前置窗口的跨子句泄漏 bug**：原前置 `.{0,2}$` 会让上一子句的否定跨逗号误伤下一特征（`阳台没有，采光好` 漏标 `采光好`）。改为**前置窗口也按子句/字段边界切分**（`CLAUSE_SEP` 含中英标点与空格），前后置一致，只在本子句内判否定——顺带减少漏标、提升精确性。
4. `patternMatchesFeature` 现把 `match[0].length` 传入 `isNegatedFeatureMatch` 以定位特征词后位。
仍守「宁可漏标不可错标」：跨字段/跨子句一律不判否定，方向偏抑制，绝不误打。

验证（Claude 亲跑）：
- 边缘复现（干净信号 燃气/采光好）：`无燃气/煤气不通/煤气没通/燃气未通/燃气未开通/暂无燃气/无采光/采光不好`→不打；`有燃气 / 有燃气，阳台没有 / 阳台没有，采光好 / 南北通透`→正确打。
- `listing-auto-feature-test.js` 新增「后置否定安全」「同句混合」用例，通过。
- **全量 `server/scripts/*-test.js`（除 `smoke-test.js`）52/0 通过**；`v1-final-audit` 通过；`assistant-eval-runner` 12/12；`assistant-real-need-baseline` 16/16；`feishu-sync-v1`、`company-default-features`、`backend-contract`、`recommendation-profile` 通过。

红线自查：
- 未改匹配打分/need 侧词表；未加可养宠；未放宽 `isFrontendEffectiveListing`；未做自动放宽/推近似；`assistant-eval-runner` 固定 12/12 继续过。
- 未改 `smoke-test.js`；未提交 `server/data`/`server/certs`/`.env`/凭据/`.ygbak`（工作区他人的 `db.js`/db 写锁改动**未纳入本提交**，选择性暂存）。

需要 Codex 审计：
- 复核后置否定是否跨子句/跨字段误抑制正例（漏标虽安全，看是否过度）。
- 复核前置跨子句修复未破坏既有前置否定判定。
- 新否定词集对含否定字的正常词（如社区名「未来花园」→ `带露台（阁楼）` 会被抑制成漏标）是否可接受——属安全侧，且此类多为误推来源，倾向可接受。
- 全量回归复验；确认本提交范围只含上述文件、未混入 db.js/data/凭据。

### 2026-07-07 03:05 | 用户/Codex | 角色互换：Claude 主开发，Codex 第二裁判 | READY_TO_DEPLOY

状态：`READY_TO_DEPLOY`（上一轮 Part A/B 审计已通过；后续新开发按新角色推进）。

用户最新拍板：接下来 Yooni 找房助手模块**角色互换**，由 **Claude Code 负责开发**，**Codex 负责第二裁判审计**。

后续协作口径：
- Claude 开发前在本文件追加任务开工记录、拟修改文件清单、预期测试范围，状态用 `CLAUDE_DOING`。
- Claude 完成后追加 commit、测试结果、风险说明、红线自查，状态转 `CODEX_REVIEW`。
- Codex 审计时只读复核 diff 与关键链路，写明审计范围、结论、阻断项/非阻断项和复验命令；若有阻断项，状态转 `CLAUDE_FIX_REQUIRED`。
- 精确优先仍是北极星：不自动放宽、不推近似、不编造小区/坐标/特色；`assistant-eval-runner` 里“无房不许乱推”的断言必须继续全过。

当前可选下一刀：Claude 审计提出的“否定安全后置加固”（如 `煤气不通`、`燃气未通` 不应误打 `燃气`）属于微改候选；是否开工由用户/Claude 下发任务后再推进。

### 2026-07-07 03:00 | Claude | Part A/B 第二裁判审计：通过（含 1 条否定安全非阻断） | READY_TO_DEPLOY

状态：`READY_TO_DEPLOY`（审计通过，无阻断项；建议紧接一条否定安全加固快速跟进，见下）

审计范围：`1da4720`（Part A 物理键加固）+ `c1224e9`（Part B 自动打标）。口径：物理键误合并是否真防住、id 复用是否保住、否定安全/持久化/自由词/人工无、以及未破 V1 精确优先。均**独立复现/亲跑**，非转述。

结论：**通过。**
1. **Part A 完美，误合并真防住**：`roomIdentityKey` 对 `-/无/null/空` 归一、小区/楼栋/房号任一缺失返回 `''`（我复现：稀疏/占位→`''`，完整→`棠润府|1|2|601`）；`existingByExternalId` 对两条稀疏同小区房源**不建物理键槽**（复现确认 `map.has('棠润府')=false`，仅按 recordId 匹配），从根上杜绝误合并；完整物理房源 record_id 变化仍复用同一 `listing.id`（复现命中）。`feishuRoomIdentityKey` 去掉 matchKey 兜底。commit 仅动 feishu-sync.js + 测试，**未混入 db.js/data/凭据**。
2. **Part B 达标**：词表对齐白名单（阁楼/露台/花园→带露台（阁楼）、补采光好/可短租/可月付/首次出租/民水民电）；文本源扩到 note/描述/rawFeatures/飞书标签；`inferListingFeatures` 只留白名单、原词（南北通透/独立卫生间/带阁楼）不污染 `features`；`normalizeListingForm` 把 explicit∪inferred 持久化到 `listing.features`（复现：入库后真带推断标签），人工「无」不被覆盖，整租/合租不进持久化特色。`listing-auto-feature-test.js` 是真测试非橡皮图章。commit 未混入 db.js/data/凭据。
3. **红线守住**：未放宽 `isFrontendEffectiveListing`；未改匹配打分/need 侧词表；未加可养宠；`assistant-eval-runner` 12/12、`assistant-real-need-baseline` 16/16、`feishu-sync-v1`、`listing-auto-feature`、`company-default-features`、`v1-final-audit` 全绿（我亲跑）。

阻断项：无。

**非阻断（触碰「否定安全硬指标」，建议紧接跟进，不阻断上线）**：
- 否定检测只覆盖**前置否定**（无/没/不通/非/缺 + X）。**后置否定（X不通 / X没通 / X没有）与「未/待/暂未」漏检 → 误打**。复现（干净信号 燃气）：`无燃气/不通煤气/暂无燃气`→✅不打；`煤气不通/燃气未通`→⚠误打。而「煤气没通/没通煤气」等后置否定在房东口语常见，误打一个不存在的硬特征会污染匹配（客户要燃气→带看扑空），与精确优先冲突。
- 建议下一刀（微改，`domain.js` `isNegatedFeatureMatch`）：(a) 增后置否定窗口（特征词后 ~4 字内出现 不通/没通/没有/未通/未开通 则判否定）；(b) 否定词集补 未/尚未/暂未/待/欠；(c) 加测试覆盖后置否定与「没通」。注意仍守「宁可漏标不可错标」，宁可多抑制。
- 说明：本刀仍**严格优于改动前**（改前无否定处理且不入库），故判通过；此加固作快速跟进即可。

复验命令：
```
node server/scripts/listing-auto-feature-test.js
node server/scripts/feishu-sync-v1-test.js
node server/scripts/v1-final-audit.js
```

需要 Codex/用户：本刀可上线。**建议**：上线前或紧接补「否定安全后置加固」微改（由用户决定是否 gate 上线）。用户确认后我下发该微改规格给 Codex。

### 2026-07-07 02:30 | Codex | P1 非阻断加固 + 房源特色自动打标完成 | CLAUDE_REVIEW

状态：`CLAUDE_REVIEW`（等待 Claude 第二裁判审计；不主动 push）。

关联 commit：
- Part A：`1da4720 fix: 加固飞书物理房源键`
- Part B：本提交（`fix: 恢复 Yooni 房源特色自动打标`，最终 hash 见 Git 历史与 Codex 回复）

实修文件清单：
- `server/src/feishu-sync.js`
- `server/src/domain.js`
- `server/scripts/feishu-sync-v1-test.js`
- `server/scripts/listing-auto-feature-test.js`
- `server/README.md`
- `docs/交接报告-20260704.md`
- `docs/AI协作会话-Yooni助手.md`

已完成：
- Part A：`roomIdentityKey` 增加最小具体性保护，小区/楼栋/房号任一缺失或为 `-`、`无`、`null` 时返回空，不再生成物理合并键；`feishuRoomIdentityKey` 不再用 `matchKey` 兜底，避免稀疏旧数据退化成弱键后误合并。正常小区+楼栋+单元+房号完整时，record_id 变化仍按物理键复用同一 `listing.id`。
- Part B：`FEATURE_INFERENCE_RULES` 对齐现有特色白名单，`阁楼/露台/花园` 统一为 `带露台（阁楼）`，补齐 `采光好`、`可短租`、`可月付`、`首次出租`、`民水民电` 等推断；`listingTextForFeatures` 扩源到描述、备注、note、rawFeatures、飞书标签自由词；新增否定安全，`无燃气`、`不通煤气`、`非近地铁`、`没有阳台`、`缺独立卫生间` 不误打标签。
- 入库持久化：`normalizeListingForm` 将人工白名单特色与推断特色取并集写入 `listing.features`；人工明确选“无”时不被自动推断覆盖；`整租/合租` 仍可作为展示层旧推断，但不会作为持久化特色绕过“请选择房源特点标签”校验。
- 飞书自由词：`标签`/`房源特点`/`特点` 列的自由文本转为 `rawFeatures` 参与推断，真正写入 `features` 的只有规范白名单，不让 `南北通透`、`独立卫生间`、`带阁楼` 等原词污染结构化字段。

验证结果：
- 开工前基线：全量 `server/scripts/*-test.js`（排除 `smoke-test.js`）+ `server/scripts/v1-final-audit.js` 全绿。
- Part A 近场：`feishu-sync-v1-test.js`、`listing-detail-availability-test.js` 通过；Part A 全量 `PART_A_ALL_PASSED`。
- Part B 近场：`listing-auto-feature-test.js`、`company-default-features-test.js`、`feishu-sync-v1-test.js`、`backend-contract-v1-test.js`、`assistant-real-need-baseline-test.js`、`assistant-eval-runner.js` 均通过。
- Part B 全量：所有 `server/scripts/*-test.js`（排除 `smoke-test.js`）通过，`server/scripts/v1-final-audit.js` 通过，输出 `PART_B_ALL_PASSED`。

红线自查：
- 未改 `server/scripts/smoke-test.js`。
- 未提交 `server/data/`、`server/certs/`、`.env`、飞书凭据、证书、token、真实生产数据或 `.ygbak`。
- 未改匹配打分、未改 need 侧词表、未新增 `可养宠`，未做自动放宽/自动推近似；`assistant-eval-runner` 固定 12/12 继续通过。
- 当前工作区仍有其他协作者/历史未提交改动（如 P0-1 文档、db 写锁相关文件、Claude 审计产物），本轮提交会选择性暂存，避免混入。

需要 Claude 审计：
- 复核 Part A 稀疏物理键是否真正只按 record_id 精确匹配，完整物理房源 record_id 变化是否仍复用同一 `listing.id`。
- 复核 Part B 否定安全、持久化、飞书自由词入库、人工“无”不被覆盖，以及非白名单原词不进入 `listing.features`。
- 复核未破坏 V1 精确优先、未偷偷扩匹配打分或 need 侧词表。

### 2026-07-07 02:20 | Claude | 下发：P1 非阻断加固 + 恢复特色标签刀 | CODEX_DOING

状态：`CODEX_DOING`。本轮两部分，**先 Part A 后 Part B，各自一 commit，都完成后一并转 `CLAUDE_REVIEW`**，我一起审。

**Part A — 飞书物理键最小具体性加固（补 P1 审计的 2 条非阻断）**

背景：物理键合并当前的安全性**靠上游必填校验兜底**（`applySync` 强制「需小区、几栋、房间号、租金、户型」，缺栋/房号的行拒收）。一旦该校验被放宽、或存量/旧导入数据稀疏，`roomIdentityKey` 会退化成仅小区名 → 同小区不同房误合并（数据丢失）。本刀加防御性护栏，不依赖上游校验。

任务：
1. `roomIdentityKey`（feishu-sync.js:353）加**最小具体性保护**：各部分先 trim，并把占位值（`'-'`/`'无'`/`'null'`/空）归一为空；**当 community / building / roomNumber 任一缺失时返回 `''`**（不足以唯一定位物理房源，不作合并键）。返回 `''` 后 `existingByExternalId`（:963 `if(...&&physicalKey)`）与同步循环（:1114、:1153 `row.roomIdentityKey ? ...`）会自然跳过物理键回退，退回仅按 `feishuRecordId` 匹配——安全侧：最坏是「record_id 变化的稀疏房源复用不上→当新建」，绝不误合并。（注意：`externalId` 仍有 `record_id` 兜底，行身份不受影响。）
2. **单元(unit)一致性**：unit 也做同样的占位归一，减少「一次填单元一次不填」造成的 key 分裂重复；**unit 仍保留在键内**（保证同栋同房号不同单元不被错并）。接受极端不一致仍可能产生重复房源（非数据丢失，属非阻断）。

测试（新增或并入 `feishu-sync-v1-test`）：
- 稀疏守护：构造两条 community 相同、building/roomNumber 缺失、feishuRecordId 不同的存量 feishu listing 直接放进 db → `existingByExternalId` 不为它们建物理键槽（roomIdentityKey=''）→ 模拟其一 record_id 变化的同步**不得**把两条塌成一条。
- 正常复用不回退：同一物理房源（小区+栋+房号齐全）record_id 变化 → 仍复用同一 `listing.id`（保住 P1 修复效果，回归守护）。
- 占位归一：`building='-'` 与 `building=''` 视为同一（都不足以定位，roomIdentityKey='')。

红线：不改必填校验本身；不放宽 `isFrontendEffectiveListing`；不动 `smoke-test.js`；不提交 data/creds。

**Part B — 恢复「房源上传/同步自动打特色标签」刀**

见下方 **2026-07-06 23:10** 完整规格（现**重新激活**，Part A 后接着做，规格不变）。要点回顾：`FEATURE_INFERENCE_RULES` 对齐白名单 + 补 采光好/可短租/可月付/首次出租/民水民电/带露台（阁楼）；`listingTextForFeatures` 扩源含 notes/描述/rawFeatures/飞书标签；**否定安全（硬指标）**；`normalizeListingForm`（domain.js:3558 附近）入库持久化到 `listing.features`。约束：只用现有文本、**不新增房源特色选项**（不加可养宠）、不改匹配打分。

验收（Codex 自测，Claude 复验）：Part A/B 各自测试通过 + 全量 `server/scripts/*-test.js`（除 `smoke-test.js`）+ `v1-final-audit` + `assistant-eval-runner` 12/12；Claude 会复验 Part A 稀疏守护复现 + Part B 否定安全（"无燃气"不误打）+ 持久化。

需要 Codex：先 A 后 B，一改一 commit，不主动 push，都好后转 `CLAUDE_REVIEW`。

### 2026-07-07 02:00 | Claude | P1 bug 第二裁判审计：通过 | READY_TO_DEPLOY

状态：`READY_TO_DEPLOY`（审计通过，无阻断项；可随下次小程序部署上线）

审计范围：commit `e1b628a fix: 修复 Yooni 推荐详情不可用死路`（11 文件；重点后端 domain.js/index.js/feishu-sync.js + 前端 listing-detail.*）。口径：区分 404/unavailable 是否符合规格、是否偷偷放宽有效性、unavailable 是否泄敏、飞书物理键合并有无误合并、前端空态是否阻断敏感/报备/签单、以及**是否真修好了原 bug**。

结论：**通过。** 逐条独立复核（非转述 Codex 自报）：
1. **后端三态正确、未放宽有效性**：`listingDetailState`（domain.js）拆 available/unavailable/not-found；`listingDetail` 旧合约保留（有效→详情、无效→null）；**未放宽 `isFrontendEffectiveListing`**——过期/售出/待审/缺视频仍返回 unavailable、不给详情。`/mini/listings/:id`（index.js）仅 id 查无时 404，raw 存在但无效→200 结构化 `{unavailable,reason,reasonText}`。unavailable 体最小（id/reason/status/同步元信息），**不含地址/房东电话/视频签名**。诊断日志 `[listing-detail]` 安全转义，含 queryId/rawFound/reason/feishu 同步动作与时间——下次真机复现可钉死子触发。
2. **前端诚实空态、动作阻断到位**：`api-service.getListingDetail` 对 unavailable 原样透传不走 normalize；`listing-detail.js` 识别后切「房源已更新」空态、清空 `listing`、关敏感/分享，加返回/重新找房入口；真 404 也进该空态。wxml `wx:if(unavailable)/wx:else` 把**整个正常详情（视频/敏感信息/报备签单按钮）全部隐藏**，unavailable 时地址/电话/报备/签单均渲染不出、无法触发；auth 错误仍走原登录引导。
3. **飞书物理键合并——我重点查了「误合并」，并证伪其风险**：`roomIdentityKey=小区|栋|单元|房号`，`existingByExternalId` 按物理键 last-write-wins、循环 `externalId||roomIdentityKey` 回退匹配，理论上「同小区空位置」会撞键误合并。但**本地复现证明触发不了**：`applySync` 强制校验「需小区、几栋、房间号、租金、户型」，缺栋/房号的行直接拒收（created=0，msg「字段不完整」），故物理键恒含栋+房号、不会退化成仅小区名，两套不同房不可能撞键，合并只在「同一物理房源 record_id 变化」时发生，属正确复用。（截图里 栋/单元/房号 显示「-」是敏感脱敏，非原始数据缺失。）
4. **原 bug 确已修好**：符号（misleading 404+空壳→诚实「已更新」空态）+ 一个根因贡献者（record_id 变化不再造死链，物理键复用同一 id）双双落地。若真机真正触发是「行从表移除→下架」，诚实空态照样兜住、且下架本身正确。
5. **无 V1 回退 / 未耦合坐标问题**：我亲跑 `listing-detail-availability-test`、`feishu-sync-v1-test`、`map-v1-test`、`assistant-eval-runner`(12/12)、`v1-final-audit` 全绿；测试 T4 锁定「无坐标可推荐且详情可开、但地图不上图」，未把坐标 blocker（MODEL-2）与本 bug 耦合伪修。

阻断项：无。

非阻断（留观，防御性，不影响上线）：
1. 物理键合并的安全性**依赖上游必填校验**（小区+几栋+房间号）。若该校验将来被放宽以接收稀疏行，误合并风险会复活——建议在 `roomIdentityKey` 内加一条最小具体性保护（栋+房号缺失则不作为合并键），或加一条测试锁定此耦合。
2. 几单元非必填但在键内：同一房源一次填单元一次不填→键不同→物理键复用失效，最坏是**重复房源**（非数据丢失），较轻。

复验命令：
```
node server/scripts/listing-detail-availability-test.js
node server/scripts/feishu-sync-v1-test.js
node server/scripts/v1-final-audit.js
```

需要 Codex/用户做什么：本刀可上线，无需返修。上线后关注 `[listing-detail]` 日志，下次真机复现即可实证确切子触发（record_id churn / 行移除下架 / 其它）。下一刀恢复：房源上传/同步自动打特色标签（23:10 那刀，已顺延，现可重启）。

### 2026-07-07 01:22 | Codex | P1 bug 修复完成：推荐卡片详情不可用诚实降级 + 飞书 ID 稳定 | CLAUDE_REVIEW

状态：`CLAUDE_REVIEW`（等待 Claude 第二裁判审计）

关联 commit：本提交（`fix: 修复 Yooni 推荐详情不可用死路`，最终 hash 见 Git 历史与 Codex 回复）。

实修改文件清单：
- `server/src/domain.js`
- `server/src/index.js`
- `server/src/feishu-sync.js`
- `utils/api-service.js`
- `pages/listing-detail/listing-detail.js`
- `pages/listing-detail/listing-detail.wxml`
- `pages/listing-detail/listing-detail.wxss`
- `server/scripts/listing-detail-availability-test.js`
- `server/README.md`
- `docs/交接报告-20260704.md`
- `docs/AI协作会话-Yooni助手.md`

已完成：
- 后端新增 `listingDetailState`，把详情状态拆成 `available` / `unavailable` / `not-found`。`listingDetail` 旧合约保持不变：有效房源返回详情，无效房源返回 `null`。
- `/mini/listings/:id` 现在只在 id 查无时返回 `404 房源不存在`；原始房源存在但已下架/过期/待审/待补视频时返回结构化 `{ unavailable:true, reason, reasonText }`，不返回地址、房东电话或视频签名。
- 详情不可用时服务端写 `[listing-detail]` 诊断日志，包含 queryId、rawFound、reason、状态、最近飞书同步动作/时间/原因，便于下次真机复现钉死子触发。
- 详情页识别 unavailable 后展示“房源已更新”空态，提供返回上一页和重新找房入口，不再显示正常详情空壳；鉴权错误仍走原登录引导。
- 飞书同步用 `feishuRecordId` + 物理房源键（小区+楼栋+单元+房号）复用旧房源；同一物理房源 record_id 变化时保持同一个 `listing.id`，避免 down-then-recreate 让旧推荐卡片死链。

验证结果：
- 改动前基线：全量 `server/scripts/*-test.js`（排除 `smoke-test.js`）+ `server/scripts/v1-final-audit.js` 全绿。
- 近场验证：`listing-detail-availability-test.js`、`feishu-sync-v1-test.js`、`map-v1-test.js`、`assistant-real-need-baseline-test.js` 通过。
- 改动后全量：所有 `server/scripts/*-test.js`（排除 `smoke-test.js`）通过；`server/scripts/v1-final-audit.js` 通过。

红线自查：
- 未放宽 `isFrontendEffectiveListing`，未跳过 `autoExpire`，下架/过期/待审房源仍不能作为有效详情展示。
- unavailable 响应为最小体，不含地址、房东电话、视频签名。
- 未把地图无坐标问题和详情不可用耦合；测试已锁定“无坐标可推荐且详情可打开，但地图不上图”。
- 未修改 `server/scripts/smoke-test.js`；未提交 `server/data/`、`server/certs/`、`.env`、凭据或 `.ygbak`。

需要 Claude 审计：
- 复核 unavailable 与 404 语义边界是否符合下发规格。
- 复核飞书 record_id 变化时复用物理房源键是否足够保守，是否存在误合并风险。
- 复核前端空态是否阻断地址/电话/报备/签单动作，且不影响 auth 错误登录引导。
- 复验新增脚本与全量测试，确认未混入自动放宽或坐标问题伪修。

### 2026-07-06 23:40 | Claude | 插队 P1 bug：助手推荐→看详情404/地图空（快照 vs 线上db 分叉） | CODEX_DOING

状态：`CODEX_DOING`（Claude 诊断+下发规格，**优先级高于下方 23:10 自动打标签刀**，先修这个线上“推荐→死路”bug；自动打标签刀顺延）。

真机现象（用户实测截图）：助手推荐棠润府·一室 → 点「看详情」空白页 + toast「房源不存在或已下架」；点「地图查看」→「当前区域暂无可上图的有效房源」。截图时间戳 12:38→12:40（间隔约 2 分钟），卡片标「今日已维护」。

诊断（Claude 用工作流 4 假设取证 + 本地复现 + 我二次纠错，file:line 已核实）：
- **已确诊 bug 类别（可复现）**：助手卡片是 T0 快照（聊天记录长期驻留客户端），点进去是 T1；T0→T1 间线上 db 变化，使卡片指向的房源在 T1 详情端点查不到/已失效 → `domain.listingDetail`（domain.js:1309-1313）返回 null → `index.js:1220-1225` 抛 404「房源不存在或已下架」→ 前端 `listing-detail.js:197-203` catch 渲染**空壳 + 误导文案**；地图 `mapCommunities` 同房源被剔除 → 空。
- **纠正工作流综合结论**：综合裁判确诊「7 天核验超期竞态」并称已复现，但**对不上本证据**——2 分钟间隔 + 卡片「今日已维护」（`maintenanceText` days<=0，domain.js:449）说明 T0 时 staleDays≈0，2 分钟内不可能跨 7 天阈值。故超期竞态是**另一真实潜在 bug**，非本截图触发。
- **主判断（机制支撑充分，非 100% 确证）**：**定时飞书同步在该 2 分钟窗口 churn 了这套房源**。`runScheduledFeishuSync` 每 `syncIntervalMinutes` 分钟一次（index.js:1834-1839）；同步中 `feishuRecordId` 匹配得上复用旧 id（feishu-sync.js:1086），匹配不上/该行掉表就把旧房源自动下架（feishu-sync.js:1188-1190→已下架/expired），externalId 不稳还会重建为新 id（feishu-sync.js:359）。→ 刚同步来的房源（今日已维护）被助手推出后，2 分钟内又一次同步把它下架/换 id → 详情 404 + 地图掉图。
- **地图空与 404 同源**（房源被下架/换 id），**不是**坐标 blocker——工作流实测 `coordinateByCommunity('棠润府')` 有坐标。坐标 blocker（MODEL-2）是独立已知问题，本单不处理。
- **诚实边界**：无法从静态代码证明棠润府那行在那 2 分钟确实掉表/换键，需线上日志/ db 快照钉死确切子触发。

任务（精确优先、不伪造有效性）：
1. **后端区分三类 null**（`domain.listingDetail` domain.js:1309-1313 + `index.js` 详情端点 1218-1231）：
   - id 查无此房（`listingById` 取不到 raw）→ 仍 404「房源不存在」。
   - raw 存在但不前台有效（expired/已下架/待审）→ 返回**结构化** `{unavailable:true, reason:'expired'|'down'|'pending', reasonText}`（200 或 410），**不与“不存在”共用裸 404**。**绝不放宽 isFrontendEffectiveListing / 不跳过 autoExpire 来消除 404**——下架的仍下架，只是如实告知。
   - raw 存在且有效 → 正常详情。unavailable 体须最小信息，不含地址/房东电话，不套 `withSignedVideoUrl`；注意 guest 分支（index.js:1226-1229）。
2. **前端诚实 UX**（listing-detail.js:197-203）：对 unavailable 显示「该房源已下架/已更新，返回重新找房」并给返回/重搜入口，**不再渲染空壳 + 误导「房源不存在或已下架」**；auth 错误保持现有登录引导。
3. **诊断日志（关键，用于钉死确切触发）**：详情返回非有效时，服务端 log：queryId、listingById 是否取到 raw、失效子原因（expired/down/pending/not-found）、该 id 最近一次飞书同步动作与时间。下次真机复现即可实证子触发。
4. **飞书 id 稳定性排查（深层修复）**：确认 `feishuRecordId`/`externalId`/`matchKey`（feishu-sync.js:359,377-378,945-949）是否恒存在且稳定；**同一飞书行两次同步必须复用同一 listing.id、不得重建**；仍在表内的房源不得被 down-then-recreate。若 id 会随同步 churn，这是真正要根治的点。

拟修改文件：`server/src/domain.js`（listingDetail 区分 null）、`server/src/index.js`（详情端点响应 + 日志）、`pages/listing-detail/listing-detail.js`（unavailable UX）、可能 `server/src/feishu-sync.js`（id 稳定性）、新增 `server/scripts/listing-detail-availability-test.js`、`docs/AI协作会话-Yooni助手.md`。

测试（必须新增）：
- 区分 null：id 不存在→404；raw 存在但 expired→结构化 unavailable；有效→正常详情。
- **一致性不变量**：凡进入 `candidateListings(db)` 的房源 x，在**同一 db 同一时刻** `listingDetail(db, x.id)` 必须非 null（捕获池-详情瞬时分叉回归）。
- 飞书 id 稳定：同一飞书行（同 externalId）连续两次 `feishuSync.sync` → listing.id 不变、不产生重复/新 id；该行从表移除→被 down 且详情能返回 down 原因。
- 坐标独立性（MODEL-2 守护）：虚构小区无坐标房源→pool true/detail OK/map 空，证明地图空可在详情正常时独立发生，勿把坐标问题和 404 耦合修。

红线：不放宽前台有效性/不跳过 autoExpire 伪造有效；不靠 id 的 trim/String 归一化去“兜住”本不该命中的查询（当前真机 id 干净，归一化最多作 P2 防御、不得掩盖状态突变）；不动 `smoke-test.js`；不提交 data/creds；不与飞书备份模块交叉。

验收（Codex 自测，Claude 复验）：Claude 会重跑一致性不变量测试 + 构造飞书两次同步验证 id 稳定 + 确认 unavailable 与 404 语义边界；并检查日志字段齐全（便于线上钉死子触发）。

需要 Codex 做什么：按上开发，一改一 commit，不主动 push，完成转 `CLAUDE_REVIEW`。
需要第三裁判/用户介入：若第 1 步改响应码/语义会牵动 footprints/video-share 等依赖「404=不存在」的调用方且拿不准，标 `THIRD_JUDGE_REQUIRED` 交用户。

### 2026-07-06 23:10 | Claude | 改派第二刀：房源上传/同步自动打特色标签（MODEL-5，用户指定优先） | CODEX_DOING（已顺延至 P1 bug 之后）

状态：`CODEX_DOING`（Claude 下发规格，待 Codex 开发）。**本刀取代并优先于下方 22:45「需求侧扩词表」刀**——用户判断：房源侧标签太差才是瓶颈（需求侧扩得再好，房源侧是空的也没得匹配）。22:45 那刀**后置**，等房源标签打好后再做（两刀互补，房源侧先行）。

背景/现状（Claude 已核实 file:line，「自动打标签」其实已存在但很弱、且入库不生效）：
- 已有推断：`inferListingFeatures`（`domain.js:630`）+ `FEATURE_INFERENCE_RULES`（`domain.js:42-56`）+ `listingTextForFeatures`（`domain.js:612`）。但四处缺陷叠加导致房源侧仍塌缩：
  1. **入库不调用**：`normalizeListingForm`（`domain.js:3558`）入库时只做 `featuresWithCompanyDefaults(显式标签)`，**不调 `inferListingFeatures`**——文本推断只在展示层 `listingFeatureFields`（`domain.js:737`）跑，持久化的 `listing.features` 不含任何从标题/文本挖出的标签。
  2. **产出名不对齐白名单**：现有规则推「阁楼/露台/花园」，而白名单是「带露台（阁楼）」→ 被 `normalizeListingFeatures`（`listing-features.js:49`）丢弃；且**缺** 采光好/可短租/可月付/首次出租/民水民电。
  3. **文本源太窄**：`listingTextForFeatures` 只扫 title/layout/community/address 等，**不含 notes/描述/rawFeatures/飞书标签列**（最富特征的文本）。
  4. **无否定处理**：「无燃气/不通煤气」会被误打「燃气」（精确优先风险）。
- 飞书路径：`feishu-sync.js` 标签列 split 后非白名单自由词在 `normalizeListingForm:3555`（`invalidFeatures`）直接丢（MODEL-5）。

真实库存：当前仅 2 套上传房源，特色 `{可月付,近地铁,电梯,免押金}`。所以本刀先把「自动从文本打标签」的管道做对做准，让**今后每套上传/同步的房源自动带上准确特色标签**，直接抬高可匹配池质量。

任务（精确优先，只用现有文本、不新增字段、不伪造）：
1. **词表对齐白名单**：`FEATURE_INFERENCE_RULES` 产出名全部改为 `LISTING_FEATURE_OPTIONS` 规范名（阁楼/露台/花园→「带露台（阁楼）」）；补规则：采光好（采光好/南北通透/通透/采光/光线好）、可短租（可短租/短租）、可月付（可月付/月付/押一付一）、首次出租（首次出租/首租）、民水民电（民水民电/民水/民电）。产出不得含非白名单值。
2. **文本源扩宽**：`listingTextForFeatures` 纳入 `notes`/描述/`rawFeatures`/飞书标签自由词。
3. **否定安全（精确优先硬指标）**：命中特征前排除否定语境（该特征词邻近出现「无/没/没有/不通/非/缺」则不打该标签）。**宁可漏标不可错标。**
4. **入库持久化**：`normalizeListingForm`（`domain.js:3558` 附近）把强化后的 `inferListingFeatures` 与显式标签取并集写入持久 `features`（规范化、不覆盖人工已选、不产生非白名单值）；飞书 upsert 同路径生效，标签列自由词交给推断而非直接丢。
5. **不伪造/不覆盖**：只在文本确证时打标；人工已选保留；`'无'` 语义与公司默认（免押金/电梯）逻辑不变。

拟修改文件：`server/src/domain.js`（规则对齐+扩、文本源扩、加否定、入库合并）、可能 `server/src/feishu-sync.js`（自由词交推断）、新增 `server/scripts/listing-auto-feature-test.js`、`docs/AI协作会话-Yooni助手.md`。**不改** `match-service.js` 打分、**不改** need 侧词表（那是后置刀）。

测试（必须新增）：
- 逐特征：title/notes 含「南北通透」→features 含 采光好；「地铁口/号线」→近地铁；「独立卫生间」→独卫；「押一付一」→可月付；「带阁楼」→带露台（阁楼）。
- **否定安全**：「无燃气」「不通煤气」→features **不**含燃气；「非近地铁」→不含近地铁。
- 飞书自由词：标签列「精装、南北通透、独立卫生间」→采光好/独卫 被规范化打上，精装（无对应白名单）不产生非法值。
- **持久化**：`normalizeListingForm` 后 `listing.features` 真的含文本推断项（非仅展示层）。
- 不覆盖：人工选「电梯」+文本无电梯→保留；文本有燃气+人工没选→补上。
- 回归：现有 8 项匹配、`assistant-eval-runner` 12/12、`v1-final-audit`、listing/feishu 既有测试全绿；company-default（免押金/电梯）不变。

红线：精确优先**不伪造**（否定安全是硬指标）；不改 need 侧词表与匹配打分；不动 `smoke-test.js`；不提交 `server/data`/`server/certs`/`.env`/凭据/`.ygbak`；不与飞书备份模块交叉。

验收（Codex 自测，Claude 会额外复验）：Claude 将用真实 2 套房源 + 构造的否定/飞书自由词样例复验——(a) 该打的打上且**持久化**，(b) 否定不误打，(c) 现有行为无回退。

需要 Codex 做什么：按上开发，一改一 commit，不主动 push，完成转 `CLAUDE_REVIEW` 附 commit/测试/红线。
需要第三裁判/用户介入：暂无。

### 2026-07-06 22:45 | Claude | 下发第二刀：需求特征白名单与房源对齐（NEED-1 / MODEL-4） | CODEX_DOING（已后置，见 23:10）

状态：`CODEX_DOING`（Claude 下发规格，待 Codex 开发）

背景/现状（Claude 已核实 file:line）：
- 房源侧可标 13 项实特征：`listing-features.js:6-21` `LISTING_FEATURE_OPTIONS` = 近地铁/电梯/燃气/独卫/朝南/带阳台/带露台（阁楼）/可短租/可月付/干湿分离/采光好/首次出租/民水民电（+legacy 免押金/不分佣/整租/合租/可带看/急租）。
- 需求侧只认 8 项：`match-service.js:102-111` `FEATURE_RULES`（带阳台/燃气/独卫/电梯/近地铁/朝南/可养宠/免押金）；`need-parser.js:10` `CANONICAL_FEATURES` 同 8 项。
- **断裂（NEED-1）**：干湿分离/采光好/可短租/可月付/首次出租/民水民电/带露台（阁楼）共 **7 项**——房源能标、需求侧点不动（`parseFeatures`/`canonicalFeature` 静默丢弃）→ 用户说了也白说，且不满足这些的房源照样被推（拉低精确性）。
- **反向断裂（MODEL-4）**：可养宠在需求侧有、不在房源侧 `LISTING_FEATURE_OPTIONS` → `invalidListingFeatures` 会拒绝房源存「可养宠」，养宠需求只能靠标题全文碰运气。

**真实库存核实（Claude 22:50，用户约束「只根据目前上传房源的房源特色做匹配」）**：当前 `db.json` 仅 **2 套**上传房源，房源特色分布 = `可月付×1 / 近地铁×1 / 电梯×1 / 免押金×1`（+legacy 不分佣）。即本刀拟对齐的 7 项里，**只有「可月付」当前真实有库存**，其余 6 项（干湿分离/采光好/可短租/首次出租/民水民电/带露台）当前零库存。据此本刀口径收紧为「需求侧词表 = 房源特色字段词表（`LISTING_FEATURE_OPTIONS`），匹配天然只对真实带该特色的房源生效」——**扩的是词表、不是数据；不新增任何目前未上传的房源特色选项。**

匹配机制（Claude 已核实，供 Codex 参考）：`featureMatched(listing,feature)`（`match-service.js:748`）= `listingFeatureSet` 命中 feature 名，或 `getFeatureRule(feature).aliases` 全文命中。`listingFeatureSet`（`:735`）已把 `listing.features` 结构化项按原名放进集合——**所以只要 `FEATURE_RULE.name` 与房源选项字符串一致，结构化房源即可命中**；不一致则需靠 aliases 全文兜底。**注意「带露台（阁楼）」含全角括号，name/aliases 要能命中该结构化值。**

任务（精确优先框架内、纯扩词表、后端为主）：
1. `match-service.js` `FEATURE_RULES` 增补 7 项（name 与 `LISTING_FEATURE_OPTIONS` 字符串对齐，各配 aliases/missing/reason）：干湿分离、采光好、可短租、可月付、首次出租、民水民电、带露台（阁楼）。aliases 由 Codex 斟酌，但必须保证：房源 features 结构化存了该项时 `featureMatched=true`；未存时给出「没有X」差异。
2. `need-parser.js` `CANONICAL_FEATURES` 与 `FEATURE_ALIASES` 同步补这 7 项（LLM 路径也能吐出）。两侧词表保持单一口径（建议以 `FEATURE_RULES` 为 SSOT 派生，或人工对齐并加一条测试守护一致性）。
3. **本刀不新增房源特色选项**（依据用户「只根据目前上传房源的房源特色」约束修订）：**不**把 可养宠 加入 `LISTING_FEATURE_OPTIONS`——可养宠不在目前上传的房源特色内，加它＝给不存在的库存建匹配。可养宠保持需求侧现状，请求时按精确优先诚实空结果/追问；MODEL-4 房源侧补录留到确有可养宠库存或产品明确要开该标签时再单独开刀。
4. **只扩词表、不扩数据**：不改匹配打分权重、不改 `featurePriority` 的硬/软判定（「必须X」→hard、否则 preference 保持不变）。新增 7 项天然只对「房源 features 真的带该项」的房源生效——当前零库存的 6 项不会凭空匹配，随对应房源上传自动生效（前向兼容、不伪造）。

拟修改文件：`server/src/match-service.js`、`server/src/assistant/need-parser.js`、新增或扩充 `server/scripts/assistant-feature-parity-test.js`、`docs/AI协作会话-Yooni助手.md`。（本刀**不改** `listing-features.js`。）

测试（必须新增）：
- 两侧一致性：`LISTING_FEATURE_OPTIONS` 里每个非 legacy 实特征都能被需求侧 parse 出来（遍历断言）。
- 逐特征：「要干湿分离的」→ `need.preferences.features` 含 干湿分离；「必须采光好」→ `need.hardConstraints.features` 含 采光好。
- 匹配正确：`listing.features=['干湿分离']` + 硬性干湿分离 → `featureMatched=true`、无「没有干湿分离」差异；listing 无该特征 → 有差异且硬性时被 `canBeNearby` 排除。
- 库存现状守护（真实库存口径）：当前有库存的「可月付」作需求可命中现有房源；零库存特征（如干湿分离）作硬性时精确优先返回空/追问、**不误推**不满足的房源。

红线/不得触碰：
- 不违背 V1 精确优先：`assistant-eval-runner.js` 12 固定用例（含 `:382` 无房不许乱推）、`v1-final-audit.js` 必须继续全绿。
- 不做自动放宽/推近似；**不改现有 8 项特征的行为**（回归：燃气/电梯等既有用例不得变化）。
- 不动 `smoke-test.js`；不提交 `server/data`/`server/certs`/`.env`/凭据/`.ygbak`；不与飞书备份模块交叉。

验收标准（Codex 自测，再交 Claude 审）：
1. 新增特征对齐/匹配测试通过。
2. 全量 `server/scripts/*-test.js`（除 `smoke-test.js`）通过；`assistant-eval-runner` 12/12；`v1-final-audit` 通过；`assistant-real-need-baseline-test` 不回退。
3. Claude 会额外用原始探针 + 新特征对抗用例复验：新特征能被点动、精确性无回退（不满足新硬特征的房源确被排除）、既有 8 项行为不变。

需要 Codex 做什么：按上开发，一改一 commit，不主动 push，完成转 `CLAUDE_REVIEW` 并附 commit/测试/红线。
需要第三裁判/用户介入：暂无（可养宠 / 新增房源特色选项已按用户「只根据目前上传房源的房源特色」约束移出本刀范围）。

### 2026-07-06 22:30 | Claude | 第一刀第二裁判审计：通过 | READY_TO_DEPLOY

状态：`READY_TO_DEPLOY`（审计通过，无阻断项；可随下次小程序部署上线，部署时机由用户决定）

审计范围：commit `0391814 fix: 提升 Yooni 模糊找房路由`（7 文件：intents.js、graph.js、assistant-intent-router-test.js、assistant-real-need-baseline-test.js、README.md、交接报告、本文件）。审计口径＝精确优先：只查「有没有偷偷放宽、有没有回退 V1 断言、符合率是否真涨、业务 FAQ/闲聊有没有被误拉进找房链乱推」。

结论：**通过。** 逐条独立复验（非转述 Codex 自报）：
1. **符合率真涨**：用 Claude 原始探针（16 条，与 Codex 测试相互独立）跑当前 HEAD，**81% → 100%（16/16）**。三条原失败项修复：「想找个安静点的」→ 追问（原 faq）；「换一个便宜点的」「刚才那套的位置发我」多轮 → 继续找房（原 faq），证明 `graph.js` 传入 `state.previousNeed` 已真正接通续问链。
2. **精确优先未破**（补充对抗用例，均无乱推）：分佣比例→business_faq、加入房源群→business_faq、「你好在吗」→fallback、「我想住得舒服点」→rental_match 但 0 房源+追问、「第三套发我看看」（无上轮）→fallback 未被劫持。业务 FAQ 门（`!businessTopic`）保留，续问由 `hasPreviousNeed` 兜底，设计克制。
3. **无 V1 回退**：`assistant-eval-runner.js` 固定评估 12/12（含 `:382`「已知地点完整条件无房时不能放宽乱推」）；`v1-final-audit.js` 全过（v1-acceptance 26/0）；`assistant-real-need-baseline-test.js` 16/16、`assistant-intent-router-test.js` 通过。
4. **提交范围干净**：Yooni commit 未混入 P0-1 飞书备份、`server/data`、`server/certs`、`.env`、飞书凭据、`.ygbak`；未改 `smoke-test.js`。
5. **Codex 基线测试非橡皮图章**：`assertFollowUp` 断言 intent=rental_match 且有追问且零房源，并反向断言「报备签单→FAQ/report」「地图没坐标→FAQ/map」，覆盖了下发的 3 个失败点。

阻断项：无。

非阻断风险（留观，不影响本刀上线）：
1. **指代是「继续搜索」而非「定位到具体第 N 套」**：「刚才那套的位置发我」实为按上轮 need 重跑搜索返回结果，尚未把「那套/第二套」解析到上一轮返回的具体卡片（缺跨轮结果集记忆，审计报告 CHAT-5，属后续阶段）。Codex 文档未过度声称已实现卡片级指代，如实。
2. **生活化正则含「住」较宽**：会把较多含「住」的模糊输入拉进找房链→追问。精确优先安全（只追问不乱推），但略显主动；后续可收窄或加语境判定。

复验命令：
```
node server/scripts/assistant-real-need-baseline-test.js   # 16/16
node server/scripts/assistant-intent-router-test.js
node server/scripts/assistant-eval-runner.js               # 固定 12/12，含无房不许乱推
node server/scripts/v1-final-audit.js
```

需要 Codex/用户做什么：本刀可上线，无需返修。下一刀备选（仍精确优先）：NEED-1 需求特征白名单与房源 13 项对齐（纯扩表、让「干湿分离/采光好」等可点动）；或 confidence-gate 对模糊需求做定向澄清追问（把「安静点/带娃上学」的通用追问升级为贴题追问）。由用户决定是否开下一刀。

### 2026-07-06 22:10 | Codex | 第一刀开发完成：路由修正 + 真实需求基线入仓 | CLAUDE_REVIEW

状态：`CLAUDE_REVIEW`（等待 Claude 第二裁判审计）

拟/实修改文件清单：
- `server/src/assistant/intents.js`
- `server/src/assistant/graph.js`
- `server/scripts/assistant-intent-router-test.js`
- `server/scripts/assistant-real-need-baseline-test.js`
- `server/README.md`
- `docs/交接报告-20260704.md`
- `docs/AI协作会话-Yooni助手.md`

已完成：
- `intent_router` 增加生活化找房诉求识别：安静、安全、带娃上学、女生居住等不再落到 FAQ；仍由后续置信门追问或匹配，不静默放宽。
- `intent_router` 增加上一轮找房后的续问/指代识别：换一套、便宜点、刚才那套的位置等带 `previousNeed` 时进入找房链。
- `graph.js` 调用 `routeIntent` 时传入 `previousNeed`，让续问/指代能看到上一轮找房上下文。
- 新增 `assistant-real-need-baseline-test.js`，用 16 条真实口语需求锁定精确优先行为：标准推荐、字段不足追问、地点歧义追问、续问不落 FAQ、业务/地图 FAQ 不误判。
- README 与交接报告已同步本轮路由边界和真实需求基线脚本。

验证结果：
- 改动前基线：全量 `server/scripts/*-test.js`（排除 `smoke-test.js`）+ `server/scripts/v1-final-audit.js` 全绿。
- 近场验证：`assistant-intent-router-test.js` 通过；`assistant-real-need-baseline-test.js` 通过，16/16。
- 改动后全量：所有 `server/scripts/*-test.js`（排除 `smoke-test.js`）通过；`server/scripts/v1-final-audit.js` 通过。

红线自查：
- 未修改 `server/scripts/smoke-test.js`。
- 未触碰 `server/data/`、`server/certs/`、`.env`、`lark-*.json`、`project.private.config.json`。
- 未新增自动放宽/自动推近似逻辑；`assistant-eval-runner.js` 固定评估继续全绿。
- 工作区存在 P0-1 飞书备份、Nginx、Claude 审计等其他协作改动，本次提交会选择性暂存，避免混入非 Yooni 第一刀内容。

需要 Claude 审计：
- 复核新增路由是否仍符合 V1 精确优先，不把明确业务 FAQ 或地图使用问题误拉进找房链。
- 复核 16 条真实需求基线是否覆盖你下发的 3 个失败点，并确认无回退。
- 复核本次 commit 是否未混入 P0-1 飞书备份模块或敏感文件。

### 2026-07-06 22:00 | Claude | 评估审计 + 真实需求基线（交底 & 下发第一刀） | CODEX_DOING

状态：`CODEX_DOING`（审计与基线已交付，开发任务下发 Codex）

关联分支/commit：`v1-broker`，基线 HEAD `42d0392`（33 个相关脚本全绿）。

**已完成（Claude 审计侧）：**
- 完整评估审计报告：`docs/找房助手评估审计-20260706.md`（8 维审计 + 逐维对抗复核）。结论：能用层基本清零（坐标层 MODEL-2 仍是 blocker，属另一独立议题）；好用层天花板在①需求表达能力（8 项闭合特征白名单）②房源数据模型③默认路径无自动放宽。匹配算法本身是连续打分、不是填槽机器人。
- 真实需求基线（探针，只读，尚未进仓库）：16 条真实口语需求、**精确优先符合率 81%（13/16）**。防幻觉/冲突用例全过（验证「保持精确优先」是对的）。**3 条失败同一根因**：纯模糊/纯指代需求（「想找个安静点的」「换一个便宜点的」「刚才那套的位置」）被 `intent_router` 判为非找房意图、甩去 `business_faq` 通用套话。

**本轮下发给 Codex 的第一刀（精确优先框架内，零放宽风险）：**

目标：把 81% 往上抬，只修「听不懂」，不碰「放宽」。

1. **固化基线测试**：新增 `server/scripts/assistant-real-need-baseline-test.js`，内置这 16 条真实需求用例（分类：标准/口语/模糊/指代/防幻觉），复用 `assistant-eval-runner.js` 的 `makeDb()` 与 `assistant-service.chat`，按「精确优先」判定每条行为（recommend/ask/faq/no_result），输出符合率百分比；符合率 < 阈值即非零退出。用例清单与判定口径见附录 A（Claude 提供，探针原型在会话中）。
2. **修 `intent_router`**（`server/src/assistant/intents.js` + 必要时 `server/src/assistant/graph.js` 的 router edge）：当输入**无明显 business 关键词**（报备/签单/分佣/地图规则等 FAQ 话题）、又像**居住诉求或续问/指代**（「换一个」「便宜点的」「刚才那套」「安静点」「带娃上学」等）时，**默认路由进找房解析链**（`llm_need_parser`），由下游 `confidence_gate` 追问补槽，而不是默认 `fallback → business_faq`。指代类可复用 `need-parser.js:97` 已有的 `/改|换|刚才|之前/` 增量意图正则。
3. **回归验证**：用同一批 16 条证明符合率**从 81% 上升且无回退**；被误判的口语/指代需求应从「faq 套话」变为「进找房链追问或继续找房」。

拟修改文件（Codex 可细化，但不得越界）：
- 新增 `server/scripts/assistant-real-need-baseline-test.js`
- 改 `server/src/assistant/intents.js`（放宽 `looksLikeRentalNeed` / 增续问指代判定）
- 如需：`server/src/assistant/graph.js`（仅 router 分流，不改各工具节点契约）
- 改本文件 `docs/AI协作会话-Yooni助手.md` 记录

红线 / 不得触碰：
- **不违背 V1 精确优先**：`assistant-eval-runner.js` 12 条固定用例、`assistant-eval-runner.js:382`「无房不许乱推」、模糊地点 `ambiguous`/未知小区 `missing` 追问逻辑，全部必须继续通过。
- 不做「自动放宽/自动推近似」；不编造小区/坐标/特征；不扩学区/通勤字段（留后续阶段，本轮房源量少、只用现有字段）。
- 不改 `smoke-test.js`；不提交 `server/data`/`server/certs`/`.env`/密钥/token/真实备份。
- 不与 P0-1 飞书备份模块交叉改动（那是另一模块另一文件）。

验收标准（Codex 完成后自测，再交 Claude 审）：
1. `node server/scripts/assistant-real-need-baseline-test.js` 通过，符合率 > 81% 且无回退用例。
2. 全量 `server/scripts/*-test.js`（排除 `smoke-test.js`）通过。
3. `node server/scripts/assistant-eval-runner.js` 固定评估 12/12 通过。
4. `node server/scripts/v1-final-audit.js` 通过。
5. 红线扫描：无 `server/data`/`server/certs`/`.env`/密钥/token 进入提交。

需要 Codex 做什么：按上述开发，一项改动一个 commit，不主动 push。完成后把状态改 `CLAUDE_REVIEW`，附 commit、实际改动文件、测试结果、红线扫描结果；我按精确优先口径审「有没有偷偷放宽、有没有回退 V1 断言、符合率是否真涨」。

需要第三裁判/用户介入：暂无。若发现修 `intent_router` 会不可避免地放宽精确优先（如误把明确的非找房闲聊也拉进找房链导致乱推），状态改 `THIRD_JUDGE_REQUIRED` 并停止，交用户拍板。

---

附录 A（16 条真实需求基线用例，Claude 探针口径）：
- 标准结构化（应 recommend）：拱墅万达附近2000左右的单间 / 新天地3公里内整租两室 / 祥符空小区1500左右一室整租
- 口语可表示（应 recommend/ask）：想要带电梯的一室租金1500上下 / 拱墅两室要燃气也要阳台
- 模糊·现字段无法表示（精确优先应 ask，不应 faq/乱推）：带娃上学方便的两室 / 想找个安静点的房子 / 通勤到黄龙半小时内的一室 / 女生合租要新装修的 / 拎包入住的单间就行
- 防幻觉冲突（应 ask，V1 正确行为，须保持）：拱墅万达附近2000左右整租单间（租法户型冲突）/ 万达附近2000的单间（多候选地点）/ 想住陌生小区1500的一室整租（未知小区无坐标）
- 多轮·指代/撤销（末轮应继续找房/正确合并，不应 faq）：[新天地3公里内4000以内整租两室 → 换一个便宜点的] / [拱墅万达附近2000的单间 → 刚才那套的位置发我] / [拱墅两室要燃气 → 燃气不要了]
- 当前基线：单轮 13 条中 12 条符合、多轮 3 条中 1 条符合；总 16 条符合 13 条 = 81%。头号失败：想找个安静点的、换一个便宜点的、刚才那套的位置 → 三条均落 faq。
