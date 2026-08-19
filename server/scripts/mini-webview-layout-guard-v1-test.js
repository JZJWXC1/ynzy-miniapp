'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// 微信 WebView 页面布局回归护栏：固化几处易被全局样式或原生组件默认值破坏的关键布局规则，防止修一页
// 破坏其它页面。像素级真机回归由微信开发者工具执行；本测试锁定静态 wxss 规则，但**先剥离 CSS 注释再匹配**，
// 避免「把声明改成注释」仍假绿。

const root = path.resolve(__dirname, '../..')
let auditMutationApplied = false

function mutationResult(original, mutated, name) {
  assert.notStrictEqual(mutated, original, `布局审计变异未命中：${name}`)
  auditMutationApplied = true
  return mutated
}

// 变异模式只用于人工/审计证明：把正确声明替换成会被旧“子串正则”误放行的近似声明，
// 正常全量测试不设置该环境变量。每种变异都必须令本脚本退出非 0。
function mutateCssForAudit(css, rel) {
  const mutant = String(process.env.YNZY_TEST_LAYOUT_MUTANT || '')
  if (!mutant) return css
  if (mutant === 'video-width-as-min-width' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css.replace(/(\.video-share-actions\s+\.video-share-button\s*\{[^}]*?)\bwidth(\s*:\s*150rpx\s*!important)/, '$1min-width$2'), mutant)
  }
  if (mutant === 'page-height-as-min-height' && rel === 'pages/listings/listings.wxss') {
    return mutationResult(css, css.replace(/(^|\n)(\s*page\s*\{[^}]*?)\bheight(\s*:\s*100vh)/m, '$1$2min-height$3'), mutant)
  }
  if (mutant === 'scroll-min-height-as-custom' && rel === 'pages/listings/listings.wxss') {
    return mutationResult(css, css.replace(/(\.page-scroll\s*\{[^}]*?)\bmin-height(\s*:\s*0)/, '$1--fake-min-height$2'), mutant)
  }
  if (mutant === 'narrow-flex-as-custom' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css.replace(/(@media\s*\(max-width:\s*360px\)[\s\S]*?\.video-share-actions\s+\.video-share-button\s*\{[^}]*?)\bflex(\s*:\s*1\s+1\s+0)/, '$1--fake-flex$2'), mutant)
  }
  if (mutant === 'address-flex-as-custom' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css.replace(/(\.location-compact-item\s*\{[^}]*?)\bflex(\s*:\s*1\s+1\s+)/, '$1--fake-flex$2'), mutant)
  }
  if (mutant === 'same-block-width-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css.replace(/(\.video-share-actions\s+\.video-share-button\s*\{[^}]*?width\s*:\s*150rpx\s*!important\s*;)/, '$1\n  width: 999rpx !important;'), mutant)
  }
  if (mutant === 'later-rule-width-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n.video-share-actions .video-share-button { width: 999rpx !important; }\n', mutant)
  }
  if (mutant === 'safe-area-custom-property' && rel === 'pages/listings/listings.wxss') {
    return mutationResult(css, css.replace(/padding\s*:\s*24rpx\s+24rpx\s+calc\(150rpx\s*\+\s*env\(safe-area-inset-bottom\)\)\s*;/, 'padding: 24rpx 24rpx 150rpx; --fake-padding-bottom: env(safe-area-inset-bottom);'), mutant)
  }
  if (mutant === 'video-copy-flex-auto' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css.replace(/(\.video-share-copy\s*\{[^}]*?)\bflex\s*:\s*1\s+1\s+0/, '$1flex: 1 1 auto'), mutant)
  }
  if (mutant === 'video-actions-shrink' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n.video-share-actions { flex: 0 1 auto; }\n', mutant)
  }
  if (mutant === 'repeated-media-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n@media (max-width: 360px) { .video-share-actions .video-share-button { width: 999rpx !important; flex: 0 0 auto; } }\n', mutant)
  }
  if (mutant === 'video-actions-longhand-shrink' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n.video-share-actions { flex: 0 0 auto; flex-shrink: 1; }\n', mutant)
  }
  if (mutant === 'safe-area-horizontal-only' && rel === 'pages/listings/listings.wxss') {
    return mutationResult(css, css.replace(/padding\s*:\s*24rpx\s+24rpx\s+calc\(150rpx\s*\+\s*env\(safe-area-inset-bottom\)\)\s*;/, 'padding: 24rpx calc(24rpx + env(safe-area-inset-bottom)) 150rpx;'), mutant)
  }
  if (mutant === 'compressed-media-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n@media(max-width:360px){page .video-share-actions .video-share-button{width:999rpx!important;flex:0 0 auto}}\n', mutant)
  }
  if (mutant === 'screen-media-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n@media screen and (max-width:360px){page .video-share-actions .video-share-button{width:999rpx!important;flex:0 0 auto}}\n', mutant)
  }
  if (mutant === 'higher-specificity-width-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\npage .video-share-actions .video-share-button { width: 999rpx !important; }\n', mutant)
  }
  if (mutant === 'grouped-width-override' && rel === 'pages/listing-detail/listing-detail.wxss') {
    return mutationResult(css, css + '\n.unused-audit-selector, .video-share-actions .video-share-button { width: 999rpx !important; }\n', mutant)
  }
  if (mutant === 'higher-specificity-safe-area' && rel === 'pages/listings/listings.wxss') {
    return mutationResult(css, css + '\npage .listings-page { padding-bottom: 150rpx !important; }\n', mutant)
  }
  return css
}

