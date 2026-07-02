const assert = require('assert')
const { _internal: graphInternal } = require('../src/assistant/graph')
const { containsSensitiveText } = require('../src/assistant/safety')

async function main() {
  const guarded = await graphInternal.outputGuardNode({
    reply: '可以看春波南苑1栋2单元301室，房东电话13900000001，视频 https://oss.example.com/a.mp4?OSSAccessKeyId=ak&Signature=raw',
    nextQuestion: '再发我客户手机号13812345678',
    need: {
      budget: '4000',
      community: '春波南苑1栋2单元301室',
      address: '杭州滨江春波南苑1栋2单元301室',
      landlordPhone: '13900000001',
      hardConstraints: {
        community: '春波南苑1栋2单元301室',
        features: [
          '燃气',
          { name: '电梯', landlordPhone: '13900000001' }
        ]
      },
      preferences: {
        features: [
          '近地铁',
          { name: '阳台', videoSignedUrl: 'https://oss.example.com/b.mp4?Signature=raw' }
        ]
      }
    },
    listings: [
      {
        id: 'L001',
        title: '春波南苑1栋2单元301室',
        community: '春波南苑',
        area: '滨江',
        layout: '整租两室一厅一卫',
        rentMode: '整租',
        rent: 3900,
        address: '杭州滨江春波南苑1栋2单元301室',
        building: '1',
        unit: '2',
        roomNumber: '301',
        landlordPhone: '13900000001',
        videoUrl: 'https://oss.example.com/a.mp4?OSSAccessKeyId=ak&Signature=raw',
        features: [
          '燃气',
          { name: '电梯', landlordPhone: '13900000001' }
        ],
        matchReason: '预算内，房东电话13900000001',
        differenceText: '视频 https://oss.example.com/a.mp4?OSSAccessKeyId=ak&Signature=raw',
        differences: [
          '无明显差异',
          { note: '房号301室', videoSignedUrl: 'https://oss.example.com/a.mp4?Signature=raw' }
        ],
        relevanceReasons: [
          '位置匹配',
          { note: '联系13900000001' }
        ]
      }
    ],
    exactListings: [],
    nearbyListings: [],
    placeResolution: {
      status: 'resolved',
      name: '春波南苑1栋2单元301室',
      latitude: 30.1,
      longitude: 120.2,
      candidates: [
        {
          name: '春波南苑1栋2单元301室',
          latitude: 30.1,
          longitude: 120.2,
          landlordPhone: '13900000001'
        }
      ]
    }
  })

  const output = guarded.guardedOutput
  const outputText = JSON.stringify(output)
  assert(output, '应返回 guardedOutput')
  assert(!containsSensitiveText(output), 'output_guard 输出仍包含敏感文本')
  ;['address', 'building', 'unit', 'roomNumber', 'landlordPhone', 'videoUrl', 'videoSignedUrl', 'latitude', 'longitude'].forEach((key) => {
    assert(!outputText.includes(`"${key}"`), `output_guard 不应返回敏感字段：${key}`)
  })
  assert.strictEqual((output.listings || []).length, 1, '白名单后仍应保留可展示房源')
  assert.strictEqual(output.listings[0].id, 'L001', '白名单不能改写房源 ID')
  assert(!Object.prototype.hasOwnProperty.call(output.listings[0], 'address'), '房源不应包含完整地址')
  assert(!Object.prototype.hasOwnProperty.call(output.placeResolution || {}, 'latitude'), '地点解析不应暴露纬度')
  assert(!Object.prototype.hasOwnProperty.call(output.placeResolution || {}, 'longitude'), '地点解析不应暴露经度')

  console.log('assistant-output-guard-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
