const assert = require('assert')
const fs = require('fs')
const path = require('path')

const htmlPath = path.join(__dirname, '..', '..', 'admin-web', 'index.html')
const source = fs.readFileSync(htmlPath, 'utf8')

const lines = source.split(/\r?\n/)
const innerHtmlAssignments = lines
  .map((line, index) => ({ line, lineNo: index + 1 }))
  .filter(({ line }) => /\.innerHTML\s*=/.test(line))

assert.strictEqual(
  innerHtmlAssignments.length,
  25,
  `admin-web/index.html innerHTML sink count changed; review every new sink and update this test.\n${innerHtmlAssignments.map(({ lineNo, line }) => `${lineNo}: ${line.trim()}`).join('\n')}`
)

function assertPattern(label, pattern) {
  assert.ok(pattern.test(source), `${label} must stay escaped with safeText/safeAttr`)
}

const requiredEscapes = [
  ['commission listing', /\$\{safeText\(item\.listing\)\}/],
  ['commission uploader', /\$\{safeText\(item\.uploader\)\}/],
  ['commission dealer', /\$\{safeText\(item\.dealer\)\}/],
  ['showing community/listing', /\$\{safeText\(item\.community\s*\|\|\s*item\.listing\)\}/],
  ['showing user phone', /\$\{safeText\(item\.userPhone\s*\|\|[^)]*\)\}/],
  ['showing uploader', /\$\{safeText\(item\.uploader\s*\|\|[^)]*\)\}/],
  ['showing review note', /\$\{safeText\(item\.reviewNote\s*\|\|[^)]*\)\}/],
  ['admin user select id attr', /<option value="\$\{safeAttr\(item\.id\)\}">/],
  ['admin user select name', /\$\{safeText\(item\.name\s*\|\|\s*item\.id\)\}/],
  ['admin user select phone', /\$\{safeText\(item\.phone\s*\|\|[^)]*\)\}/],
  ['admin account name', /\$\{safeText\(item\.name\)\}/],
  ['launch title', /\$\{safeText\(item\.title\)\}/],
  ['launch detail', /\$\{safeText\(item\.detail\s*\|\|[^)]*\)\}/],
  ['feishu sync name', /feishuSyncRows[\s\S]*\$\{safeText\(item\.name\)\}/],
  ['feishu sync note', /feishuSyncRows[\s\S]*\$\{safeText\(item\.note\s*\|\|[^)]*\)\}/]
]

requiredEscapes.forEach(([label, pattern]) => assertPattern(label, pattern))

const reviewedNonTextFields = [
  ['commission rate is escaped as text', /\$\{safeText\(item\.rate\)\}/],
  ['commission money is rendered by moneyText then escaped', /\$\{safeText\(moneyText\(item\.landlordCommission,/],
  ['showing reward is escaped as text', /\$\{safeText\(item\.reward\)\}/],
  ['status label text is escaped', /<span class="\$\{pillClass\(item\.status\)\}">\$\{safeText\(item\.status\)\}<\/span>/],
  ['launch summary numeric values are escaped', /launchSummary[\s\S]*\$\{safeText\(item\.value\)\}/]
]

reviewedNonTextFields.forEach(([label, pattern]) => assertPattern(label, pattern))

const unsafeRules = [
  {
    name: 'raw item interpolation in a text node',
    pattern: />\s*\$\{\s*item\.[A-Za-z0-9_$]+(?:\s*(?:\|\||\?\?)\s*[^}]*)?\s*\}/
  },
  {
    name: 'raw item interpolation before a closing text node',
    pattern: /\$\{\s*item\.[A-Za-z0-9_$]+(?:\s*(?:\|\||\?\?)\s*[^}]*)?\s*\}\s*</
  },
  {
    name: 'raw item interpolation in an HTML attribute',
    pattern: /\b(?:data-[\w-]+|href|src|value|title|alt)=["']\$\{\s*item\.[A-Za-z0-9_$]+(?:\s*(?:\|\||\?\?)\s*[^}]*)?\s*\}/
  }
]

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
  `admin-web/index.html still has item fields interpolated without safeText/safeAttr:\n${unsafeLines.join('\n')}`
)

console.log('admin-web-xss-v1-test passed')
