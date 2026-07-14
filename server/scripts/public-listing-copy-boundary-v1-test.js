'use strict'

const assert = require('assert')
const domain = require('../src/domain')
const matchService = require('../src/match-service')
const mockData = require('../../utils/mock-data')

const SYNTHETIC_PHONE = '19900007777'
const ENGLISH_ADDRESS_LABELS = [
  'Unit B',
  'Room 701',
  'No. 701',
  'Building A',
  'R o o m 701',
  'room🫥701',
  'Room 701A',
  'Floor 2F',
  'Unit 2B',
  'Building A1',
  'Floor 2nd',
  'No 12A',
  'Room 7-01',
  'Room B-701',
  'Fl 2',
  'Fl. 2',
  'Fl B',
  '#701',
  '＃７０１',
  'Lvl 2',
  'Lvl. 2',
  'Lvl B',
  'Bld 2',
  'Bld. 2',
  'Bld B',
  'Rm B',
  'Ste A',
  'Room No 702',
  'Room No. 702',
  'Apt No 702',
  'Unit No 2',
  '2F',
  'F2',
  '9F',
  '9th Floor',
  '第2层',
  '楼层2',
  '樓層2',
  '2层',
  '2樓層'
]
const ENGLISH_PUBLIC_COPY = 'Community · unit price follows · 2 rooms · not now · C# tutorial · level up · floor plan'
const LEGAL_PUBLIC_COPY_CASES = [
  'Safe C# 701 parser',
  'Safe Loft 2F layout',
  'Safe 2F Loft layout',
  'Safe 月租3200元',
  'Safe 层高2.8米',
  'Safe 2层复式'
]
const PRIVATE_CONTACT_ID = 'privateid'
const PRIVATE_CONTACT_CASES = [
  '安全板块 t.me/privateid 近地铁',
  '安全板块 wa.me/privateid 近地铁',
  '安全板块 xhs privateid 近地铁',
  '安全板块 dy privateid 近地铁',
  '安全板块 ins privateid 近地铁',
  '安全板块 phοne:privateid 近地铁',
  '安全板块 phоne:privateid 近地铁',
  '安全板块 cοntact:privateid 近地铁',
  '安全板块 weсhat:privateid 近地铁',
  '安全板块 telegrаm:privateid 近地铁',
  '安全板块 whatsаpp:privateid 近地铁'
]
const PRIVATE_EXTERNAL_LINK_CASES = [
  { copy: '安全板块 douyin.com/user/privateid 近地铁', forbidden: ['douyin.com', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 m.douyin.com:8443/share/user/privateid?from=copy#profile 近地铁', forbidden: ['douyin.com', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 xdstore.cn 近地铁', forbidden: ['xdstore.cn'] },
  { copy: '安全板块 sub.synthetic-store.cn/contact/privateid 近地铁', forbidden: ['synthetic-store.cn', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 ｄοｕｙｉｎ．ｃｏｍ／user／privateid 近地铁', forbidden: ['ｄοｕｙｉｎ', 'ｃｏｍ', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 xhslink。com／a／privateid 近地铁', forbidden: ['xhslink', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 xn--fiqs8s.cn/privateid 近地铁', forbidden: ['xn--fiqs8s.cn', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 synthetic-test.中国/联系 近地铁', forbidden: ['synthetic-test', '中国/联系'] },
  { copy: '安全板块 //synthetic-store.cn/privateid 近地铁', forbidden: ['synthetic-store.cn', PRIVATE_CONTACT_ID] },
  { copy: '安全板块 custom://synthetic-store.dev/privateid 近地铁', forbidden: ['synthetic-store.dev', PRIVATE_CONTACT_ID] }
]
const DOTTED_PUBLIC_COPY_CASES = [
  '版本1.2.701',
  '层高2.8米',
  '月租3200.50元',
  '日期2026-07-14',
  '文档IP 192.0.2.1',
  'Vanke.City',
  'O.Park',
  'The.Hub',
  'Node.js parser',
  'video.mp4'
]
const NATURAL_PUBLIC_COPY_CASES = [
  'phone signal strong',
  'mobile signal excellent',
  'Signal coverage good',
  'contact tracing available',
  'password protected WiFi'
]
const MULTIPLICATIVE_ADDRESS_CASES = [
  { copy: '安全板块 十二/二/七零一 近地铁', forbidden: /[〇零一二两兩三四五六七八九十百千拾佰仟壹贰貳叁參肆伍陆陸柒捌玖]/ },
  { copy: '安全板块 拾贰/贰/柒零壹 近地铁', forbidden: /[〇零一二两兩三四五六七八九十百千拾佰仟壹贰貳叁參肆伍陆陸柒捌玖]/ },
  { copy: '安全板块 二十一🫥三🫥七零一 近地铁', forbidden: /[〇零一二两兩三四五六七八九十百千拾佰仟壹贰貳叁參肆伍陆陸柒捌玖]/ },
  { copy: '安全板块 文一西路九十六号 近地铁', forbidden: /(?:九十六|十六)号/ },
  { copy: '安全板块 文一西路玖拾陆号 近地铁', forbidden: /(?:玖拾陆|拾陆)号/ }
]
const ENGLISH_ADDRESS_CASES = [
  'Safe Unit B near subway',
  'Safe Room 701 near subway',
  'Safe No. 701 near subway',
  'Safe Building A with elevator',
  'Safe R o o m 701 near subway',
  'Safe room🫥701 near subway',
  'Safe Room 701A near subway',
  'Safe Floor 2F near subway',
  'Safe Unit 2B near subway',
  'Safe Building A1 with elevator',
  'Safe Floor 2nd near subway',
  'Safe No 12A near subway',
  'Safe Room 7-01 near subway',
  'Safe Room B-701 near subway',
  'Safe Fl 2 near subway',
  'Safe Fl. 2 near subway',
  'Safe Fl B near subway',
  'Safe #701 near subway',
  'Safe ＃７０１ near subway',
  'Safe Lvl 2 near subway',
  'Safe Lvl. 2 near subway',
  'Safe Lvl B near subway',
  'Safe Bld 2 near subway',
  'Safe Bld. 2 near subway',
  'Safe Bld B near subway',
  'Safe Rm B near subway',
  'Safe Ste A near subway',
  'Safe Room No 702 near subway',
  'Safe Room No. 702 near subway',
  'Safe Apt No 702 near subway',
  'Safe Unit No 2 near subway',
  'Safe 2F near subway',
  'Safe F2 near subway',
  'Safe 9F near subway',
  'Safe 9th Floor near subway',
  'Safe 第2层 near subway',
  'Safe 楼层2 near subway',
  'Safe 樓層2 near subway',
  'Safe 2层 near subway',
  'Safe 2樓層 near subway'
]
const ENGLISH_ADDRESS_COPY = ENGLISH_ADDRESS_CASES.join(' | ')

function partnerListing(id, overrides) {
  return Object.assign({
    id,
    uploaderId: 'COPY-BOUNDARY-UPLOADER',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: ENGLISH_PUBLIC_COPY,
    community: 'Joy Community',
    communityName: 'Joy Community',
    building: '1',
    unit: '8',
    roomNumber: '888',
    address: '杭州市拱墅区Joy Community 1栋8单元888室',
    landlordPhone: SYNTHETIC_PHONE,
    contact: SYNTHETIC_PHONE,
    rent: 3200,
    layout: '2 rooms',
    room: '2 rooms',
    hall: '1 hall',
    bath: '1 bath',
    rentMode: '整租',
    type: '整租',
    features: ['近地铁'],
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    status: '在租',
    lifecycleStatus: 'active',
    reviewStatus: '已通过',
    communityMatched: true,
    lastVerifiedAt: '2026-07-14T00:00:00.000Z',
    videoLabel: '2 rooms',
    videoKey: `house-videos/synthetic/${id}.mp4`,
    landlordCommissionPercent: 50,
    mapLatitude: 30.31,
    mapLongitude: 120.18,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true
  }, overrides || {})
}

function assertLegalEnglishCopy(row, label) {
  assert.strictEqual(row.community, 'Joy Community', `${label} 必须保留合法英文小区名`)
  ;['Community', 'unit price follows', '2 rooms', 'not now', 'C# tutorial', 'level up', 'floor plan'].forEach((copy) => {
    assert.ok(String(row.block || '').includes(copy), `${label} 必须保留普通英文板块文案 ${copy}，实际：${row.block || ''}`)
  })
  assert.strictEqual(row.layout, '2 rooms', `${label} 必须保留复数英文户型`)
  assert.strictEqual(row.room, '2 rooms', `${label} 必须保留复数英文房间描述`)
}

function assertAddressLabelsRemoved(value, label) {
  const text = String(value || '')
  ENGLISH_ADDRESS_LABELS.forEach((item) => {
    assert.ok(!text.includes(item), `${label} 不得公开英文精确地址标签 ${item}`)
  })
  assert.ok(text.includes('Safe') && text.includes('near subway') && text.includes('with elevator'), `${label} 删除精确地址后必须保留相邻公开文案，实际：${text}`)
}

function assertContactChannelsRemoved(rows, listings, label) {
  listings.forEach((listing) => {
    const row = rows.find((item) => item.id === listing.id)
    assert.ok(row, `${label} 必须保留私联对抗房源卡片`)
    assert.ok(String(row.block || '').includes('安全板块') && String(row.block || '').includes('近地铁'), `${label} 清除私联后必须保留相邻公开文案`)
    assert.ok(!JSON.stringify(row).includes(PRIVATE_CONTACT_ID), `${label} 不得公开站外私联 ID`)
  })
}

function assertExternalLinksRemoved(rows, listings, label) {
  listings.forEach((listing, index) => {
    const row = rows.find((item) => item.id === listing.id)
    const block = String(row && row.block || '')
    assert.ok(row, `${label} 必须保留裸域名对抗房源卡片`)
    assert.ok(block.includes('安全板块') && block.includes('近地铁'), `${label} 清除外链后必须保留相邻公开文案，实际：${block}`)
    PRIVATE_EXTERNAL_LINK_CASES[index].forbidden.forEach((fragment) => {
      assert.ok(!block.toLowerCase().includes(fragment.toLowerCase()), `${label} 不得留下可重组外链片段 ${fragment}，实际：${block}`)
    })
  })
}

function assertDottedPublicCopyPreserved(rows, listings, label) {
  listings.forEach((listing, index) => {
    const row = rows.find((item) => item.id === listing.id)
    assert.ok(row, `${label} 必须保留正常点号文案房源`)
    assert.ok(String(row.block || '').includes(DOTTED_PUBLIC_COPY_CASES[index]), `${label} 不得把正常点号文案误判成外链：${DOTTED_PUBLIC_COPY_CASES[index]}，实际：${row.block || ''}`)
  })
}

function assertNaturalCopyPreserved(rows, listings, label) {
  listings.forEach((listing, index) => {
    const row = rows.find((item) => item.id === listing.id)
    assert.ok(row, `${label} 必须保留正常英文设施文案房源`)
    assert.ok(String(row.block || '').includes(NATURAL_PUBLIC_COPY_CASES[index]), `${label} 不得误删正常英文设施文案 ${NATURAL_PUBLIC_COPY_CASES[index]}，实际：${row.block || ''}`)
  })
}

function assertMultiplicativeAddressesRemoved(rows, listings, label) {
  listings.forEach((listing, index) => {
    const row = rows.find((item) => item.id === listing.id)
    const block = String(row && row.block || '')
    assert.ok(row && block.includes('安全板块') && block.includes('近地铁'), `${label} 清除中文数词精确地址后必须保留相邻公开文案`)
    assert.ok(!MULTIPLICATIVE_ADDRESS_CASES[index].forbidden.test(block), `${label} 不得留下可重组的中文数词地址残片，实际：${block}`)
  })
}

function assertProductionProjection() {
  const legal = partnerListing('COPY-LEGAL')
  const companyExternalLink = partnerListing('COPY-COMPANY-EXTERNAL-LINK', {
    companyListing: true,
    isCompanyListing: true,
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    block: '公司公开板块 xdstore.cn/privateid 近地铁'
  })
  const address = partnerListing('COPY-ADDRESS', {
    community: 'Address Boundary Community',
    communityName: 'Address Boundary Community',
    block: ENGLISH_ADDRESS_COPY,
    address: '杭州市拱墅区Address Boundary Community 1栋8单元888室'
  })
  const maliciousDate = partnerListing('COPY-DATE', {
    community: 'Date Boundary Community',
    communityName: 'Date Boundary Community',
    block: 'Date Boundary',
    address: '杭州市拱墅区Date Boundary Community 1栋8单元888室',
    lastVerifiedAt: `Tue, 14 Jul 2026 00:00:00 GMT (contact ${SYNTHETIC_PHONE})`,
    mapLatitude: 30.3105,
    mapLongitude: 120.1805
  })
  const isolatedAddressListings = ENGLISH_ADDRESS_CASES.map((block, index) => partnerListing(`COPY-ADDRESS-ISOLATED-${index}`, {
    community: `Address Boundary Community ${index}`,
    communityName: `Address Boundary Community ${index}`,
    block,
    address: `杭州市拱墅区Address Boundary Community ${index} 1栋8单元888室`,
    mapLatitude: 30.311 + index * 0.0001,
    mapLongitude: 120.181 + index * 0.0001
  }))
  const legalPublicCopyListings = LEGAL_PUBLIC_COPY_CASES.map((block, index) => partnerListing(`COPY-LEGAL-ISOLATED-${index}`, {
    community: `Legal Copy Community ${index}`,
    communityName: `Legal Copy Community ${index}`,
    block,
    address: `杭州市拱墅区Legal Copy Community ${index} 1栋8单元888室`,
    mapLatitude: 30.315 + index * 0.0001,
    mapLongitude: 120.185 + index * 0.0001
  }))
  const contactListings = PRIVATE_CONTACT_CASES.map((block, index) => partnerListing(`COPY-CONTACT-${index}`, {
    block,
    community: `Contact Boundary Community ${index}`,
    communityName: `Contact Boundary Community ${index}`
  }))
  const externalLinkListings = PRIVATE_EXTERNAL_LINK_CASES.map((item, index) => partnerListing(`COPY-EXTERNAL-LINK-${index}`, {
    block: item.copy,
    community: `External Link Boundary Community ${index}`,
    communityName: `External Link Boundary Community ${index}`
  }))
  const dottedPublicCopyListings = DOTTED_PUBLIC_COPY_CASES.map((block, index) => partnerListing(`COPY-DOTTED-PUBLIC-${index}`, {
    block,
    community: `Dotted Public Boundary Community ${index}`,
    communityName: `Dotted Public Boundary Community ${index}`
  }))
  const naturalCopyListings = NATURAL_PUBLIC_COPY_CASES.map((block, index) => partnerListing(`COPY-NATURAL-${index}`, {
    block,
    community: `Natural Boundary Community ${index}`,
    communityName: `Natural Boundary Community ${index}`
  }))
  const multiplicativeAddressListings = MULTIPLICATIVE_ADDRESS_CASES.map((item, index) => partnerListing(`COPY-CHINESE-ADDRESS-${index}`, {
    block: item.copy,
    community: `Chinese Address Boundary Community ${index}`,
    communityName: `Chinese Address Boundary Community ${index}`,
    building: index < 2 ? '12' : '21',
    unit: index < 2 ? '2' : '3',
    roomNumber: '701'
  }))
  const db = {
    listings: [
      legal,
      companyExternalLink,
      address,
      maliciousDate,
      ...isolatedAddressListings,
      ...legalPublicCopyListings,
      ...contactListings,
      ...externalLinkListings,
      ...dottedPublicCopyListings,
      ...naturalCopyListings,
      ...multiplicativeAddressListings
    ],
    users: [{ id: 'COPY-BOUNDARY-UPLOADER', name: '合成上传人', status: '正常', authed: '已实名' }],
    commissionConfig: {}
  }

  const rows = domain.filterListings(db, { publicGuest: true })
  assertLegalEnglishCopy(rows.find((item) => item.id === legal.id), '生产列表')
  const companyExternalRow = rows.find((item) => item.id === companyExternalLink.id)
  assert.ok(companyExternalRow && String(companyExternalRow.block || '').includes('公司公开板块'), '生产公司房源必须保留公开板块文案')
  assert.ok(!JSON.stringify(companyExternalRow).includes('xdstore.cn') && !JSON.stringify(companyExternalRow).includes(PRIVATE_CONTACT_ID), '生产公司房源自由文本也只能保留服务器统一联系通道')
  const allowedCompanyPhone = '19900000001'
  const sanitizedCompanyCopy = domain.sanitizeCompanyPublicText(
    `公司统一号码 ${allowedCompanyPhone}；私人站点 xdstore.cn/privateid`,
    '',
    { allowedPhones: [allowedCompanyPhone] }
  )
  assert.ok(sanitizedCompanyCopy.includes(allowedCompanyPhone), '生产公司文案清洗不得误删服务器允许的统一测试号码')
  assert.ok(!sanitizedCompanyCopy.includes('xdstore.cn') && !sanitizedCompanyCopy.includes(PRIVATE_CONTACT_ID), '生产公司文案清洗必须删除私人裸域名')
  assertAddressLabelsRemoved(rows.find((item) => item.id === address.id).block, '生产列表板块')
  isolatedAddressListings.forEach((listing, index) => {
    const projected = rows.find((item) => item.id === listing.id)
    const source = ENGLISH_ADDRESS_CASES[index]
    assert.ok(projected, `生产列表必须保留英文地址单例 ${index}`)
    assert.ok(!String(projected.block || '').includes(ENGLISH_ADDRESS_LABELS[index]), `生产列表单例不得公开 ${ENGLISH_ADDRESS_LABELS[index]}`)
    assert.ok(String(projected.block || '').includes('Safe'), `生产列表单例删除地址后必须保留前置公开文案：${source}`)
    assert.ok(String(projected.block || '').includes(index === 3 || index === 9 ? 'with elevator' : 'near subway'), `生产列表单例删除地址后必须保留后置公开文案：${source}`)
  })
  legalPublicCopyListings.forEach((listing, index) => {
    const projected = rows.find((item) => item.id === listing.id)
    assert.ok(projected, `生产列表必须保留合法公开文案单例 ${index}`)
    assert.ok(String(projected.block || '').includes(LEGAL_PUBLIC_COPY_CASES[index]), `生产列表不得误删合法公开文案：${LEGAL_PUBLIC_COPY_CASES[index]}，实际：${projected.block || ''}`)
  })
  assertContactChannelsRemoved(rows, contactListings, '生产列表')
  assertExternalLinksRemoved(rows, externalLinkListings, '生产列表')
  assertDottedPublicCopyPreserved(rows, dottedPublicCopyListings, '生产列表')
  assertNaturalCopyPreserved(rows, naturalCopyListings, '生产列表')
  assertMultiplicativeAddressesRemoved(rows, multiplicativeAddressListings, '生产列表')
  const contactIds = new Set(contactListings.map((item) => item.id))
  const externalLinkIds = new Set(externalLinkListings.map((item) => item.id))
  assert.deepStrictEqual(
    domain.filterListings(db, { publicGuest: true, area: PRIVATE_CONTACT_ID }).filter((item) => contactIds.has(item.id)),
    [],
    '生产列表不得把私联 ID 变成位置搜索 oracle'
  )
  assert.deepStrictEqual(
    (domain.matchListings(db, { publicGuest: true, area: PRIVATE_CONTACT_ID }).listings || []).filter((item) => contactIds.has(item.id)),
    [],
    '生产简易匹配不得把私联 ID 变成搜索 oracle'
  )
  ;[PRIVATE_CONTACT_ID, 'douyin.com', 'xdstore.cn', 'synthetic-store.cn'].forEach((probe) => {
    assert.deepStrictEqual(
      domain.filterListings(db, { publicGuest: true, area: probe }).filter((item) => externalLinkIds.has(item.id)),
      [],
      `生产列表不得把外链 ${probe} 变成位置搜索 oracle`
    )
    assert.deepStrictEqual(
      (domain.matchListings(db, { publicGuest: true, area: probe }).listings || []).filter((item) => externalLinkIds.has(item.id)),
      [],
      `生产简易匹配不得把外链 ${probe} 变成搜索 oracle`
    )
  })
  const legalDetail = domain.listingDetail(db, legal.id)
  assertLegalEnglishCopy(legalDetail, '生产详情')
  assert.strictEqual(legalDetail.videoLabel, '2 rooms', '生产详情必须保留合法英文视频标题')

  const publicSurfaces = {
    home: domain.homeListings(db),
    list: rows,
    detail: domain.listingDetail(db, maliciousDate.id),
    map: domain.mapPins(db),
    nearby: domain.nearbyListings(db, legal.id),
    match: domain.matchListings(db, {}),
    llmCandidates: matchService._internal.candidateListings(db)
  }
  Object.keys(publicSurfaces).forEach((surface) => {
    const serialized = JSON.stringify(publicSurfaces[surface])
    assert.ok(!serialized.includes(SYNTHETIC_PHONE), `${surface} 不得通过畸形核验时间公开电话`)
    assert.ok(!serialized.includes('Tue, 14 Jul 2026'), `${surface} 不得公开非白名单核验时间原文`)
    assert.ok(!serialized.includes(PRIVATE_CONTACT_ID), `${surface} 不得公开站外私联 ID`)
  })
}

function addMockBoundaryListing(block, group, index) {
  return mockData.addNormalListing({
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block,
    community: `${group} Boundary Community ${index}`,
    communityName: `${group} Boundary Community ${index}`,
    building: group === 'Chinese Address' ? (index < 2 ? '12' : '21') : '1',
    unit: group === 'Chinese Address' ? (index < 2 ? '2' : '3') : '8',
    roomNumber: group === 'Chinese Address' ? '701' : '888',
    address: `杭州市拱墅区${group} Boundary Community ${index} 1栋8单元888室`,
    contact: SYNTHETIC_PHONE,
    landlordPhone: SYNTHETIC_PHONE,
    rent: 3200,
    layout: '2 rooms',
    room: '2 rooms',
    hall: '1 hall',
    bath: '1 bath',
    rentMode: '整租',
    features: ['近地铁'],
    videoUrl: `https://example.invalid/synthetic/${group.toLowerCase().replace(/\s+/g, '-')}-${index}.mp4`,
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    communityMatched: true,
    landlordCommissionPercent: 50
  })
}

function assertMockProjection() {
  mockData.loginByPhone('13800010005')
  const legal = mockData.addNormalListing({
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: ENGLISH_PUBLIC_COPY,
    community: 'Joy Community',
    communityName: 'Joy Community',
    building: '1',
    unit: '8',
    roomNumber: '888',
    address: '杭州市拱墅区Joy Community 1栋8单元888室',
    contact: SYNTHETIC_PHONE,
    landlordPhone: SYNTHETIC_PHONE,
    rent: 3200,
    layout: '2 rooms',
    room: '2 rooms',
    hall: '1 hall',
    bath: '1 bath',
    rentMode: '整租',
    features: ['近地铁'],
    videoUrl: 'https://example.com/synthetic/copy-legal.mp4',
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    communityMatched: true,
    landlordCommissionPercent: 50
  })
  const address = mockData.addNormalListing({
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: ENGLISH_ADDRESS_COPY,
    community: 'Address Boundary Community',
    communityName: 'Address Boundary Community',
    building: '1',
    unit: '8',
    roomNumber: '888',
    address: '杭州市拱墅区Address Boundary Community 1栋8单元888室',
    contact: SYNTHETIC_PHONE,
    landlordPhone: SYNTHETIC_PHONE,
    rent: 3200,
    layout: '2 rooms',
    room: '2 rooms',
    hall: '1 hall',
    bath: '1 bath',
    rentMode: '整租',
    features: ['近地铁'],
    videoUrl: 'https://example.com/synthetic/copy-address.mp4',
    viewingMethod: '联系房东',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    source: '二房东房源',
    communityMatched: true,
    landlordCommissionPercent: 50
  })
  const originalNow = Date.now
  const nowBase = originalNow()
  let isolatedAddressListings
  let legalPublicCopyListings
  let dottedPublicCopyListings
  Date.now = () => nowBase
  try {
    isolatedAddressListings = ENGLISH_ADDRESS_CASES.map((block, index) => mockData.addNormalListing({
      city: '杭州',
      district: '拱墅区',
      area: '拱墅区',
      block,
      community: `Address Boundary Community ${index}`,
      communityName: `Address Boundary Community ${index}`,
      building: '1',
      unit: '8',
      roomNumber: '888',
      address: `杭州市拱墅区Address Boundary Community ${index} 1栋8单元888室`,
      contact: SYNTHETIC_PHONE,
      landlordPhone: SYNTHETIC_PHONE,
      rent: 3200,
      layout: '2 rooms',
      room: '2 rooms',
      hall: '1 hall',
      bath: '1 bath',
      rentMode: '整租',
      features: ['近地铁'],
      videoUrl: `https://example.com/synthetic/copy-address-${index}.mp4`,
      viewingMethod: '联系房东',
      ownerType: '二房东房源',
      houseSourceType: '二房东房源',
      source: '二房东房源',
      communityMatched: true,
      landlordCommissionPercent: 50
    }))
    legalPublicCopyListings = LEGAL_PUBLIC_COPY_CASES.map((block, index) => mockData.addNormalListing({
      city: '杭州',
      district: '拱墅区',
      area: '拱墅区',
      block,
      community: `Legal Copy Community ${index}`,
      communityName: `Legal Copy Community ${index}`,
      building: '1',
      unit: '8',
      roomNumber: '888',
      address: `杭州市拱墅区Legal Copy Community ${index} 1栋8单元888室`,
      contact: SYNTHETIC_PHONE,
      landlordPhone: SYNTHETIC_PHONE,
      rent: 3200,
      layout: '2 rooms',
      room: '2 rooms',
      hall: '1 hall',
      bath: '1 bath',
      rentMode: '整租',
      features: ['近地铁'],
      videoUrl: `https://example.com/synthetic/copy-legal-${index}.mp4`,
      viewingMethod: '联系房东',
      ownerType: '二房东房源',
      houseSourceType: '二房东房源',
      source: '二房东房源',
      communityMatched: true,
      landlordCommissionPercent: 50
    }))
    dottedPublicCopyListings = DOTTED_PUBLIC_COPY_CASES.map((block, index) => addMockBoundaryListing(block, 'Dotted Public', index))
  } finally {
    Date.now = originalNow
  }
  const frozenClockListings = isolatedAddressListings.concat(legalPublicCopyListings, dottedPublicCopyListings)
  assert.strictEqual(new Set(frozenClockListings.map((item) => item.id)).size, frozenClockListings.length, 'Mock 同一毫秒快速新增房源也必须生成唯一 ID')

  const contactListings = PRIVATE_CONTACT_CASES.map((block, index) => addMockBoundaryListing(block, 'Contact', index))
  const externalLinkListings = PRIVATE_EXTERNAL_LINK_CASES.map((item, index) => addMockBoundaryListing(item.copy, 'External Link', index))
  const naturalCopyListings = NATURAL_PUBLIC_COPY_CASES.map((block, index) => addMockBoundaryListing(block, 'Natural', index))
  const multiplicativeAddressListings = MULTIPLICATIVE_ADDRESS_CASES.map((item, index) => addMockBoundaryListing(item.copy, 'Chinese Address', index))

  const rows = mockData.getListings({ publicGuest: true })
  assertLegalEnglishCopy(rows.find((item) => item.id === legal.id), 'Mock 列表')
  assertAddressLabelsRemoved(rows.find((item) => item.id === address.id).block, 'Mock 列表板块')
  isolatedAddressListings.forEach((listing, index) => {
    const projected = rows.find((item) => item.id === listing.id)
    const source = ENGLISH_ADDRESS_CASES[index]
    assert.ok(projected, `Mock 列表必须保留英文地址单例 ${index}`)
    assert.ok(!String(projected.block || '').includes(ENGLISH_ADDRESS_LABELS[index]), `Mock 列表单例不得公开 ${ENGLISH_ADDRESS_LABELS[index]}`)
    assert.ok(String(projected.block || '').includes('Safe'), `Mock 列表单例删除地址后必须保留前置公开文案：${source}`)
    assert.ok(String(projected.block || '').includes(index === 3 || index === 9 ? 'with elevator' : 'near subway'), `Mock 列表单例删除地址后必须保留后置公开文案：${source}，实际：${projected.block || ''}`)
  })
  legalPublicCopyListings.forEach((listing, index) => {
    const projected = rows.find((item) => item.id === listing.id)
    assert.ok(projected, `Mock 列表必须保留合法公开文案单例 ${index}`)
    assert.ok(String(projected.block || '').includes(LEGAL_PUBLIC_COPY_CASES[index]), `Mock 列表不得误删合法公开文案：${LEGAL_PUBLIC_COPY_CASES[index]}，实际：${projected.block || ''}`)
  })
  assertContactChannelsRemoved(rows, contactListings, 'Mock 列表')
  assertExternalLinksRemoved(rows, externalLinkListings, 'Mock 列表')
  assertDottedPublicCopyPreserved(rows, dottedPublicCopyListings, 'Mock 列表')
  assertNaturalCopyPreserved(rows, naturalCopyListings, 'Mock 列表')
  assertMultiplicativeAddressesRemoved(rows, multiplicativeAddressListings, 'Mock 列表')
  const contactIds = new Set(contactListings.map((item) => item.id))
  const externalLinkIds = new Set(externalLinkListings.map((item) => item.id))
  assert.deepStrictEqual(
    mockData.getListings({ publicGuest: true, area: PRIVATE_CONTACT_ID }).filter((item) => contactIds.has(item.id)),
    [],
    'Mock 列表不得把私联 ID 变成位置搜索 oracle'
  )
  assert.deepStrictEqual(
    (mockData.matchListings({ publicGuest: true, area: PRIVATE_CONTACT_ID }).listings || []).filter((item) => contactIds.has(item.id)),
    [],
    'Mock 简易匹配不得把私联 ID 变成搜索 oracle'
  )
  ;[PRIVATE_CONTACT_ID, 'douyin.com', 'xdstore.cn', 'synthetic-store.cn'].forEach((probe) => {
    assert.deepStrictEqual(
      mockData.getListings({ publicGuest: true, area: probe }).filter((item) => externalLinkIds.has(item.id)),
      [],
      `Mock 列表不得把外链 ${probe} 变成位置搜索 oracle`
    )
    assert.deepStrictEqual(
      (mockData.matchListings({ publicGuest: true, area: probe }).listings || []).filter((item) => externalLinkIds.has(item.id)),
      [],
      `Mock 简易匹配不得把外链 ${probe} 变成搜索 oracle`
    )
  })
  mockData.loginByPhone('13800010004')
  const companyExternalLink = mockData.addNormalListing({
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '公司公开板块 xdstore.cn/privateid 近地铁',
    community: 'Mock Company External Boundary',
    communityName: 'Mock Company External Boundary',
    building: '1',
    roomNumber: '888',
    rent: 3200,
    layout: '两室1厅1卫',
    rentMode: '整租',
    features: ['电梯'],
    companyListing: true,
    isCompanyListing: true,
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    landlordCommissionPercent: 50
  })
  const companyExternalRow = mockData.getListings({ publicGuest: true }).find((item) => item.id === companyExternalLink.id)
  assert.ok(companyExternalRow && String(companyExternalRow.block || '').includes('公司公开板块'), 'Mock 公司房源必须保留公开板块文案')
  assert.ok(!JSON.stringify(companyExternalRow).includes('xdstore.cn') && !JSON.stringify(companyExternalRow).includes(PRIVATE_CONTACT_ID), 'Mock 公司房源自由文本也只能保留统一联系通道')
  assertLegalEnglishCopy(mockData.getListingDetail(legal.id), 'Mock 详情')
}

assertProductionProjection()
assertMockProjection()
console.log('public-listing-copy-boundary-v1-test passed')
