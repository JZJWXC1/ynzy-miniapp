'use strict'

// 无视频公司房源允许继续公开，但列表和详情必须给出真实、可理解的空态；有视频分支仍须保留
// 播放、保存与转发能力。此测试只锁页面契约，不允许用占位图或假视频冒充真实媒体。

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../..')
let mutationApplied = false

function read(rel) {
  let source = fs.readFileSync(path.join(root, rel), 'utf8')
  const mutant = String(process.env.YNZY_TEST_MEDIA_EMPTY_MUTANT || '')
  if (mutant === 'hide-list-empty' && rel === 'pages/listings/listings.wxss') {
    mutationApplied = true
    return source + '\n.media-empty-state { display: none; }\n'
  }
  if (mutant === 'hide-detail-empty' && rel === 'pages/listing-detail/listing-detail.wxss') {
    mutationApplied = true
    return source + '\n.video-empty-card { display: none; min-height: 0; }\n'
  }
  if (mutant === 'hide-list-empty-specific' && rel === 'pages/listings/listings.wxss') {
    mutationApplied = true
    return source + '\n.listing-media .media-empty-state { display: none !important; }\n'
  }
  if (mutant === 'hide-detail-empty-specific' && rel === 'pages/listing-detail/listing-detail.wxss') {
    mutationApplied = true
    return source + '\n.video-card.video-empty-card { display: none !important; min-height: 0 !important; }\n'
  }
  if (mutant === 'collapse-list-empty-specific' && rel === 'pages/listings/listings.wxss') {
    mutationApplied = true
    return source + '\npage .media-empty-state { height: 0 !important; max-height: 0 !important; overflow: hidden !important; padding: 0 !important; }\n'
  }
  if (mutant === 'collapse-detail-empty-specific' && rel === 'pages/listing-detail/listing-detail.wxss') {
    mutationApplied = true
    return source + '\npage .video-empty-card { transform: scale(0) !important; }\n'
  }
  if (mutant === 'hide-detail-shared-class' && rel === 'pages/listing-detail/listing-detail.wxss') {
    mutationApplied = true
    return source + '\n.video-card { display: none !important; }\n'
  }
  const videoPromptMutants = {
    'mislabel-video-pending-empty': '暂无视频',
    'mislabel-video-pending-missing': '视频待补',
    'mislabel-video-pending-generic': '视频',
    'mislabel-video-pending-loading': '视频加载中',
    'mislabel-video-pending-cannot': '不能播放',
    'mislabel-video-pending-unavailable': '无可用视频',
    'mislabel-video-pending-failed': '播放失败',
    'mislabel-video-pending-temporary': '暂不可用',
    'mislabel-video-pending-action-negative': '点击查看当前无可用视频'
  }
  if (videoPromptMutants[mutant] && rel === 'pages/listings/listings.wxml') {
    const mutated = source.replace('点开播放', videoPromptMutants[mutant])
    if (mutated !== source) mutationApplied = true
    return mutated
  }
  const equivalent = String(process.env.YNZY_TEST_MEDIA_EQUIVALENT || '')
  if (equivalent === 'extra-data-attributes' && rel === 'pages/listings/listings.wxml') {
    mutationApplied = true
    source = source.replace('<view class="listing-media">', '<view data-audit-safe="1" class="listing-media">')
  } else if (equivalent === 'extra-data-attributes' && rel === 'pages/listing-detail/listing-detail.wxml') {
    mutationApplied = true
    source = source.replace('<block wx:elif="{{listing.id}}">', '<block data-audit-safe="1" wx:elif="{{listing.id}}">')
  } else if (equivalent === 'single-quote-actions' && rel === 'pages/listing-detail/listing-detail.wxml') {
    mutationApplied = true
    source = source
      .replace('bindtap="saveListingVideo"', "bindtap='saveListingVideo'")
      .replace('bindtap="prepareVideoShare"', "bindtap='prepareVideoShare'")
  }
  return source
}

function stripComments(source) {
  return String(source || '')
    .replace(/<!--?[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function assertOrdered(source, markers, message) {
  let cursor = -1
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1)
    assert.ok(next > cursor, `${message}：缺少或顺序错误 ${marker}`)
    cursor = next
  }
}

function elementBlock(source, startMarker, tagName) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `缺少结构起点：${startMarker}`)
  const tag = String(tagName || 'view').replace(/[^a-z-]/gi, '')
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'g')
  tokenRe.lastIndex = start
  let depth = 0
  let token
  while ((token = tokenRe.exec(source))) {
    if (!token[0].startsWith(`</${tag}`)) depth += 1
    else depth -= 1
    if (depth === 0) return source.slice(start, tokenRe.lastIndex)
  }
  throw new Error(`结构未闭合：${startMarker}`)
}

