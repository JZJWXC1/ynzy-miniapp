// OSS 私有桶视频首帧封面签名：验证 createVideoSnapshotUrl 把 x-oss-process=video/snapshot 作为
// subresource 纳入 V1 签名（否则私有桶返回 SignatureDoesNotMatch）。独立复算签名，不依赖真实 OSS 桶。
// env 必须在 require 前设置（config.js 在加载时读取）。
process.env.ALI_OSS_BUCKET = 'test-bucket'
process.env.ALI_OSS_REGION = 'oss-cn-beijing'
process.env.ALI_OSS_ACCESS_KEY_ID = 'TESTAKID'
process.env.ALI_OSS_ACCESS_KEY_SECRET = 'TESTSECRET'

const assert = require('assert')
const crypto = require('crypto')
const oss = require('../src/oss')

const PROCESS = 'video/snapshot,t_0,f_jpg,w_640,h_0,m_fast'
const videoKey = 'house-videos/20260101/1700000000-abc-listing.mp4'

const url = oss.createVideoSnapshotUrl(videoKey, 900)

// 结构：host、字面 x-oss-process、OSSAccessKeyId/Expires/Signature
assert.ok(url.startsWith('https://test-bucket.oss-cn-beijing.aliyuncs.com/'), `host 应为 bucket.region.aliyuncs.com：${url}`)
assert.ok(url.includes(`x-oss-process=${PROCESS}`), 'query 必须含字面 x-oss-process（与签名串一致，勿编码 / 和 ,）')
assert.ok(/[?&]OSSAccessKeyId=TESTAKID/.test(url), 'URL 应含 OSSAccessKeyId')
const expiresMatch = url.match(/[?&]Expires=(\d+)/)
assert.ok(expiresMatch, 'URL 应含 Expires')
const sigMatch = url.match(/[?&]Signature=([^&]+)/)
assert.ok(sigMatch, 'URL 应含 Signature')

// 独立复算签名：CanonicalizedResource 必须含 ?x-oss-process=<value> 这个 subresource
const expires = Number(expiresMatch[1])
const resourcePath = `/test-bucket/${videoKey}?x-oss-process=${PROCESS}`
const stringToSign = ['GET', '', '', String(expires), resourcePath].join('\n')
const expectedSig = crypto.createHmac('sha1', 'TESTSECRET').update(stringToSign).digest('base64')
const actualSig = decodeURIComponent(sigMatch[1])
assert.strictEqual(actualSig, expectedSig, '签名必须把 x-oss-process 纳入 CanonicalizedResource（否则私有桶 SignatureDoesNotMatch）')

// 对照：把 x-oss-process 从签名串里漏掉，签名应不同——反向确认上面的等式确实覆盖了 subresource
const wrongStringToSign = ['GET', '', '', String(expires), `/test-bucket/${videoKey}`].join('\n')
const wrongSig = crypto.createHmac('sha1', 'TESTSECRET').update(wrongStringToSign).digest('base64')
assert.notStrictEqual(actualSig, wrongSig, 'x-oss-process 必须真的影响签名，否则等于没纳入 subresource')

// 非视频对象 / 空 key → 空串：不给无视频/非视频房源伪造封面
assert.strictEqual(oss.createVideoSnapshotUrl('house-videos/x/note.txt', 900), '', '非视频对象不产封面')
assert.strictEqual(oss.createVideoSnapshotUrl('', 900), '', '空 key 不产封面')
assert.strictEqual(oss.createVideoSnapshotUrl(null, 900), '', 'null key 不产封面')

// 对象路径按段 URL 编码，但签名用原始 key（OSS V1 CanonicalizedResource 用未编码对象名）
assert.ok(url.includes('/house-videos/20260101/'), '对象路径应保留目录结构')

console.log('oss-video-snapshot-v1-test passed')
