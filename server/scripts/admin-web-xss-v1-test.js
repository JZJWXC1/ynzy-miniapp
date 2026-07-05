const assert = require('assert')
const fs = require('fs')
const path = require('path')

const htmlPath = path.join(__dirname, '..', '..', 'admin-web', 'index.html')
const source = fs.readFileSync(htmlPath, 'utf8')

const unsafeRules = [
  {
    name: '文本节点裸插值',
    pattern: />\s*\$\{\s*item\.[A-Za-z0-9_$]+(?:\s*(?:\|\||\?\?)\s*[^}]*)?\s*\}/
  },
  {
    name: '文本节点尾部裸插值',
    pattern: /\$\{\s*item\.[A-Za-z0-9_$]+(?:\s*(?:\|\||\?\?)\s*[^}]*)?\s*\}\s*</
  },
  {
    name: 'HTML 属性裸插值',
    pattern: /\b(?:data-[\w-]+|href|src|value|title|alt)=["']\$\{\s*item\.[A-Za-z0-9_$]+(?:\s*(?:\|\||\?\?)\s*[^}]*)?\s*\}/
  }
]

const lines = source.split(/\r?\n/)
const unsafeLines = []
lines.forEach((line, index) => {
  unsafeRules.forEach((rule) => {
    if (rule.pattern.test(line)) {
      unsafeLines.push(`${index + 1}: ${rule.name}: ${line.trim()}`)
    }
  })
})

assert.deepStrictEqual(
  unsafeLines,
  [],
  `admin-web/index.html 仍存在未经过 safeText/safeAttr 的 item 字段插值：\n${unsafeLines.join('\n')}`
)

console.log('admin-web-xss-v1-test passed')
