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

  assert.deepStrictEqual(failures, [], failures.join('；'))
}

run()
console.log('mini-webview-layout-guard-v1-test passed')
