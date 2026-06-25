# PARALLEL_TASKS.md

## 并行任务总规则

- 并行任务禁止修改相同文件。
- 任何任务都禁止修改自身允许范围之外的文件。
- 并行任务禁止修改 `server/scripts/smoke-test.js`。
- 每个任务结束必须执行 `git diff --name-only`，并检查是否出现越界文件。

## navigation 允许范围

- `app.json`
- `custom-tab-bar/**`
- `pages/index/**`
- `pages/listings/**`
- `pages/profile/**`

## map 允许范围

- `pages/map/**`
- `utils/api-service.js`
- `server/src/index.js`
- `server/src/domain.js`
- `server/src/community-coordinates.js`
- `server/scripts/map-v1-test.js`

## assistant 允许范围

- `pages/match-chat/**`
- `utils/llm-service.js`
- `server/src/llm.js`
- `server/src/match-service.js`
- `server/scripts/assistant-v1-test.js`
