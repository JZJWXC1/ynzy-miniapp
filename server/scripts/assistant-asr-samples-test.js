const assistantService = require('../src/assistant-service')
const { containsSensitiveText } = require('../src/assistant/safety')

const now = new Date().toLocaleString('zh-CN', { hour12: false })

function listing(id, data) {
  return {
    id,
    title: `杭州${data.area}${data.community}1栋1单元101室 · ${data.layout}`,
    shortTitle: data.community,
    uploaderId: 'U001',
    rent: data.rent,
    layout: data.layout,
    city: '杭州',
    district: data.area,
    area: data.area,
    block: data.block || data.area,
    community: data.community,
    building: '1栋',
    unit: '1单元',
    roomNumber: '101',
    address: `杭州${data.area}${data.community}1栋1单元101室`,
    landlordPhone: '13900000001',
    commissionRate: 20,
    videoUrl: `https://example.com/${id}.mp4?OSSAccessKeyId=ak&Signature=raw`,
    videoKey: `${id}.mp4`,
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: data.rentMode || '整租',
    rentMode: data.rentMode || '整租',
    room: data.room || '',
    hall: data.hall || '',
    bath: data.bath || '',
    features: data.features || [],
    source: '普通上传',
    companyListing: false,
    isCompanyListing: false,
    noCommission: false,
    mapLatitude: data.mapLatitude || 30.28,
    mapLongitude: data.mapLongitude || 120.18,
    coordinateSource: 'community-coordinate',
    coordinateVerified: true,
    createdAt: now,
    lastVerifiedAt: now
  }
}

function makeDb() {
  return {
    currentUserId: 'U001',
    users: [
      { id: 'U001', name: '测试中介', phone: '13800010001', role: '中介', authed: '手机号登录' }
    ],
    listingMaintenanceRule: { enabled: false, remindDays: [3, 5], expireDays: 15 },
    listings: [
      listing('L001', { area: '滨江', block: '西兴', community: '春波南苑', rent: 3900, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['燃气', '近地铁', '电梯'] }),
      listing('L002', { area: '滨江', block: '长河', community: '长河雅苑', rent: 4800, layout: '整租三室一厅一卫', rentMode: '整租', room: '三室', features: ['带阳台', '燃气', '朝南'] }),
      listing('L003', { area: '滨江', block: '浦沿', community: '浦沿新苑', rent: 3600, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['近地铁', '电梯'] }),
      listing('L004', { area: '拱墅', block: '东新', community: '东新园', rent: 2800, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['近地铁', '带阳台', '电梯'] }),
      listing('L005', { area: '西湖', block: '古荡', community: '古荡新村', rent: 2200, layout: '合租单间', rentMode: '合租', room: '单间', features: ['独卫', '近地铁'] }),
      listing('L006', { area: '上城', block: '近江', community: '近江家园', rent: 3000, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['朝南', '电梯'] }),
      listing('L007', { area: '钱塘', block: '下沙', community: '金沙湖公寓', rent: 2600, layout: '整租一室一厅一卫', rentMode: '整租', room: '一室', features: ['免押金', '近地铁'] }),
      listing('L008', { area: '萧山', block: '建设路', community: '建设家园', rent: 3200, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['电梯', '近地铁'] }),
      listing('L009', { area: '拱墅', block: '武林', community: '长木新村', rent: 3700, layout: '整租两室一厅一卫', rentMode: '整租', room: '两室', features: ['带阳台', '燃气'] })
    ],
    footprints: []
  }
}

const samples = [
  '客户想住彬江，四千左右，两房，最好离地帖近一点',
  '帮我找个西胡古当的单见，二千五以内，要独位',
  '拱树东新那边一事一厅，三千内，最好有羊台',
  '钱唐下沙找一套一室，二千六上下，免压金优先',
  '上成近江，客户女生住，三千左右，一室，电提房',
  '萧山建设路两房，三千二以内，近地贴，能看视频的',
  '滨江普沿一房，预算三千六，电题近地铁都可以',
  '武林附近两室，客户预算三千七，必须有阳台和燃汽',
  '有没有长河那块三房，五千以内，朝男，带阳台',
  '客户说不要太贵，想合祖单间，西湖附近，最好独卫',
  '客户想住春播南院，四千以内，两房，近地铁',
  '长禾亚苑三房，五千左右，朝男带羊台',
  '金沙胡公寓一事，二千七以内，免压金',
  '近姜家园一房，三千以内，电提朝男'
]

async function main() {
  assistantService._internal.threadStore._internal.resetForTest()
  const db = makeDb()
  const rows = []
  for (let index = 0; index < samples.length; index += 1) {
    const text = samples[index]
    const result = await assistantService.chat(db, { text }, { userId: 'U001' })
    rows.push({
      index: index + 1,
      text,
      intent: result.intent,
      area: result.need && result.need.area,
      community: result.need && result.need.community,
      budget: result.need && (result.need.maxBudget || result.need.budget),
      layout: result.need && result.need.layout,
      features: result.need && result.need.features,
      normalizedText: result.need && result.need.rawText,
      nextQuestion: result.nextQuestion || '',
      listingCount: (result.listings || []).length,
      listingIds: (result.listings || []).map((item) => item.id),
      reply: result.reply,
      safe: !containsSensitiveText(result)
    })
  }

  rows.forEach((row) => {
    console.log(`#${row.index} ${row.text}`)
    console.log(`  intent=${row.intent}; area=${row.area || '-'}; community=${row.community || '-'}; budget=${row.budget || '-'}; layout=${row.layout || '-'}; features=${(row.features || []).join('、') || '-'}; listings=${row.listingIds.join(',') || '-'}; next=${row.nextQuestion || '-'}; safe=${row.safe ? '是' : '否'}`)
    console.log(`  normalized=${row.normalizedText || '-'}`)
    console.log(`  reply=${row.reply}`)
  })

  const rentalIntentCount = rows.filter((row) => row.intent === 'rental_match').length
  const usefulCount = rows.filter((row) => row.intent === 'rental_match' && row.safe && (row.listingCount > 0 || row.nextQuestion)).length
  const withListingCount = rows.filter((row) => row.listingCount > 0).length
  console.log(`SUMMARY rentalIntent=${rentalIntentCount}/${samples.length} useful=${usefulCount}/${samples.length} withListings=${withListingCount}/${samples.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
