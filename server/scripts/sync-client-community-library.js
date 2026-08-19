// 以服务端小区库为唯一数据源，重新生成客户端 utils/gongshu-communities.js。
// 背景：服务端已知小区 = 拱墅名单 ∪ 坐标表键，客户端此前只有拱墅名单，
// 缺的小区（如「皋塘运都」）在小程序编辑/上传时被误判未匹配，申报
// requiresManualReview=true 后被服务端「只允许收紧」规则采纳，房源误转人工审核。
// 用法：node server/scripts/sync-client-community-library.js
// 一致性由 server/scripts/community-library-parity-test.js 锁定。
const fs = require('fs')
const path = require('path')
const { GONGSHU_COMMUNITIES, normalizeCommunityKey } = require('../src/community-library')
const { communityCoordinates } = require('../src/community-coordinates')

const CLIENT_LIBRARY_PATH = path.join(__dirname, '..', '..', 'utils', 'gongshu-communities.js')

// 服务端全量已知小区（去重后保序：拱墅名单在前，坐标表新增小区在后）
function serverKnownCommunities() {
  const seen = new Set()
  const names = []
  GONGSHU_COMMUNITIES.concat(Object.keys(communityCoordinates || {})).forEach((name) => {
    const key = normalizeCommunityKey(name)
    if (!key || seen.has(key)) return
    seen.add(key)
    names.push(String(name).trim())
  })
  return names
}

function buildClientLibrarySource() {
  const lines = serverKnownCommunities().map((name) => {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `  '${escaped}',`
  })
  return [
    '// 客户端小区库：由 server/scripts/sync-client-community-library.js 依据服务端库自动生成，请勿手改。',
    '// 新增小区请修改 server/src/community-library.js（或坐标表）后重跑该脚本，保持两端一致。',
    'module.exports = [',
    ...lines,
    ']',
    ''
  ].join('\n')
}

function syncClientLibrary() {
  const next = buildClientLibrarySource()
  const currentRaw = fs.existsSync(CLIENT_LIBRARY_PATH) ? fs.readFileSync(CLIENT_LIBRARY_PATH, 'utf8') : ''
  if (currentRaw.replace(/\r\n/g, '\n') === next) {
    console.log(`客户端小区库已是最新（${serverKnownCommunities().length} 个小区），无需改动`)
    return false
  }
  fs.writeFileSync(CLIENT_LIBRARY_PATH, next)
  console.log(`已重新生成 utils/gongshu-communities.js（${serverKnownCommunities().length} 个小区）`)
  return true
}

if (require.main === module) {
  syncClientLibrary()
}

module.exports = { serverKnownCommunities, buildClientLibrarySource, syncClientLibrary, CLIENT_LIBRARY_PATH }
