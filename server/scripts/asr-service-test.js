const assert = require('assert')
const asrService = require('../src/asr-service')

async function main() {
  const oldFetch = global.fetch
  const oldEnv = {
    ASR_API_KEY: process.env.ASR_API_KEY,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    LLM_API_KEY: process.env.LLM_API_KEY,
    ASR_API_BASE_URL: process.env.ASR_API_BASE_URL,
    ASR_MODEL: process.env.ASR_MODEL
  }

  try {
    process.env.ASR_API_KEY = 'test-asr-key'
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.LLM_API_KEY
    delete process.env.ASR_API_BASE_URL
    delete process.env.ASR_MODEL

    let captured = null
    global.fetch = async (url, options) => {
      captured = {
        url,
        options,
        body: JSON.parse(options.body)
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: '客户找拱墅万达附近2000左右单间，手机号13812345678'
              }
            }
          ]
        })
      }
    }

    const result = await asrService.transcribeAudio({}, {
      filename: 'voice.mp3',
      contentType: 'audio/mpeg',
      buffer: Buffer.from('fake-audio')
    }, {
      fields: { duration: '1200', format: 'mp3' }
    })

    assert.strictEqual(result.provider, 'qwen-asr')
    assert.strictEqual(result.model, 'qwen3-asr-flash')
    assert.strictEqual(result.mode, 'bailian-asr-v1')
    assert.ok(result.text.includes('拱墅万达'), '应保留找房关键词')
    assert.ok(!result.text.includes('13812345678'), 'ASR 返回文本中的手机号必须脱敏')
    assert.strictEqual(captured.url, asrService.DEFAULT_ASR_API_BASE_URL)
    assert.strictEqual(captured.options.headers.Authorization, 'Bearer test-asr-key')
    assert.strictEqual(captured.body.model, 'qwen3-asr-flash')
    assert.strictEqual(captured.body.messages[0].content[0].type, 'input_audio')
    assert.strictEqual(captured.body.messages[0].content[0].input_audio.format, 'mp3')
    assert.ok(
      captured.body.messages[0].content[0].input_audio.data.startsWith('data:audio/mpeg;base64,'),
      '应使用百炼 ASR 支持的 base64 Data URL'
    )

    delete process.env.ASR_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.LLM_API_KEY
    await assert.rejects(
      () => asrService.transcribeAudio({}, {
        filename: 'voice.mp3',
        contentType: 'audio/mpeg',
        buffer: Buffer.from('fake-audio')
      }),
      (error) => error.statusCode === 503 && /ASR_API_KEY/.test(error.message),
      '缺少服务端密钥时必须拒绝识别'
    )

    process.env.ASR_API_KEY = 'test-asr-key'
    await assert.rejects(
      () => asrService.transcribeAudio({}, {
        filename: 'voice.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('fake-audio')
      }),
      (error) => error.statusCode === 400 && /暂不支持/.test(error.message),
      '不支持的音频格式必须拒绝'
    )
  } finally {
    global.fetch = oldFetch
    Object.keys(oldEnv).forEach((key) => {
      if (oldEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = oldEnv[key]
      }
    })
  }
}

main().then(() => {
  console.log('asr-service-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
