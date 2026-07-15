'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// 微信 WebView 页面布局回归护栏：固化几处易被全局样式或原生组件默认值破坏的关键布局规则，防止修一页
// 破坏其它页面。像素级真机回归由微信开发者工具执行；本测试锁定静态 wxss 规则，但**先剥离 CSS 注释再匹配**，
// 避免「把声明改成注释」仍假绿。

const root = path.resolve(__dirname, '../..')

// 读取并剥离 CSS 注释，杜绝注释文本被正则命中造成假绿。
function readCss(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

// 提取 `selector { ... }` 规则块。选择器必须出现在规则边界（行首或上一规则 } 之后），
// 避免元素选择器 `page` 命中 `.listings-page` 这类子串。
function ruleBlock(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(?:^|[}\\n])\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm')
  const m = css.match(re)
  return m ? m[1] : null
}

function declNumber(block, prop) {
  if (!block) return null
  const m = block.match(new RegExp(prop + ':\\s*(-?\\d+(?:\\.\\d+)?)'))
  return m ? Number(m[1]) : null
}

function maxZIndex(css) {
  const nums = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]))
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
  const videoBtnBlock = ruleBlock(detailCss, '.video-share-actions .video-share-button')
  if (!videoBtnBlock || !/width:\s*150rpx\s*!important/.test(videoBtnBlock)) {
    failures.push('listing-detail 视频操作按钮未用强选择器+!important 覆盖 width（真实根因是原生 ~184px 固定宽度），会撑爆卡片')
  }
  const videoCopyBlock = ruleBlock(detailCss, '.video-share-copy')
  if (!videoCopyBlock || !/min-width:\s*0/.test(videoCopyBlock)) {
    failures.push('listing-detail 视频文案区缺少 min-width:0，无法在窄卡片内收缩')
  }

  // ---- P2①：FAQ 问题按钮同根被微信原生宽度压窄，必须强选择器强制全宽 + 重置最小宽度。----
  const faqCss = readCss('pages/faq/faq.wxss')
  const faqQuestionBlock = ruleBlock(faqCss, '.faq-item .faq-question')
  if (!faqQuestionBlock || !/width:\s*100%/.test(faqQuestionBlock) || !/min-width:\s*0/.test(faqQuestionBlock)) {
    failures.push('faq 问题按钮缺少强选择器 width:100%/min-width:0 覆盖，会被微信原生按钮宽度压窄、正文被挤')
  }

  // ---- P3：详情地址列不再用固定三列 grid（4/7 项会留 3+1/3+3+1 孤项），改 flex-wrap 使末行不足项拉伸。----
  const addrGridBlock = ruleBlock(detailCss, '.location-compact-grid')
  if (!addrGridBlock || !/display:\s*flex/.test(addrGridBlock) || !/flex-wrap:\s*wrap/.test(addrGridBlock)) {
    failures.push('详情地址列仍用固定三列 grid，4/7 项会留 3+1/3+3+1 孤项；应改 flex-wrap 使末行不足项拉伸填满')
  }

  // ---- P3：视口根因页（导航栏在 scroll-view 外）。page 必须纵向 flex，滚动区 flex:1 占剩余高度，----
  // ---- 且滚动区不得再写死 100vh/calc(100vh...)，否则「导航栏 + 100vh」叠成超高。----
  for (const file of ['pages/listings/listings.wxss', 'pages/favorites/favorites.wxss', 'pages/nearby-listings/nearby-listings.wxss']) {
    const css = readCss(file)
    const pageBlock = ruleBlock(css, 'page')
    const scrollBlock = ruleBlock(css, '.page-scroll')
    if (!pageBlock || !/display:\s*flex/.test(pageBlock) || !/flex-direction:\s*column/.test(pageBlock)) {
      failures.push(file + ' 的 page 未设纵向 flex，导航栏在 scroll-view 外时无法让滚动区占剩余高度')
    }
    if (!scrollBlock || !/flex:\s*1/.test(scrollBlock)) {
      failures.push(file + ' 的 .page-scroll 未用 flex:1 占剩余高度')
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
    const block = ruleBlock(readCss(item.file), item.sel)
    if (!block || !/env\(safe-area-inset-bottom\)/.test(block)) {
      failures.push(item.file + ' 的 ' + item.sel + ' 底部内边距未叠加 env(safe-area-inset-bottom)，全面屏末条会被遮挡')
    }
  }

  assert.deepStrictEqual(failures, [], failures.join('；'))
}

run()
console.log('mini-webview-layout-guard-v1-test passed')
