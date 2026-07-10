// 封面错误事件可能晚于列表刷新到达；必须按稳定房源 id + 当时 URL 定位，不能按旧数组下标误清其他房源。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { findFailedCoverIndex } = require('../../utils/listing-cover-state')

const repoRoot = path.resolve(__dirname, '..', '..')
const pageFiles = [
  ['pages/index/index.js', 'pages/index/index.wxml'],
  ['pages/listings/listings.js', 'pages/listings/listings.wxml'],
  ['pages/my-listings/my-listings.js', 'pages/my-listings/my-listings.wxml']
]

const original = [
  { id: 'L-A', coverUrl: 'https://oss.example/a.jpg?signature=old-a' },
  { id: 'L-B', coverUrl: 'https://oss.example/b.jpg?signature=old-b' }
]

assert.strictEqual(
  findFailedCoverIndex(original, 'L-B', original[1].coverUrl),
  1,
  '未刷新时应定位到原封面项'
)

const reordered = [original[1], original[0]]
assert.strictEqual(
  findFailedCoverIndex(reordered, 'L-B', original[1].coverUrl),
  0,
  '列表重排后应按房源 id 找到新下标，不能沿用旧 index=1'
)

const refreshedUrl = [
  { id: 'L-B', coverUrl: 'https://oss.example/b.jpg?signature=new-b' },
  original[0]
]
assert.strictEqual(
  findFailedCoverIndex(refreshedUrl, 'L-B', original[1].coverUrl),
  -1,
  '同一房源已刷新签名 URL 时，旧图片的迟到错误不得清掉新封面'
)
assert.strictEqual(findFailedCoverIndex([original[0]], 'L-B', original[1].coverUrl), -1, '房源已离开列表时应忽略迟到错误')
assert.strictEqual(findFailedCoverIndex(original, '', original[1].coverUrl), -1, '缺房源 id 时不得回退到数组下标')
assert.strictEqual(findFailedCoverIndex(original, 'L-B', ''), -1, '缺失败 URL 时不得清理当前封面')
assert.strictEqual(findFailedCoverIndex(null, 'L-B', original[1].coverUrl), -1, '列表无效时应安全忽略')

let coverImageCount = 0
pageFiles.forEach(([jsFile, wxmlFile]) => {
  const js = fs.readFileSync(path.join(repoRoot, jsFile), 'utf8')
  const wxml = fs.readFileSync(path.join(repoRoot, wxmlFile), 'utf8')
  assert.ok(js.includes("require('../../utils/listing-cover-state')"), `${jsFile} 必须复用稳定身份定位 helper`)
  assert.ok(/findFailedCoverIndex\(this\.data\.listings, dataset\.id, dataset\.cover\)/.test(js), `${jsFile} 错误回调必须同时校验 id 与失败 URL`)
  assert.ok(!/onCoverError[\s\S]{0,240}dataset\.index/.test(js), `${jsFile} 不得继续按事件旧下标清封面`)

  const imageTags = wxml.match(/<image\b[^>]*binderror="onCoverError"[^>]*>/g) || []
  assert.ok(imageTags.length > 0, `${wxmlFile} 应存在封面错误兜底图片`)
  imageTags.forEach((tag) => {
    coverImageCount += 1
    assert.ok(tag.includes('data-id="{{item.id}}"'), `${wxmlFile} 封面错误事件必须携带稳定房源 id`)
    assert.ok(tag.includes('data-cover="{{item.coverUrl}}"'), `${wxmlFile} 封面错误事件必须携带当时 URL`)
    assert.ok(!tag.includes('data-index='), `${wxmlFile} 封面错误事件不得再携带易过期数组下标`)
  })
})

assert.strictEqual(coverImageCount, 4, '首页、全部房源、我的房源公司/合作模式共应锁定 4 个封面错误入口')

console.log('listing-cover-error-race-test passed')
