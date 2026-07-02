const assert = require('assert')
const { normalizeAsrText } = require('../src/asr-normalizer')

function assertIncludes(text, expected) {
  assert(text.indexOf(expected) !== -1, `期望「${text}」包含「${expected}」`)
}

const similarCommunities = ['杨乐府', '杨家府']

assertIncludes(
  normalizeAsrText('客户想住杨乐府，三千左右', { vocabulary: similarCommunities }),
  '杨乐府'
)

assertIncludes(
  normalizeAsrText('客户想住杨家府，三千左右', { vocabulary: similarCommunities }),
  '杨家府'
)

assertIncludes(
  normalizeAsrText('客户想住杨了府，三千左右', { vocabulary: similarCommunities }),
  '杨了府'
)

assertIncludes(
  normalizeAsrText('客户想住春播南院，四千以内', { vocabulary: ['春波南苑'] }),
  '春波南苑'
)

assertIncludes(
  normalizeAsrText('拱墅万达附近2000左右整租单间', { vocabulary: ['拱墅万达', '整租', '合租', '单间', '合租单间'] }),
  '整租单间'
)

console.log('asr-normalizer-test passed')
