# 并行开发边界

## 总规则

- 并行任务禁止修改同一文件。
- 不允许修改任务范围之外的文件。
- 并行任务禁止修改 `server/scripts/smoke-test.js`。
- 发现必须跨范围修改时，只记录为集成事项，不擅自修改。
- 每个任务结束必须执行 `git diff --name-only`，并检查是否越界。

## navigation 任务允许修改

- `app.json`
- `custom-tab-bar/**`
- `pages/index/**`
- `pages/listings/**`
- `pages/profile/**`

## navigation 任务禁止修改

- `pages/map/**`
- `pages/match-chat/**`
- `server/**`
- `server/scripts/smoke-test.js`

## map 任务允许修改

- `pages/map/**`
- `utils/api-service.js`
- `server/src/index.js`
- `server/src/domain.js`
- `server/src/community-coordinates.js`
- 新建 `server/scripts/map-v1-test.js`

## map 任务禁止修改

- `app.json`
- `custom-tab-bar/**`
- `pages/index/**`
- `pages/listings/**`
- `pages/match-chat/**`
- `server/src/llm.js`
- `server/scripts/smoke-test.js`

## assistant 任务允许修改

- `pages/match-chat/**`
- `utils/llm-service.js`
- `server/src/llm.js`
- 新建 `server/src/match-service.js`
- 新建 `server/scripts/assistant-v1-test.js`

## assistant 任务禁止修改

- `app.json`
- `custom-tab-bar/**`
- `pages/index/**`
- `pages/listings/**`
- `pages/map/**`
- `server/src/domain.js`
- `server/src/index.js`
- `utils/api-service.js`
- `server/scripts/smoke-test.js`

## 任务间固定约定

- 助手进入地图时，将条件写入 `ynzy_pending_map_filters`。
- 然后使用 `wx.switchTab({ url: '/pages/map/map' })`。
- 地图页在 `onShow` 中读取并清除该存储键。
- 首页进入房源页时使用 `ynzy_pending_listing_filters`。
- 房源页在 `onShow` 中读取并清除该存储键。
- 并行任务不得自行更改这些键名。

## 合并顺序

1. `feat/v1-navigation`
2. `feat/v1-map`
3. `feat/v1-assistant`
4. 最后在 `v1-broker` 做统一集成测试

## 严格要求

- 不修改任何已有业务文件。
- 不运行 smoke test。
- 不开发导航、地图、助手、报备或签单功能。
- 不提交代码。
- 不推送代码。

## 任务结束输出

每个任务结束必须输出：

- 修改文件
- 接口变化
- 数据结构变化
- 测试结果
- 未解决问题
- 微信开发者工具验收步骤
