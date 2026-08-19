const assert = require('assert')
const mockData = require('../../utils/mock-data')

const TEXT = {
  hangzhou: '\u676d\u5dde',
  binjiang: '\u6ee8\u6c5f\u533a',
  changhe: '\u957f\u6cb3',
  community: '\u534a\u5c71\u5bb6\u82d1',
  wholeRent: '\u6574\u79df',
  oneRoom: '\u4e00\u5ba4',
  hall: '1\u5385',
  bath: '1\u536b',
  elevator: '\u7535\u68af',
  noCommission: '\u4e0d\u5206\u4f63',
  company: '\u516c\u53f8\u623f\u6e90',
  owner: '\u4e1a\u4e3b\u623f\u6e90',
  secondLandlord: '\u4e8c\u623f\u4e1c\u623f\u6e90',
  none: '\u65e0'
}

function listingPayload(overrides = {}) {
  return {
    city: TEXT.hangzhou,
    area: TEXT.binjiang,
    district: TEXT.binjiang,
    block: TEXT.changhe,
    communityName: TEXT.community,
    community: TEXT.community,
    building: '1',
    unit: '1',
    roomNumber: overrides.roomNumber || '1201',
    contact: overrides.contact || '13800009991',
    rent: 3500,
    rentMode: TEXT.wholeRent,
    room: TEXT.oneRoom,
    hall: TEXT.hall,
    bath: TEXT.bath,
    videoKey: `house-videos/mock-commission-${overrides.roomNumber || '1201'}.mp4`,
    features: [TEXT.elevator],
    ...overrides
  }
}

