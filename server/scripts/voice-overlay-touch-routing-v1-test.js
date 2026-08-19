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

function mutateCssForAudit(source) {
  const mutant = process.env.VOICE_OVERLAY_TOUCH_MUTANT
  if (mutant === 'comment-pointer-events') {
    return source.replace(
      /(\.voice-rec-mask\s*\{[^}]*?)pointer-events\s*:\s*none\s*;/,
      '$1/* pointer-events: none; */'
    )
  }
  if (mutant === 'late-auto-override') {
    return `${source}\n.voice-rec-mask { pointer-events: auto; }\n`
  }
  return source
}

function rulesTargetingClass(source, className) {
  const css = mutateCssForAudit(source).replace(/\/\*[\s\S]*?\*\//g, '')
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const classToken = new RegExp(`\\.${escapedClass}(?![A-Za-z0-9_-])`)
  const rules = []

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const targetsClass = match[1]
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean)
      .some((selector) => {
        const compounds = selector.split(/\s+|>|\+|~/).filter(Boolean)
        const targetCompound = compounds[compounds.length - 1] || ''
        return classToken.test(targetCompound)
      })
    if (targetsClass) rules.push(match[2])
  }

  return rules
}

function assertPointerEventsNone(source, label) {
  const rules = rulesTargetingClass(source, 'voice-rec-mask')
  assert(rules.length > 0, `${label}缺少 .voice-rec-mask 样式规则`)

  const values = rules.flatMap((rule) => (
    [...rule.matchAll(/(?:^|;)\s*pointer-events\s*:\s*([^;}]+)/ig)]
      .map((match) => match[1].trim())
  ))
  assert(values.length > 0, `${label}录音浮层缺少 pointer-events 声明`)
  values.forEach((value) => {
    assert(
      /^none(?:\s*!important)?$/i.test(value),
      `${label}录音浮层存在 pointer-events:${value}，会覆盖 none 并截断原按钮的按住手势`
    )
  })
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

  assertPointerEventsNone(wxss, label)
})

console.log('voice-overlay-touch-routing-v1-test passed')
