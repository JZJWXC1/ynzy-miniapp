const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const configPath = path.join(rootDir, 'utils', 'deploy-config.js')
const input = process.argv[2]
const useLocal = input === '--local'
const useInternalHttp = input === '--internal-http'
const rawUrl = useInternalHttp ? process.argv[3] : input
const baseUrl = useLocal ? 'http://127.0.0.1:3000' : String(rawUrl || '').trim().replace(/\/+$/, '')

if (!baseUrl) {
  console.error('用法：node scripts/set-miniapp-api.js https://api.example.com')
  console.error('本地联调：node scripts/set-miniapp-api.js --local')
  console.error('内部 HTTP 测试：node scripts/set-miniapp-api.js --internal-http http://公网入口地址')
  process.exit(1)
}

if (!useLocal && !useInternalHttp && !/^https:\/\/[^/]+/.test(baseUrl)) {
  console.error('正式小程序接口地址必须使用 https:// 开头的域名；内部 HTTP 测试请显式使用 --internal-http')
  process.exit(1)
}

if (useInternalHttp && !/^http:\/\/[^/]+/.test(baseUrl)) {
  console.error('内部 HTTP 测试地址必须使用 http:// 开头')
  process.exit(1)
}

const content = `module.exports = {
  env: 'prod',
  baseUrl: '${baseUrl}',
  paymentMode: 'manual'
}
`

fs.writeFileSync(configPath, content, 'utf8')
console.log(`已更新小程序接口地址：${baseUrl}`)
if (useInternalHttp) {
  console.log('注意：HTTP 地址只建议用于微信开发者工具内部测试，正式版/体验版仍建议准备 HTTPS 域名。')
}