function run() {
  mockData.loginByPhone('13800010004')

  const company = mockData.addNormalListing(listingPayload({
    companyListing: true,
    ownerType: TEXT.company,
    houseSourceType: TEXT.company,
    source: TEXT.company,
    commissionRate: 18,
    features: [TEXT.noCommission, TEXT.elevator]
  }))
  assert.strictEqual(company.companyListing, true, 'mock company listing should keep company flag')
  assert.strictEqual(company.noCommission, true, 'mock company listing should be no commission')
  assert.strictEqual(company.commissionRate, 0, 'mock company listing should force zero commission')

  const companyDetail = mockData.getListingDetail(company.id)
  assert.deepStrictEqual(
    companyDetail.companyContactPhones,
    ['19900000001', '19900000002', '19900000003'],
    'mock company detail should retain the same three synthetic company phones as the server contract'
  )
  assert.strictEqual(companyDetail.companyContactPhoneText, '19900000001', 'mock legacy phone text should keep the first synthetic phone')

  const convertedSecondLandlord = mockData.updateNormalListing(company.id, listingPayload({
    companyListing: false,
    ownerType: TEXT.secondLandlord,
    houseSourceType: TEXT.secondLandlord,
    source: TEXT.secondLandlord,
    commissionRate: 0,
    features: [TEXT.none]
  }))
  assert.strictEqual(convertedSecondLandlord.companyListing, false, 'mock listing should clear company flag')
  assert.strictEqual(convertedSecondLandlord.isCompanyListing, false, 'mock listing should clear legacy company flag')
  assert.strictEqual(convertedSecondLandlord.noCommission, false, 'mock listing should clear noCommission after leaving company source')
  assert.strictEqual(convertedSecondLandlord.commissionRate, 20, 'mock second-landlord listing should recompute uploader rate to 20')
  assert.strictEqual(convertedSecondLandlord.features.indexOf(TEXT.noCommission), -1, 'mock listing should remove no-commission feature')

  const detail = mockData.getListingDetail(company.id, { viewerId: 'U004' })
  assert.strictEqual(detail.noCommission, false, 'mock detail should expose commission-enabled state')
  assert.ok(!Object.prototype.hasOwnProperty.call(detail, 'commissionRate'), 'mock detail should remove legacy commissionRate')
  assert.ok(!Object.prototype.hasOwnProperty.call(detail, 'commissionText'), 'mock detail should remove legacy commissionText')
  assert.deepStrictEqual(detail.commissionBreakdown, {
    landlordPercentOfRent: 50,
    viewingAgentPercentOfRent: 50,
    maintainerPercentOfRent: 0,
    platformPercentOfRent: 0,
    split: { viewingAgentRate: 100, maintainerRate: 0, platformRate: 0 }
  }, 'mock detail should use the same server-computed breakdown contract for self viewing')
  assert.strictEqual(detail.features.indexOf(TEXT.noCommission), -1, 'mock detail should not expose no-commission feature')

  const owner = mockData.updateNormalListing(company.id, listingPayload({
    companyListing: false,
    ownerType: TEXT.owner,
    houseSourceType: TEXT.owner,
    source: TEXT.owner,
    commissionRate: 0,
    features: [TEXT.none]
  }))
  assert.strictEqual(owner.noCommission, false, 'mock owner listing should stay commission-enabled')
  assert.strictEqual(owner.commissionRate, 20, 'mock owner listing should recompute uploader rate to 20')

  const savedConfig = mockData.updateCommissionConfig({
    secondLandlordRate: 12,
    ownerRate: 18
  })
  assert.strictEqual(savedConfig.secondLandlordRate, 12, 'mock commission config should update second-landlord rate')

  const configBeforeNegative = mockData.getCommissionConfig()
  const logsBeforeNegative = mockData.getAdminLogs().length
  assert.throws(
    () => mockData.updateCommissionConfig({ uploaderRates: { [TEXT.owner]: -1 } }),
    (error) => error && error.statusCode === 400 && /不能小于 0/.test(error.message),
    'mock nested negative commission rate must match server 400 behavior'
  )
  assert.deepStrictEqual(mockData.getCommissionConfig(), configBeforeNegative, 'mock negative config rejection must not mutate config')
  assert.strictEqual(mockData.getAdminLogs().length, logsBeforeNegative, 'mock negative config rejection must not append audit records')

  ;[
    { ownerRate: 'abc' },
    { uploaderRates: { [TEXT.secondLandlord]: '-1e999' } },
    { platformRates: { [TEXT.owner]: Infinity } },
    { ownerRate: false },
    { ownerRate: [] },
    { ownerRate: [5] },
    { ownerRate: '' },
    { ownerRate: '   ' },
    { ownerRate: {} }
  ].forEach((payload) => {
    const beforeInvalidConfig = mockData.getCommissionConfig()
    const beforeInvalidLogs = mockData.getAdminLogs().length
    assert.throws(
      () => mockData.updateCommissionConfig(payload),
      (error) => error && error.statusCode === 400 && /有限数字/.test(error.message),
      'mock malformed commission rate must match server 400 behavior'
    )
    assert.deepStrictEqual(mockData.getCommissionConfig(), beforeInvalidConfig, 'mock malformed config rejection must not mutate config')
    assert.strictEqual(mockData.getAdminLogs().length, beforeInvalidLogs, 'mock malformed config rejection must not append audit records')
  })

  ;[
    null,
    [],
    {},
    { ownerRate: null },
    { uploaderRates: [] },
    { platformRates: false },
    { uploaderRates: {} },
    { unknownRate: 10 }
  ].forEach((payload) => {
    const beforeInvalidConfig = mockData.getCommissionConfig()
    const beforeInvalidLogs = mockData.getAdminLogs().length
    assert.throws(
      () => mockData.updateCommissionConfig(payload),
      (error) => error && error.statusCode === 400,
      'mock empty or malformed commission container must fail closed'
    )
    assert.deepStrictEqual(mockData.getCommissionConfig(), beforeInvalidConfig, 'mock invalid container rejection must not mutate config')
    assert.strictEqual(mockData.getAdminLogs().length, beforeInvalidLogs, 'mock invalid container rejection must not append audit records')
  })

  const numericStringConfig = mockData.updateCommissionConfig({ ownerRate: '12.5' })
  assert.strictEqual(numericStringConfig.ownerRate, 12.5, 'mock strict decimal string must remain compatible')

  const aliasConfig = mockData.updateCommissionConfig({
    secondLandlordUploaderRate: 31,
    ownerUploaderRate: 27,
    secondLandlordPlatformRate: 9,
    ownerPlatformRate: 8
  })
  assert.strictEqual(aliasConfig.secondLandlordRate, 31, 'mock must honor second-landlord uploader alias')
  assert.strictEqual(aliasConfig.ownerRate, 27, 'mock must honor owner uploader alias')

  const nestedConfig = mockData.updateCommissionConfig({
    uploaderRates: { [TEXT.secondLandlord]: 19, [TEXT.owner]: 17 },
    platformRates: { [TEXT.secondLandlord]: 13, [TEXT.owner]: 11 }
  })
  assert.strictEqual(nestedConfig.secondLandlordRate, 19, 'mock nested second-landlord uploader rate must take effect')
  assert.strictEqual(nestedConfig.ownerRate, 17, 'mock nested owner uploader rate must take effect')
  assert.strictEqual(nestedConfig.secondLandlordPlatformRate, 13, 'mock nested second-landlord platform rate must take effect')
  assert.strictEqual(nestedConfig.ownerPlatformRate, 11, 'mock nested owner platform rate must take effect')

  const priorityConfig = mockData.updateCommissionConfig({
    ownerRate: 21,
    ownerUploaderRate: 22,
    uploaderRates: { [TEXT.owner]: 23 }
  })
  assert.strictEqual(priorityConfig.ownerRate, 21, 'mock canonical field must win over alias and nested values')
  assert.strictEqual(priorityConfig.secondLandlordRate, 19, 'mock partial update must preserve unrelated rates')

  const exactHundred = mockData.updateCommissionConfig({ ownerRate: 60, ownerPlatformRate: 40 })
  assert.strictEqual(exactHundred.ownerRate + exactHundred.ownerPlatformRate, 100, 'mock uploader+platform exactly 100 must remain valid')

  const beforeOverflowConfig = mockData.getCommissionConfig()
  const beforeOverflowLogs = mockData.getAdminLogs().length
  assert.throws(
    () => mockData.updateCommissionConfig({ ownerRate: 70, ownerPlatformRate: 40 }),
    (error) => error && error.statusCode === 400,
    'mock owner uploader+platform over 100 must match production fail-closed behavior'
  )
  assert.deepStrictEqual(mockData.getCommissionConfig(), beforeOverflowConfig, 'mock overflow rejection must not mutate config')
  assert.strictEqual(mockData.getAdminLogs().length, beforeOverflowLogs, 'mock overflow rejection must not append audit records')

  const beforeNestedOverflowConfig = mockData.getCommissionConfig()
  const beforeNestedOverflowLogs = mockData.getAdminLogs().length
  assert.throws(
    () => mockData.updateCommissionConfig({
      uploaderRates: { [TEXT.secondLandlord]: 70 },
      platformRates: { [TEXT.secondLandlord]: 40 }
    }),
    (error) => error && error.statusCode === 400,
    'mock nested uploader+platform over 100 must fail closed'
  )
  assert.deepStrictEqual(mockData.getCommissionConfig(), beforeNestedOverflowConfig, 'mock nested overflow rejection must not mutate config')
  assert.strictEqual(mockData.getAdminLogs().length, beforeNestedOverflowLogs, 'mock nested overflow rejection must not append audit records')

  const clampedConfig = mockData.updateCommissionConfig({ ownerRate: 200, ownerPlatformRate: 0 })
  assert.strictEqual(clampedConfig.ownerRate, 100, 'mock single rate over 100 with other side zero keeps historical clamp compatibility')

  const configurable = mockData.addNormalListing(listingPayload({
    roomNumber: '1202',
    ownerType: TEXT.secondLandlord,
    houseSourceType: TEXT.secondLandlord,
    source: TEXT.secondLandlord
  }))
  assert.strictEqual(configurable.commissionRate, 19, 'mock new second-landlord listing should use latest configured nested rate')
}

run()
console.log('mock-data-commission-v1-test passed')
