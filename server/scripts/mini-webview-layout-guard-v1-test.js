'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// 微信 WebView 页面布局回归护栏：固化几处易被全局样式或原生组件默认值破坏的关键布局规则，
// 防止修一页样式时回退其它页面。像素级真机回归由微信开发者工具执行，本测试锁定静态 wxss/wxml 规则。

const root = path.resolve(__dirname, '../..')

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

// 提取 `selector { ... }` 规则块（到与之配对的第一个 `}`）。
function ruleBlock(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc + '\\s*\\{([^}]*)\\}', 'm')
  const m = css.match(re)
  return m ? m[1] : null
}

function declNumber(block, prop) {
  if (!block) return null
  const m = block.match(new RegExp(prop + ':\\s*(-?\\d+(?:\\.\\d+)?)'))
  return m ? Number(m[1]) : null
}

// 文件内所有 z-index 的最大值，用于近似「页面 chrome（导航/底栏）」的最高层级基线。
function maxZIndex(css) {
  const nums = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]))
  return nums.length ? Math.max(...nums) : 0
}

function run() {
  const failures = []

  // ---- P2②：录音全屏浮层必须高于导航栏与自定义底栏，否则录音期间能误触被浮层盖住的导航/底栏。----
  const navChromeMax = Math.max(
    maxZIndex(readText('components/navigation-bar/navigation-bar.wxss')),
    maxZIndex(readText('custom-tab-bar/index.wxss'))
  )
  assert.ok(navChromeMax >= 10000, `导航/底栏基线 z-index 应 ≥ 10000，实为 ${navChromeMax}`)
  for (const page of ['pages/index/index.wxss', 'pages/match-chat/match-chat.wxss']) {
    const z = declNumber(ruleBlock(readText(page), '.voice-rec-mask'), 'z-index')
    if (z === null) {
      failures.push(`${page} 未找到 .voice-rec-mask 的 z-index`)
    } else if (!(z > navChromeMax)) {
      failures.push(`${page} 的录音浮层 z-index=${z} 未高于导航/底栏 ${navChromeMax}，录音时会被误触`)
    }
  }

  // ---- P1：带视频详情操作区。微信 WebView 原生 wx-button 默认最小宽度会把两按钮撑到 ~184px，----
  // ---- 撑爆卡片并把文案区挤成 0。操作按钮必须重置最小宽度，文案区必须可收缩。 ----
  const detailWxss = readText('pages/listing-detail/listing-detail.wxss')
  const videoBtnBlock = ruleBlock(detailWxss, '.video-share-actions .video-share-button')
  if (!videoBtnBlock || !/min-width:\s*0/.test(videoBtnBlock)) {
    failures.push('listing-detail 视频操作按钮缺少 min-width:0 覆盖，会被微信原生按钮默认宽度撑爆卡片')
  }
  const videoCopyBlock = ruleBlock(detailWxss, '.video-share-copy')
  if (!videoCopyBlock || !/min-width:\s*0/.test(videoCopyBlock)) {
    failures.push('listing-detail 视频文案区缺少 min-width:0，无法在窄卡片内收缩')
  }

  // ---- P2①：FAQ 问题按钮同根被微信原生宽度压窄，必须强选择器强制全宽 + 重置最小宽度。----
  const faqWxss = readText('pages/faq/faq.wxss')
  const faqQuestionBlock = ruleBlock(faqWxss, '.faq-item .faq-question')
  if (!faqQuestionBlock || !/width:\s*100%/.test(faqQuestionBlock) || !/min-width:\s*0/.test(faqQuestionBlock)) {
    failures.push('faq 问题按钮缺少强选择器 width:100%/min-width:0 覆盖，会被微信原生按钮宽度压窄、正文被挤')
  }

  assert.deepStrictEqual(failures, [], failures.join('；'))
}

run()
console.log('mini-webview-layout-guard-v1-test passed')
