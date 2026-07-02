const assert = require('assert')
const asrRealtime = require('../src/asr-realtime')

function main() {
  const oldEnv = {
    ASR_API_KEY: process.env.ASR_API_KEY,
    ASR_REALTIME_MODEL: process.env.ASR_REALTIME_MODEL,
    ASR_REALTIME_URL: process.env.ASR_REALTIME_URL
  }

  try {
    process.env.ASR_API_KEY = 'test-asr-key'
    delete process.env.ASR_REALTIME_MODEL
    delete process.env.ASR_REALTIME_URL

    const db = {
      listings: [
        { community: '春波南苑', area: '滨江', block: '西兴' },
        { community: '杨乐府', area: '拱墅', block: '祥符' }
      ]
    }
    const config = asrRealtime.resolveRealtimeConfig(db)
    const url = asrRealtime._internal.realtimeUrl(config)
    assert.ok(url.startsWith('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'), '实时 ASR 必须走百炼 WebSocket')
    assert.ok(url.includes('model=qwen3-asr-flash-realtime'), '实时 ASR 默认模型必须正确')

    const sessionUpdate = asrRealtime._internal.buildSessionUpdate(db)
    assert.strictEqual(sessionUpdate.type, 'session.update')
    assert.strictEqual(sessionUpdate.session.input_audio_format, 'pcm')
    assert.strictEqual(sessionUpdate.session.sample_rate, 16000)
    assert.ok(sessionUpdate.session.input_audio_transcription.corpus.text.includes('春波南苑'), '热词上下文应包含房源小区')
    assert.ok(sessionUpdate.session.input_audio_transcription.corpus.text.includes('杨乐府'), '热词上下文应包含相近小区')

    const appendEvent = asrRealtime._internal.buildAudioAppendEvent(Buffer.from('abc'))
    assert.strictEqual(appendEvent.type, 'input_audio_buffer.append')
    assert.strictEqual(appendEvent.audio, Buffer.from('abc').toString('base64'))

    const partial = asrRealtime._internal.captionFromEvent({
      type: 'conversation.item.input_audio_transcription.text',
      text: '拱墅万达附近',
      stash: '两千单间'
    })
    assert.strictEqual(partial.type, 'caption')
    assert.strictEqual(partial.final, false)
    assert.strictEqual(partial.transcript, '拱墅万达附近两千单间')

    const completed = asrRealtime._internal.captionFromEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '客户手机号13812345678，找新天地三公里整租两室'
    })
    assert.strictEqual(completed.final, true)
    assert.ok(completed.transcript.includes('新天地'), '最终字幕应保留找房关键词')
    assert.ok(!completed.transcript.includes('13812345678'), '实时字幕必须脱敏手机号')
  } finally {
    Object.keys(oldEnv).forEach((key) => {
      if (oldEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = oldEnv[key]
      }
    })
  }
}

main()
console.log('asr-realtime-proxy-test passed')
