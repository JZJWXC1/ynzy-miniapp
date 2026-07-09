// 一次性迁移：为「没设过密码的中介/员工」发统一初始密码，让存量账号在登录改造上线后仍能登录。
//
// 安全设计：
// - 只设 passwordHash 为空、且非管理员、未软删的 db.users 项；【不覆盖】已自己改过密码的人 → 可重复安全执行。
// - 跑前自动备份 db.json（生产数据操作留回滚网）；--dry-run 只预览不写库。
// - 初始密码由命令行传入，【不硬编码进仓库】；用与登录相同的 scrypt（../src/auth-util）哈希，口径一致。
// - 用 db.updateDb 原子写（跨进程写锁），并在锁内重新判定，避免与运行中的服务并发写冲突。
//
// 用法（在 server 目录下）：
//   预览：node scripts/set-initial-broker-password.js 20241101 --dry-run
//   执行：node scripts/set-initial-broker-password.js 20241101
//   指定库：DATA_FILE=/opt/ynzy-miniapp/server/data/db.json node scripts/set-initial-broker-password.js 20241101
//
// 部署顺序：先部署含密码功能的新后端 → 跑本脚本发初始密码 → 通知中介用初始密码登录并在「我的→修改密码」改密。

const fs = require('fs')
const config = require('../src/config')
const dbStore = require('../src/db')
const { hashPassword, passwordIssue } = require('../src/auth-util')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const password = args.find((item) => !item.startsWith('--'))

function maskPhone(phone) {
  const value = String(phone || '')
  if (value.length >= 7) return `${value.slice(0, 3)}****${value.slice(-4)}`
  return value ? '***' : '(无手机号)'
}

// 中介/员工小程序账号：非管理员、未软删。管理员密码在 adminAccounts，另行管理，不在此处。
function isManagedBroker(user) {
  return user && !user.isAdmin && !user.deleted && !/管理员/.test(String(user.role || ''))
}

function main() {
  if (!password) {
    console.error('用法：node scripts/set-initial-broker-password.js <初始密码> [--dry-run]')
    process.exit(2)
  }
  const issue = passwordIssue(password)
  if (issue) {
    console.error(`初始密码不合规：${issue}`)
    process.exit(2)
  }

  const db = dbStore.readDb()
  const users = db.users || []
  const targets = users.filter((user) => isManagedBroker(user) && !user.passwordHash)
  const skippedHasPassword = users.filter((user) => isManagedBroker(user) && user.passwordHash)
  const skippedOther = users.filter((user) => !isManagedBroker(user))

  console.log(`数据文件：${config.dataFile}`)
  console.log(`db.users 总数：${users.length}`)
  console.log(`将设初始密码（无密码的中介/员工）：${targets.length} 个`)
  targets.forEach((user) => console.log(`  - ${user.name || '(无名)'} / ${maskPhone(user.phone)}`))
  console.log(`跳过·已自设密码（不覆盖）：${skippedHasPassword.length} 个`)
  console.log(`跳过·管理员或已软删：${skippedOther.length} 个`)

  if (dryRun) {
    console.log('\n[dry-run] 未写库。确认无误后去掉 --dry-run 执行。')
    return
  }
  if (!targets.length) {
    console.log('\n没有需要设初始密码的账号，未改动。')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${config.dataFile}.bak-set-initpw-${stamp}`
  fs.copyFileSync(config.dataFile, backup)
  console.log(`\n已备份原库：${backup}`)

  const nowText = new Date().toLocaleString('zh-CN', { hour12: false })
  const done = dbStore.updateDb((next) => {
    const set = []
    ;(next.users || []).forEach((user) => {
      // 锁内重新判定，避免与运行中的服务并发把已改密的账号覆盖回初始密码。
      if (isManagedBroker(user) && !user.passwordHash) {
        user.passwordHash = hashPassword(password)
        delete user.password
        user.passwordInitializedAt = nowText
        user.passwordInitializedBy = 'set-initial-broker-password'
        set.push(user.id)
      }
    })
    return set
  })

  console.log(`已为 ${done.length} 个中介/员工设初始密码（scrypt）。`)
  console.log('请通知本人用初始密码登录后，尽快在「我的 → 修改密码」改成自己的密码。')
}

main()