// 读取并剥离 CSS 注释，杜绝注释文本被正则命中造成假绿。
function readCss(rel) {
  const css = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return mutateCssForAudit(css, rel)
}

function selectorCompounds(value) {
  return String(value || '').trim().split(/\s+|>|\+|~/).filter(Boolean)
}

function compoundContains(target, actual) {
  const targetClasses = [...String(target || '').matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1])
  const actualClasses = [...String(actual || '').matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1])
  if (targetClasses.length && !targetClasses.every((name) => actualClasses.includes(name))) return false
  const targetTag = String(target || '').match(/^[A-Za-z][A-Za-z0-9-]*/)
  if (targetTag && !new RegExp(`^${targetTag[0]}(?:[.#:\[]|$)`, 'i').test(String(actual || ''))) return false
  return targetClasses.length > 0 || Boolean(targetTag)
}

function selectorGroupTargets(group, targetSelector) {
  const target = selectorCompounds(targetSelector)
  const actual = selectorCompounds(group)
  if (!target.length || actual.length < target.length) return false
  const offset = actual.length - target.length
  return target.every((compound, index) => compoundContains(compound, actual[offset + index]))
}

function selectorSpecificity(group) {
  const text = String(group || '')
  const ids = (text.match(/#[A-Za-z0-9_-]+/g) || []).length
  const classes = (text.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:(?!:)[A-Za-z0-9_-]+/g) || []).length
  const stripped = text
    .replace(/#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[^\]]+\]|::?[A-Za-z0-9_-]+(?:\([^)]*\))?/g, ' ')
    .replace(/[*>+~(),]/g, ' ')
  const elements = (stripped.match(/\b[A-Za-z][A-Za-z0-9-]*\b/g) || []).length
  return [ids, classes, elements]
}

function compareSpecificity(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

// 收集所有可能匹配目标元素的规则（含祖先限定、复合 class、逗号 selector），再按 CSS 特异性与源码顺序排序。
function ruleBlocks(css, selector) {
  const matches = []
  let order = 0
  for (const matched of String(css || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const groups = matched[1].split(',').map((item) => item.trim()).filter(Boolean)
    const matchingGroups = groups.filter((group) => selectorGroupTargets(group, selector))
    if (!matchingGroups.length) continue
    const specificity = matchingGroups.map(selectorSpecificity).sort(compareSpecificity).pop()
    matches.push({ block: matched[2], specificity, order: order++ })
  }
  matches.sort((left, right) => compareSpecificity(left.specificity, right.specificity) || left.order - right.order)
  return matches.map((item) => item.block)
}

function ruleBlock(css, selector) {
  const blocks = ruleBlocks(css, selector)
  return blocks.length ? blocks.join(';\n') : null
}

// 提取全部同 query 的 `@media` 块并按源码顺序合并；只取首块会漏掉后置级联覆盖。
function mediaBlock(css, query) {
  const normalizedQuery = String(query || '').replace(/\s+/g, '').toLowerCase()
  const blocks = []
  const headerRe = /@media\s*([^{}]+)\{/ig
  let header
  while ((header = headerRe.exec(css))) {
    const normalizedPrelude = String(header[1] || '').replace(/\s+/g, '').toLowerCase()
    if (!normalizedPrelude.includes(`(${normalizedQuery})`)) continue
    const braceStart = headerRe.lastIndex - 1
    if (braceStart === -1) break
    let depth = 0
    let end = -1
    for (let i = braceStart; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) break
    blocks.push(css.slice(braceStart + 1, end))
    headerRe.lastIndex = end + 1
  }
  return blocks.length ? blocks.join('\n') : null
}

function withoutMediaBlocks(css) {
  let output = String(css || '')
  let cursor = 0
  while (true) {
    const idx = output.indexOf('@media', cursor)
    if (idx === -1) return output
    const braceStart = output.indexOf('{', idx)
    if (braceStart === -1) return output
    let depth = 0
    let end = -1
    for (let i = braceStart; i < output.length; i += 1) {
      if (output[i] === '{') depth += 1
      else if (output[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end === -1) return output
    output = output.slice(0, idx) + output.slice(idx, end).replace(/[^\n]/g, ' ') + output.slice(end)
    cursor = end
  }
}

function declarationValue(block, prop) {
  if (!block) return null
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...block.matchAll(new RegExp('(?:^|;)\\s*' + escaped + '\\s*:\\s*([^;}]+)', 'ig'))]
  let effective = null
  let important = false
  for (const match of matches) {
    const value = match[1].trim()
    const nextImportant = /!important\s*$/i.test(value)
    if (effective !== null && important && !nextImportant) continue
    effective = value
    important = nextImportant
  }
  return effective
}

function declarations(block) {
  if (!block) return []
  return [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;}]+)/ig)]
    .map((match) => {
      const rawValue = match[2].trim()
      return {
        property: match[1].toLowerCase(),
        value: rawValue.replace(/\s*!important\s*$/i, '').trim(),
        important: /!important\s*$/i.test(rawValue)
      }
    })
}

function splitCssTokens(value) {
  const tokens = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const char of String(value || '').trim()) {
    if (quote) {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(char) && depth === 0) {
      if (current) tokens.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current) tokens.push(current)
  return tokens
}

function paddingBottomFromShorthand(value) {
  const tokens = splitCssTokens(value)
  if (tokens.length === 1) return tokens[0]
  if (tokens.length === 2) return tokens[0]
  if (tokens.length === 3 || tokens.length === 4) return tokens[2]
  return ''
}

function assignCascaded(state, key, value, important) {
  if (state[key] && state[key].important && !important) return
  state[key] = { value, important }
}

function hasEffectiveBottomSafeArea(css, selector) {
  const state = {}
  for (const declaration of declarations(ruleBlock(css, selector))) {
    if (declaration.property === 'padding') {
      assignCascaded(state, 'bottom', paddingBottomFromShorthand(declaration.value), declaration.important)
    } else if (declaration.property === 'padding-bottom') {
      assignCascaded(state, 'bottom', declaration.value, declaration.important)
    }
  }
  return Boolean(state.bottom && /env\(safe-area-inset-bottom\)/.test(state.bottom.value))
}

function flexParts(value) {
  const text = String(value || '').trim()
  if (text === 'none') return { grow: '0', shrink: '0', basis: 'auto' }
  if (text === 'auto') return { grow: '1', shrink: '1', basis: 'auto' }
  if (text === 'initial') return { grow: '0', shrink: '1', basis: 'auto' }
  const tokens = splitCssTokens(text)
  if (tokens.length === 1 && /^\d+(?:\.\d+)?$/.test(tokens[0])) return { grow: tokens[0], shrink: '1', basis: '0%' }
  if (tokens.length === 2 && tokens.every((item) => /^\d+(?:\.\d+)?$/.test(item))) return { grow: tokens[0], shrink: tokens[1], basis: '0%' }
  if (tokens.length === 2) return { grow: tokens[0], shrink: '1', basis: tokens[1] }
  if (tokens.length >= 3) return { grow: tokens[0], shrink: tokens[1], basis: tokens.slice(2).join(' ') }
  return null
}

function effectiveFlex(block) {
  const state = {}
  for (const declaration of declarations(block)) {
    if (declaration.property === 'flex') {
      const parts = flexParts(declaration.value)
      if (!parts) continue
      assignCascaded(state, 'grow', parts.grow, declaration.important)
      assignCascaded(state, 'shrink', parts.shrink, declaration.important)
      assignCascaded(state, 'basis', parts.basis, declaration.important)
    } else if (declaration.property === 'flex-grow') {
      assignCascaded(state, 'grow', declaration.value, declaration.important)
    } else if (declaration.property === 'flex-shrink') {
      assignCascaded(state, 'shrink', declaration.value, declaration.important)
    } else if (declaration.property === 'flex-basis') {
      assignCascaded(state, 'basis', declaration.value, declaration.important)
    }
  }
  if (!state.grow || !state.shrink || !state.basis) return null
  return `${state.grow.value} ${state.shrink.value} ${state.basis.value}`
}

function flexMatches(block, expected) {
  const value = effectiveFlex(block)
  if (value === null) return false
  const re = expected instanceof RegExp ? new RegExp(expected.source, expected.flags.replace('g', '')) : new RegExp(String(expected))
  return re.test(value)
}

function declarationMatches(block, prop, expected) {
  const value = declarationValue(block, prop)
  if (value === null) return false
  const re = expected instanceof RegExp ? new RegExp(expected.source, expected.flags.replace('g', '')) : new RegExp(String(expected))
  return re.test(value)
}

function declNumber(block, prop) {
  const value = declarationValue(block, prop)
  return value !== null && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : null
}

function maxZIndex(css) {
  const nums = [...css.matchAll(/(?:^|[;{])\s*z-index\s*:\s*(\d+)/gm)].map((m) => Number(m[1]))
  return nums.length ? Math.max(...nums) : 0
}

function run() {
  const failures = []

  // ---- P2②：录音全屏浮层必须高于导航栏与自定义底栏，否则录音期间能误触被浮层盖住的导航/底栏。----
  const navChromeMax = Math.max(
    maxZIndex(readCss('components/navigation-bar/navigation-bar.wxss')),
    maxZIndex(readCss('custom-tab-bar/index.wxss'))
  )
  assert.ok(navChromeMax >= 10000, `导航/底栏基线 z-index 应 ≥ 10000，实为 ${navChromeMax}`)
  for (const page of ['pages/index/index.wxss', 'pages/match-chat/match-chat.wxss']) {
    const z = declNumber(ruleBlock(readCss(page), '.voice-rec-mask'), 'z-index')
    if (z === null) {
      failures.push(`${page} 未找到 .voice-rec-mask 的 z-index`)
    } else if (!(z > navChromeMax)) {
      failures.push(`${page} 的录音浮层 z-index=${z} 未高于导航/底栏 ${navChromeMax}，录音时会被误触`)
    }
  }

  // ---- P1：带视频详情操作区。真实根因是微信原生 wx-button 默认 width≈184px（min-width 本就为 0，查它是假绿）。----
  // ---- 操作按钮必须用强选择器 + !important 覆盖 width，文案区必须可收缩。 ----
  const detailCss = readCss('pages/listing-detail/listing-detail.wxss')
  const detailBaseCss = withoutMediaBlocks(detailCss)
  const videoBtnBlock = ruleBlock(detailBaseCss, '.video-share-actions .video-share-button')
  if (!declarationMatches(videoBtnBlock, 'width', /^150rpx\s*!important$/)) {
    failures.push('listing-detail 视频操作按钮未用强选择器+!important 覆盖 width（真实根因是原生 ~184px 固定宽度），会撑爆卡片')
  }
  const videoCopyBlock = ruleBlock(detailBaseCss, '.video-share-copy')
  if (!declarationMatches(videoCopyBlock, 'min-width', /^0$/) || !flexMatches(videoCopyBlock, /^1\s+1\s+0$/)) {
    failures.push('listing-detail 视频文案区必须使用 min-width:0 + flex:1 1 0，只占按钮之外的剩余宽度')
  }
  const videoActionsBlock = ruleBlock(detailBaseCss, '.video-share-actions')
  if (!flexMatches(videoActionsBlock, /^0\s+0\s+auto$/)) {
    failures.push('listing-detail 视频操作区必须 flex:0 0 auto，容器不得先缩小再让两个固定宽度按钮溢出')
  }
  // 锁死 ≤360px 窄屏兜底：极窄屏两按钮必须能拉伸平分（width:auto!important + flex:1 1 0），否则窄屏仍溢出。
  const narrowMedia = mediaBlock(detailCss, 'max-width: 360px')
  const narrowVideoBtnBlock = ruleBlock(narrowMedia, '.video-share-actions .video-share-button')
  if (!declarationMatches(narrowVideoBtnBlock, 'width', /^auto\s*!important$/) || !flexMatches(narrowVideoBtnBlock, /^1\s+1\s+0$/)) {
    failures.push('listing-detail 缺少 ≤360px 窄屏视频按钮兜底（width:auto!important + flex:1 1 0），极窄屏会溢出')
  }

  // ---- P2①：FAQ 问题按钮同根被微信原生宽度压窄，必须强选择器强制全宽 + 重置最小宽度。----
  const faqCss = readCss('pages/faq/faq.wxss')
  const faqQuestionBlock = ruleBlock(withoutMediaBlocks(faqCss), '.faq-item .faq-question')
  if (!declarationMatches(faqQuestionBlock, 'width', /^100%\s*!important$/) || !declarationMatches(faqQuestionBlock, 'min-width', /^0\s*!important$/)) {
    failures.push('faq 问题按钮缺少强选择器 width:100%/min-width:0 覆盖，会被微信原生按钮宽度压窄、正文被挤')
  }

  // ---- P3：详情地址列不再用固定三列 grid（4/7 项会留 3+1/3+3+1 孤项），改 flex-wrap 使末行不足项拉伸。----
  const addrGridBlock = ruleBlock(detailBaseCss, '.location-compact-grid')
  if (!declarationMatches(addrGridBlock, 'display', /^flex$/) || !declarationMatches(addrGridBlock, 'flex-wrap', /^wrap$/)) {
    failures.push('详情地址列仍用固定三列 grid，4/7 项会留 3+1/3+3+1 孤项；应改 flex-wrap 使末行不足项拉伸填满')
  }
  // 锁死地址子项：必须有 flex-grow + flex-basis（三列基准且末行孤项拉伸），仅容器 flex-wrap 不足以让孤项填满。
  const addrItemBlock = ruleBlock(detailBaseCss, '.location-compact-item')
  if (!flexMatches(addrItemBlock, /^1\s+1\s+.+$/)) {
    failures.push('详情地址子项 .location-compact-item 缺少 flex:1 1 <basis>，末行孤项无法拉伸填满整行')
  }

  // ---- P3：视口根因页（导航栏在 scroll-view 外）。page 必须纵向 flex，滚动区 flex:1 占剩余高度，----
  // ---- 且滚动区不得再写死 100vh/calc(100vh...)，否则「导航栏 + 100vh」叠成超高。----
  for (const file of ['pages/listings/listings.wxss', 'pages/favorites/favorites.wxss', 'pages/nearby-listings/nearby-listings.wxss']) {
    const css = readCss(file)
    const baseCss = withoutMediaBlocks(css)
    const pageBlock = ruleBlock(baseCss, 'page')
    const scrollBlock = ruleBlock(baseCss, '.page-scroll')
    if (!declarationMatches(pageBlock, 'display', /^flex$/) || !declarationMatches(pageBlock, 'flex-direction', /^column$/)) {
      failures.push(file + ' 的 page 未设纵向 flex，导航栏在 scroll-view 外时无法让滚动区占剩余高度')
    }
    if (!declarationMatches(pageBlock, 'height', /^100vh$/)) {
      failures.push(file + ' 的 page 未设 height:100vh，纵向 flex 无参照高度、滚动区无法确定剩余高度')
    }
    if (!flexMatches(scrollBlock, /^1(?:\s|$)/)) {
      failures.push(file + ' 的 .page-scroll 未用 flex:1 占剩余高度')
    }
    if (!declarationMatches(scrollBlock, 'min-height', /^0$/)) {
      failures.push(file + ' 的 .page-scroll 缺 min-height:0，flex 子项默认不收缩、内部滚动会失效')
    }
    if (scrollBlock && /100vh/.test(scrollBlock)) {
      failures.push(file + ' 的 .page-scroll 仍写死 100vh/calc(100vh...)，会与外部导航栏叠加成超高')
    }
  }

  // ---- P3：固定视口列表页内容底部内边距必须叠加 env(safe-area-inset-bottom)，避免全面屏末条被遮挡。----
  const safeAreaShells = [
    { file: 'pages/listings/listings.wxss', sel: '.listings-page' },
    { file: 'pages/favorites/favorites.wxss', sel: '.page-shell' },
    { file: 'pages/my-listings/my-listings.wxss', sel: '.my-listings-page' },
    { file: 'pages/nearby-listings/nearby-listings.wxss', sel: '.nearby-page' }
  ]
  for (const item of safeAreaShells) {
    if (!hasEffectiveBottomSafeArea(withoutMediaBlocks(readCss(item.file)), item.sel)) {
      failures.push(item.file + ' 的 ' + item.sel + ' 底部内边距未叠加 env(safe-area-inset-bottom)，全面屏末条会被遮挡')
    }
  }

  if (String(process.env.YNZY_TEST_LAYOUT_MUTANT || '')) {
    assert.ok(auditMutationApplied, `指定的布局审计变异未应用：${process.env.YNZY_TEST_LAYOUT_MUTANT}`)
  }
  assert.deepStrictEqual(failures, [], failures.join('；'))
}

run()
console.log('mini-webview-layout-guard-v1-test passed')
