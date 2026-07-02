const assert = require('assert')
const { Readable } = require('stream')
const { parseMultipartForm } = require('../src/multipart')

async function main() {
  const boundary = '----ynzy-test-boundary'
  const audio = Buffer.from('fake-binary-audio')
  const head = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="duration"',
    '',
    '1200',
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="voice.mp3"',
    'Content-Type: audio/mpeg',
    '',
    ''
  ].join('\r\n'))
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, audio, tail])
  const req = Readable.from([body])
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`
  }

  const parsed = await parseMultipartForm(req, { maxBytes: 1024 })
  assert.strictEqual(parsed.fields.duration, '1200')
  assert.strictEqual(parsed.file.name, 'file')
  assert.strictEqual(parsed.file.filename, 'voice.mp3')
  assert.strictEqual(parsed.file.contentType, 'audio/mpeg')
  assert.strictEqual(parsed.file.buffer.toString(), 'fake-binary-audio')

  const oversizedReq = Readable.from([Buffer.alloc(8)])
  oversizedReq.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`
  }
  await assert.rejects(
    () => parseMultipartForm(oversizedReq, { maxBytes: 4 }),
    (error) => error.statusCode === 413,
    '超过上传上限时必须拒绝'
  )
}

main().then(() => {
  console.log('multipart-parser-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
