const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.js'), 'utf8')
const routeMatch = source.match(/if \(method === 'POST' && pathname === '\/mini\/llm\/match'\) \{[\s\S]*?\n  \}/)

assert.ok(routeMatch, '必须保留 /mini/llm/match 路由')
const route = routeMatch[0]
assert.ok(route.includes('[llm-match]'), 'LLM 匹配接口必须写入生产耗时日志')
assert.ok(route.includes('durationMs='), 'LLM 匹配日志必须包含 durationMs')
assert.ok(route.includes('status=200'), 'LLM 匹配成功日志必须包含状态码')
assert.ok(route.includes('error.statusCode || 500'), 'LLM 匹配失败日志必须包含错误状态码')
assert.ok(route.includes('guest='), 'LLM 匹配日志必须标明游客/登录口径')
assert.ok(!/console\.log\([^)]*body/.test(route), 'LLM 匹配日志不能输出请求正文')
assert.ok(!/JSON\.stringify\([^)]*body/.test(route), 'LLM 匹配日志不能序列化请求正文')

console.log('llm-match-duration-log-test passed')