function findElementBlock(source, tagName, predicate, message) {
  const openingRe = new RegExp(`<${tagName}\\b[^>]*>`, 'g')
  let matched
  while ((matched = openingRe.exec(String(source || '')))) {
    if (!predicate(matched[0])) continue
    return elementBlock(source, matched[0], tagName)
  }
  throw new Error(message || `未找到 ${tagName} 目标节点`)
}

function openingTag(block, tagName) {
  const matched = String(block || '').match(new RegExp(`^\\s*<${tagName}\\b[^>]*>`))
  assert.ok(matched, `缺少 ${tagName} 开始标签`)
  return matched[0]
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

function firstImageAndRest(source) {
  const matched = String(source || '').match(/<image\b[^>]*(?:\/>|>(?:\s*<\/image>)?)/)
  assert.ok(matched, '列表媒体区缺少真实封面 image 分支')
  return { tag: matched[0].match(/^<image\b[^>]*>/)[0], rest: source.slice(matched.index + matched[0].length) }
}

function cssRuleBlocks(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?:^|[}\\n])\\s*' + escaped + '\\s*\\{([^}]*)\\}', 'gm')
  return [...String(css || '').matchAll(re)].map((match) => match[1])
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

function potentialRuleBlocks(css, targetClass) {
  const blocks = []
  for (const matched of String(css || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorMayTarget(matched[1], targetClass)) blocks.push(matched[2])
  }
  return blocks
}

function assertNoHiddenOverride(css, targetClass, message, options = {}) {
  for (const block of potentialRuleBlocks(css, targetClass)) {
    const declarations = [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;}]+)/ig)]
    for (const matched of declarations) {
      const property = matched[1].toLowerCase()
      const value = matched[2].replace(/\s*!important\s*$/i, '').trim().toLowerCase()
      const hidden = (property === 'display' && value === 'none') ||
        (property === 'visibility' && /^(hidden|collapse)$/.test(value)) ||
        (property === 'opacity' && /^0(?:\.0+)?$/.test(value)) ||
        (/^(?:height|max-height|width|max-width)$/.test(property) && /^0(?:[a-z%]+)?$/.test(value)) ||
        (property === 'transform' && /(?:^|\s)scale(?:[xy])?\(0(?:\.0+)?\)/.test(value)) ||
        (property === 'clip-path' && /^inset\(100%(?:\s+100%){0,3}\)$/.test(value)) ||
        (options.rejectZeroMinHeight && property === 'min-height' && /^0(?:[a-z%]+)?$/.test(value))
      if (hidden) assert.fail(`${message}：潜在匹配选择器不得用 ${property}:${value} 隐藏空态`)
    }
  }
}

function cssValue(css, selector, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = cssRuleBlocks(css, selector)
  let effective = null
  let important = false
  for (const block of blocks) {
    for (const match of block.matchAll(new RegExp('(?:^|;)\\s*' + escaped + '\\s*:\\s*([^;}]+)', 'ig'))) {
      const value = match[1].trim()
      const nextImportant = /!important\s*$/i.test(value)
      if (effective !== null && important && !nextImportant) continue
      effective = value.replace(/\s*!important\s*$/i, '').trim()
      important = nextImportant
    }
  }
  return effective
}

function assertVisibleCss(css, selector, message) {
  assert.notStrictEqual(cssValue(css, selector, 'display'), 'none', `${message}：最终 display 不得为 none`)
  assert.ok(!/^(hidden|collapse)$/i.test(cssValue(css, selector, 'visibility') || ''), `${message}：最终 visibility 不得隐藏`)
  assert.ok(!/^0(?:\.0+)?$/.test(cssValue(css, selector, 'opacity') || ''), `${message}：最终 opacity 不得为 0`)
}

