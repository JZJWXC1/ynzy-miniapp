'use strict'

const assert = require('assert')
const apiService = require('../../utils/api-service')
const mockData = require('../../utils/mock-data')

const matches = apiService._internal && apiService._internal.mapMockMatchesLayout
assert.strictEqual(typeof matches, 'function', 'Mock 地图必须暴露可重复验证的户型语义匹配')

assert.strictEqual(matches({ layout: '2室1厅' }, { layout: '2室1厅' }, '两室'), true, '两室必须匹配 2室1厅')
assert.strictEqual(matches({ layout: '两室一厅' }, { layout: '两室一厅' }, '二室'), true, '二室必须匹配中文两室')
assert.strictEqual(matches({ layout: '3室2厅' }, { layout: '3室2厅' }, '三室'), true, '三室必须精确匹配 3 室')
assert.strictEqual(matches({ layout: '4室2厅' }, { layout: '4室2厅' }, '三室'), false, '三室不得误收四室')
assert.strictEqual(matches({ layout: '3室2厅' }, { layout: '3室2厅' }, '三室以上'), true, '三室以上必须包含三室')
assert.strictEqual(matches({ layout: '5室3厅' }, { layout: '5室3厅' }, '三室以上'), true, '三室以上必须包含五室')
assert.strictEqual(matches({ layout: '2室1厅' }, { layout: '2室1厅' }, '三室以上'), false, '三室以上不得误收两室')

const originalGetMapPins = mockData.getMapPins
mockData.getMapPins = () => [
  {
    id: 'MOCK-MAP-A',
    district: '甲区',
    area: '甲区',
    block: '东新',
    community: '同名花苑',
    latitude: 30.1,
    longitude: 120.1,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    lifecycleStatus: 'active',
    status: '在租',
    companyListing: true,
    sourceType: '公司房源',
    rent: 3000,
    layout: '2室1厅'
  },
  {
    id: 'MOCK-MAP-B',
    district: '乙区',
    area: '乙区',
    block: '东新园',
    community: '同名花苑',
    latitude: 30.5,
    longitude: 120.5,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    lifecycleStatus: 'active',
    status: '在租',
    companyListing: true,
    sourceType: '公司房源',
    rent: 3200,
    layout: '2室1厅'
  }
]
try {
  const sameNameGroups = apiService._internal.mockMapCommunities({})
  assert.strictEqual(sameNameGroups.length, 2, 'Mock 地图也必须按行政区、板块、小区三元组拆分同名小区')
  assert.strictEqual(new Set(sameNameGroups.map((item) => item.groupId)).size, 2, 'Mock 同名小区必须有不同稳定分组 ID')
  const exactGroup = apiService._internal.mockMapCommunities({ district: '甲', block: '东新' })
  assert.deepStrictEqual(
    exactGroup.flatMap((item) => item.activeListingIds),
    ['MOCK-MAP-A'],
    'Mock 地图结构化行政区和板块必须等值匹配'
  )
} finally {
  mockData.getMapPins = originalGetMapPins
}

console.log('map-mock-layout-semantics-v1-test: PASS')
