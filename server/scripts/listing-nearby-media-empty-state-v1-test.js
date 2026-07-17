'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const pages = [
  {
    label: '详情页附近预览',
    wxml: 'pages/listing-detail/listing-detail.wxml',
    wxss: 'pages/listing-detail/listing-detail.wxss',
    coverError: 'onNearbyCoverError'
  },
  {
    label: '全部附近房源页',
    wxml: 'pages/nearby-listings/nearby-listings.wxml',
    wxss: 'pages/nearby-listings/nearby-listings.wxss',
    coverError: 'onCoverError'
  }
]

function read(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
  if (process.env.NEARBY_MEDIA_EMPTY_MUTANT === 'hide-empty' && relativePath.endsWith('.wxss')) {
    return `${source}\n.nearby-card .nearby-media-empty { display: none !important; width: 0 !important; }\n`
  }
  return source
}

function stripComments(source) {
  return String(source || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function attributeValue(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matched = String(tag || '').match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`))
  return matched ? matched[1] : ''
}

function hasAttribute(tag, name, valuePattern) {
  const value = attributeValue(tag, name)
  return Boolean(value && (!valuePattern || valuePattern.test(value)))
}

function elementBlock(source, startMarker, tagName) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `缺少结构起点：${startMarker}`)
  const tokenRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'g')
  tokenRe.lastIndex = start
  let depth = 0
  let token
  while ((token = tokenRe.exec(source))) {
    if (!token[0].startsWith(`</${tagName}`)) depth += 1
    else depth -= 1
    if (depth === 0) return source.slice(start, tokenRe.lastIndex)
  }
  throw new Error(`结构未闭合：${startMarker}`)
}

function findElementBlock(source, tagName, predicate, message) {
  const openingRe = new RegExp(`<${tagName}\\b[^>]*>`, 'g')
  let matched
  while ((matched = openingRe.exec(source))) {
    if (predicate(matched[0])) return elementBlock(source, matched[0], tagName)
  }
  throw new Error(message)
}

function openingTag(block, tagName) {
  const matched = String(block || '').match(new RegExp(`^\\s*<${tagName}\\b[^>]*>`))
  assert.ok(matched, `缺少 ${tagName} 开始标签`)
  return matched[0]
}

function firstImageAndRest(source) {
  const matched = String(source || '').match(/<image\b[^>]*(?:\/>|>(?:\s*<\/image>)?)/)
  assert.ok(matched, '附近卡缺少真实封面 image 分支')
  return {
    tag: matched[0].match(/^<image\b[^>]*>/)[0],
    rest: source.slice(matched.index + matched[0].length)
  }
}

function nextView(source, message) {
  const rest = String(source || '').trimStart()
  const startTag = rest.match(/^<view\b[^>]*>/)
  assert.ok(startTag, message)
  const block = elementBlock(rest, startTag[0], 'view')
  return { block, tag: openingTag(block, 'view'), rest: rest.slice(block.length) }
}

function visibleText(block) {
  return stripComments(block)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...stripComments(source).matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
  return matches.map((match) => match[1]).join(';\n')
}

function selectorMayTarget(selectorText, targetClass) {
  const target = String(targetClass || '').replace(/^\./, '')
  return String(selectorText || '').split(',').some((group) => {
    const compounds = group.trim().split(/\s+|>|\+|~/).filter(Boolean)
    if (!compounds.length) return false
    const finalClasses = [...compounds[compounds.length - 1].matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1])
    return finalClasses.includes(target)
  })
}

function assertNoHiddenOverride(source, targetClass, label) {
  for (const matched of stripComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorMayTarget(matched[1], targetClass)) continue
    for (const declaration of matched[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;}]+)/ig)) {
      const property = declaration[1].toLowerCase()
      const value = declaration[2].replace(/\s*!important\s*$/i, '').trim().toLowerCase()
      const hidden = (property === 'display' && value === 'none') ||
        (property === 'visibility' && /^(hidden|collapse)$/.test(value)) ||
        (property === 'opacity' && /^0(?:\.0+)?$/.test(value)) ||
        (/^(?:width|height|max-width|max-height)$/.test(property) && /^0(?:[a-z%]+)?$/.test(value)) ||
        (property === 'transform' && /(?:^|\s)scale(?:[xy])?\(0(?:\.0+)?\)/.test(value))
      assert.ok(!hidden, `${label}媒体空态不得被潜在匹配规则用 ${property}:${value} 隐藏或压缩`)
    }
  }
}

pages.forEach((page) => {
  const wxml = stripComments(read(page.wxml))
  const wxss = stripComments(read(page.wxss))
  const card = findElementBlock(
    wxml,
    'view',
    (tag) => hasAttribute(tag, 'class', /(?:^|\s)nearby-card(?:\s|$)/) && hasAttribute(tag, 'wx:for'),
    `${page.label}缺少附近房源循环卡片`
  )
  const image = firstImageAndRest(card)
  assert.ok(hasAttribute(image.tag, 'wx:if', /^\{\{item\.coverUrl\}\}$/), `${page.label}真实封面必须绑定 coverUrl`)
  assert.ok(hasAttribute(image.tag, 'class', /(?:^|\s)nearby-cover(?:\s|$)/), `${page.label}真实封面必须使用固定媒体尺寸`)
  assert.strictEqual(attributeValue(image.tag, 'binderror'), page.coverError, `${page.label}封面失败降级事件不得改变`)

  const pending = nextView(image.rest, `${page.label}封面后必须紧邻有视频但无封面的占位分支`)
  assert.ok(hasAttribute(pending.tag, 'wx:elif', /^\{\{item\.hasVideo\}\}$/), `${page.label}有视频但无封面分支必须绑定 hasVideo`)
  assert.ok(hasAttribute(pending.tag, 'class', /(?:^|\s)nearby-cover(?:\s|$)/), `${page.label}视频占位必须保留封面等宽媒体列`)
  assert.ok(hasAttribute(pending.tag, 'class', /(?:^|\s)nearby-media-empty(?:\s|$)/), `${page.label}视频占位必须使用附近媒体空态类`)
  assert.ok(/点开播放/.test(visibleText(pending.block)), `${page.label}有视频但无封面时必须提示点开播放，不得误报暂无视频`)

  const noVideo = nextView(pending.rest, `${page.label}有视频占位后必须紧邻确实无视频分支`)
  assert.ok(/\bwx:else\b/.test(noVideo.tag), `${page.label}确实无视频分支必须使用 wx:else`)
  assert.ok(hasAttribute(noVideo.tag, 'class', /(?:^|\s)nearby-cover(?:\s|$)/), `${page.label}无视频占位必须保留封面等宽媒体列`)
  assert.ok(hasAttribute(noVideo.tag, 'class', /(?:^|\s)nearby-media-empty(?:\s|$)/), `${page.label}无视频占位必须使用附近媒体空态类`)
  assert.ok(/暂无视频/.test(visibleText(noVideo.block)), `${page.label}确实无视频时必须显示“暂无视频”`)

  const coverRule = cssRule(wxss, '.nearby-cover')
  assert.ok(/flex\s*:\s*none\s*;/i.test(coverRule), `${page.label}媒体列必须禁止 flex 压缩`)
  assert.ok(/width\s*:\s*[1-9]\d*rpx\s*;/i.test(coverRule) && /height\s*:\s*[1-9]\d*rpx\s*;/i.test(coverRule), `${page.label}图片与占位必须共享非零固定尺寸`)
  const emptyRule = cssRule(wxss, '.nearby-media-empty')
  assert.ok(/display\s*:\s*flex\s*;/i.test(emptyRule), `${page.label}媒体空态必须使用 flex 居中布局`)
  assert.ok(/flex-direction\s*:\s*column\s*;/i.test(emptyRule), `${page.label}媒体空态图标和文案必须纵向排列`)
  assert.ok(/align-items\s*:\s*center\s*;/i.test(emptyRule) && /justify-content\s*:\s*center\s*;/i.test(emptyRule), `${page.label}媒体空态必须水平、垂直居中`)
  assert.ok(/\.nearby-media-empty-label\s*\{[^}]*font-size\s*:/i.test(wxss), `${page.label}“暂无视频”必须有明确可读字号`)
  assertNoHiddenOverride(wxss, 'nearby-media-empty', page.label)
})

console.log('listing-nearby-media-empty-state-v1-test passed')