function visibleText(block) {
  return stripComments(block)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function assertVideoAvailablePrompt(block) {
  const text = visibleText(block)
  assert.ok(/点开|点击|播放|查看|预览|观看|打开/.test(text), '有视频但无封面分支必须提供播放或查看动作提示，不能只写“视频”')
  assert.ok(
    !/暂无|无视频|没有视频|无可用|缺失|待补|未上传|不存在|暂不可用|不可用|不(?:能|可|支持)?播放|禁止播放|未能播放|播放(?:失败|不可用)|加载失败|无法播放/.test(text),
    '有视频分支不得使用无视频、待补、不可用或播放失败语义'
  )
}

function run() {
  const listWxml = stripComments(read('pages/listings/listings.wxml'))
  const listWxss = stripComments(read('pages/listings/listings.wxss'))
  const detailWxml = stripComments(read('pages/listing-detail/listing-detail.wxml'))
  const detailWxss = stripComments(read('pages/listing-detail/listing-detail.wxss'))

  assert.ok(!listWxml.includes('实名查看留痕 · 视频房源'), '列表摘要不得把所有公开库存误写成“视频房源”')
  assert.ok(/合作.*敏感.*留痕/.test(listWxml) && /有视频.*(?:预览|播放)/.test(listWxml), '列表摘要应准确说明合作敏感信息与公开视频规则')

  const listingMedia = findElementBlock(
    listWxml,
    'view',
    (tag) => hasAttribute(tag, 'class', /(?:^|\s)listing-media(?:\s|$)/),
    '列表缺少 listing-media 容器'
  )
  const imageBranch = firstImageAndRest(listingMedia)
  assert.ok(hasAttribute(imageBranch.tag, 'wx:if', /^\{\{item\.coverUrl\}\}$/), '真实封面分支必须绑定 coverUrl')
  assert.ok(hasAttribute(imageBranch.tag, 'binderror', /^onCoverError$/), '真实封面加载失败必须进入受控降级')
  const afterImage = imageBranch.rest.trimStart()
  const videoPendingBranch = elementBlock(afterImage, afterImage.match(/^<view\b[^>]*>/)[0], 'view')
  const videoPendingTag = openingTag(videoPendingBranch, 'view')
  assert.ok(hasAttribute(videoPendingTag, 'wx:elif', /^\{\{item\.hasVideo\}\}$/), '有视频但无封面分支必须紧邻封面并绑定 hasVideo')
  assert.ok(hasAttribute(videoPendingTag, 'class', /(?:^|\s)media-empty-state(?:\s|$)/), '有视频但无封面分支必须使用可见空态容器')
  assertVideoAvailablePrompt(videoPendingBranch)
  for (const badPrompt of ['暂无视频', '视频待补', '视频', '视频加载中', '没有视频', '不可播放', '不能播放', '禁止播放', '未能播放', '播放失败', '无可用视频', '暂不可用', '点击查看当前无可用视频']) {
    assert.throws(() => assertVideoAvailablePrompt(`<view>${badPrompt}</view>`), undefined, `错误提示“${badPrompt}”必须被语义门拒绝`)
  }
  for (const goodPrompt of ['点开播放', '播放视频', '点击查看视频', '预览房源视频', '观看视频', '打开视频']) {
    assert.doesNotThrow(() => assertVideoAvailablePrompt(`<view>${goodPrompt}</view>`), `等价可用提示“${goodPrompt}”不应被误杀`)
  }
  const afterPending = afterImage.slice(videoPendingBranch.length).trimStart()
  const noVideoBranch = elementBlock(afterPending, afterPending.match(/^<view\b[^>]*>/)[0], 'view')
  const noVideoTag = openingTag(noVideoBranch, 'view')
  assert.ok(/\bwx:else\b/.test(noVideoTag), '确实无视频分支必须紧邻 hasVideo 分支并使用 wx:else')
  assert.ok(/暂无.*视频|无视频|视频待补/.test(noVideoBranch), '确实无视频分支必须给出明确空态')
  assert.ok(!listingMedia.includes('加载中'), '封面 binderror 后不会自动重试，稳定空态不得永久显示“加载中”')
  const videoBadge = listingMedia.match(/<view\b[^>]*class=["'][^"']*\bvideo-badge\b[^"']*["'][^>]*>/)
  assert.ok(videoBadge && hasAttribute(videoBadge[0], 'wx:if', /^\{\{item\.hasVideo\}\}$/), '有视频标签必须继续绑定可信 hasVideo')
  assert.strictEqual(cssValue(listWxss, '.media-empty-state', 'display'), 'flex', '列表空态最终有效布局必须为 flex')
  assertVisibleCss(listWxss, '.media-empty-state', '列表空态必须真实可见')
  assertNoHiddenOverride(listWxss, 'media-empty-state', '列表空态必须在所有可能匹配的规则中保持可见')
  assert.ok(/\.media-empty-label\s*\{[^}]*font-size\s*:/i.test(listWxss), '列表“暂无视频”文案必须有明确可读样式')

  const activeDetail = findElementBlock(
    detailWxml,
    'block',
    (tag) => hasAttribute(tag, 'wx:elif', /^\{\{listing\.id\}\}$/),
    '详情缺少 listing.id 有效内容分支'
  )
  const videoBranch = findElementBlock(
    activeDetail,
    'block',
    (tag) => hasAttribute(tag, 'wx:if', /^\{\{listing\.videoUrl\}\}$/),
    '详情缺少 listing.videoUrl 真实视频分支'
  )
  const videoBranchEnd = activeDetail.indexOf(videoBranch) + videoBranch.length
  const afterVideo = activeDetail.slice(videoBranchEnd)
  const emptyOpening = afterVideo.match(/^\s*(<block\b[^>]*>)/)
  assert.ok(emptyOpening && /\bwx:else\b/.test(emptyOpening[1]), '详情无视频 block 必须是视频 block 的相邻 wx:else 兄弟')
  const emptyBranch = elementBlock(afterVideo, emptyOpening[1], 'block')
  const emptyCardOpening = emptyBranch.match(/<view\b[^>]*>/)
  assert.ok(emptyCardOpening, '详情无视频分支必须包含可见空态卡片')
  const emptyCardClasses = attributeValue(emptyCardOpening[0], 'class').split(/\s+/).filter(Boolean)
  assert.ok(emptyCardClasses.includes('video-card') && emptyCardClasses.includes('video-empty-card'), '详情无视频卡片必须同时保留共享卡片与空态 class')
  assert.ok(videoBranch.includes('<video'), '真实视频分支必须继续渲染 video 组件')
  const videoButtons = [...videoBranch.matchAll(/<button\b[^>]*>/g)].map((match) => match[0])
  assert.ok(videoButtons.some((tag) => hasAttribute(tag, 'bindtap', /^saveListingVideo$/)) && videoButtons.some((tag) => hasAttribute(tag, 'bindtap', /^prepareVideoShare$/)), '真实视频分支必须继续保留保存和转发能力')
  assert.ok(/暂无.*视频|无视频|视频待补/.test(emptyBranch), '无视频详情必须明确说明当前没有房源视频')
  assert.ok(/class=["'][^"']*\bvideo-sub\b/.test(emptyBranch), '无视频详情必须提供解释性说明，不能只留空白卡片')
  assert.ok(!/<video\b/.test(emptyBranch), '无视频分支不得伪造 video 组件')
  assert.ok(!/<button\b/.test(emptyBranch), '无视频分支不得展示不可用的保存或转发按钮')
  const detailEmptyMinHeight = cssValue(detailWxss, '.video-empty-card', 'min-height')
  assert.ok(/^\d+(?:\.\d+)?rpx$/i.test(detailEmptyMinHeight || '') && Number.parseFloat(detailEmptyMinHeight) > 0, '详情无视频卡片最终有效 min-height 必须大于 0，避免内容突然塌陷')
  assertVisibleCss(detailWxss, '.video-empty-card', '详情无视频卡片必须真实可见')
  for (const className of emptyCardClasses) {
    assertNoHiddenOverride(
      detailWxss,
      className,
      `详情无视频卡片的 .${className} 必须在所有可能匹配的规则中保持可见`,
      { rejectZeroMinHeight: className === 'video-empty-card' }
    )
  }
  assert.ok(/\.video-empty-icon\s*\{[^}]*border-radius\s*:/i.test(detailWxss), '详情空态应有明确但不冒充播放按钮的视觉标识')

  if (String(process.env.YNZY_TEST_MEDIA_EMPTY_MUTANT || '') || String(process.env.YNZY_TEST_MEDIA_EQUIVALENT || '')) {
    assert.ok(mutationApplied, `指定的媒体空态审计变异未应用：${process.env.YNZY_TEST_MEDIA_EMPTY_MUTANT || process.env.YNZY_TEST_MEDIA_EQUIVALENT}`)
  }
}

run()
console.log('mini-media-empty-state-v1-test passed')
