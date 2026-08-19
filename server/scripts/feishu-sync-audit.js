const dbStore = require('../src/db')
const feishuSync = require('../src/feishu-sync')

function cell(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\|/g, '/').replace(/\r?\n/g, ' ')
}

function markdownTable(rows) {
  const header = ['房号', '表内状态', '匹配到的素材文件名', '同步结果', '失败原因']
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`
  ]
  rows.forEach((row) => {
    lines.push(`| ${[
      row.room,
      row.tableStatus,
      row.matchedMaterialName,
      row.syncResult,
      row.failureReason
    ].map(cell).join(' | ')} |`)
  })
  return lines.join('\n')
}

function auditAdminId(db = {}) {
  const users = db.users || []
  const admin = users.find((item) => item && (item.isAdmin || item.role === '管理员'))
  return admin ? (admin.id || admin.userId || 'system-feishu-sync') : 'system-feishu-sync'
}

async function main() {
  const baseDb = dbStore.clone(dbStore.readDb())
  const auditDb = dbStore.clone(baseDb)
  const result = await feishuSync.sync(auditDb, auditAdminId(auditDb), {
    dryRun: true,
    skipSheetSnapshot: true
  })
  const rows = result.auditRows || []
  const activeRows = rows.filter((row) => String(row.syncResult || '').startsWith('上架'))
  const videoRows = rows.filter((row) => row.syncResult === '上架-已配视频')
  const missingRows = rows.filter((row) => /缺视频素材/.test(String(row.syncResult || '')))

  console.log(`# 飞书素材同步对账（只读 dry-run）`)
  console.log('')
  console.log(`- 房源表记录数：${result.sourceRecordCount}`)
  console.log(`- 素材库视频数：${result.materialCount}`)
  console.log(`- 公司在租行数：${activeRows.length}`)
  console.log(`- 视频房源数：${videoRows.length}`)
  console.log(`- 缺视频素材：${missingRows.length}`)
  console.log(`- 素材搬运失败降级：${result.materialTransferFailed || 0}`)
  console.log('')
  console.log(markdownTable(rows))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
