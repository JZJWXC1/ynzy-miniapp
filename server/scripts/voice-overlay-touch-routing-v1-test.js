const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', '..')
const pages = [
  ['首页', 'pages/index/index'],
  ['找房助手', 'pages/match-chat/match-chat']
]

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  assert(match, `缺少 ${selector} 样式规则`)
  return match[1]
}

pages.forEach(([label, base]) => {
  const wxml = read(`${base}.wxml`)
  const wxss = read(`${base}.wxss`)
  const holdButton = wxml.match(/<view\s+[\s\S]*?class="hold-to-talk[\s\S]*?<\/view>/)

  assert(holdButton, `${label}必须保留按住说话按钮`)
  assert(holdButton[0].includes('bindtouchstart="onVoiceTouchStart"'), `${label}按下事件必须由按钮接收`)
  assert(holdButton[0].includes('catchtouchmove="onVoiceTouchMove"'), `${label}滑动取消事件必须由按钮持续接收`)
  assert(holdButton[0].includes('bindtouchend="onVoiceTouchEnd"'), `${label}松手事件必须由按钮持续接收`)
  assert(holdButton[0].includes('bindtouchcancel="onVoiceTouchCancel"'), `${label}系统取消事件必须保留兜底`)

  const maskRule = ruleBody(wxss, '.voice-rec-mask')
  assert(
    /pointer-events\s*:\s*none\s*;/.test(maskRule),
    `${label}录音浮层必须 pointer-events:none，避免浮层出现后截断原按钮的按住手势`
  )
})

console.log('voice-overlay-touch-routing-v1-test passed')
