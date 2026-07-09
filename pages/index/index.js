// index.js
const apiService = require('../../utils/api-service')
const voiceInput = require('../../utils/voice-input')

const pendingListingFiltersKey = 'ynzy_pending_listing_filters'
const listingTabUrl = '/pages/listings/listings'
const snapshotCanvasPadding = 24
const tabBarPages = [
  '/pages/index/index',
  listingTabUrl,
  '/pages/map/map',
  '/pages/profile/profile'
]

function textWeight(value) {
  return String(value || '').split('').reduce((sum, char) => {
    return sum + (/[\u4e00-\u9fa5]/.test(char) ? 2 : 1)
  }, 0)
}

function getSystemPixelRatio() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return info.pixelRatio || 2
  } catch (error) {
    return 2
  }
}

function getSheetRows(snapshot) {
  const rows = (snapshot && snapshot.rows) || []
  const reportedColumnCount = Number((snapshot && snapshot.columnCount) || 0)
  const columnCount = Math.max(1, reportedColumnCount, ...rows.map((row) => (row || []).length))
  return rows.map((row) => {
    const cells = Array.isArray(row) ? row : []
    return Array.from({ length: columnCount }).map((_, index) => String(cells[index] || ''))
  })
}

function hasCellText(row) {
  return (row || []).some((cell) => String(cell || '').trim())
}

function isAreaHeader(value) {
  const text = String(value || '').trim()
  return /^(区域|区|片区|商圈)$/.test(text) || /区域/.test(text)
}

function isCommunityHeader(value) {
  return /小区|楼盘|社区/.test(String(value || '').trim())
}

function isBuildingHeader(value) {
  const text = String(value || '').trim()
  return /^(楼栋|几栋|栋|幢|楼号|幢号|building|buildingNo)$/i.test(text)
}

function isUnitHeader(value) {
  const text = String(value || '').trim()
  return /^(单元|几单元|unit|unitNo)$/i.test(text)
}

function isRoomHeader(value) {
  const text = String(value || '').trim()
  return /^(房号|房间号|门牌号|室号|roomNumber|roomNo|houseNo|doorNo)$/i.test(text)
}

function normalizeRoomPart(value, type) {
  let text = String(value || '').trim().replace(/\s+/g, '')
  if (!text) return ''
  text = text.replace(/[，,。；;:：]/g, '')
  if (type === 'building') {
    return text.replace(/^(第)/, '').replace(/(?:号楼|楼|幢|栋|号)$/g, '')
  }
  if (type === 'unit') {
    return text.replace(/^(第)/, '').replace(/(?:单元)$/g, '')
  }
  return text.replace(/^(第)/, '').replace(/(?:房间|房|室)$/g, '')
}

function parseRoomText(value) {
  const text = String(value || '').trim().replace(/\s+/g, '')
  if (!text) return null
  const dashed = text.split(/[-－—]/).map((item) => item.trim()).filter(Boolean)
  if (dashed.length >= 3) {
    return [
      normalizeRoomPart(dashed[0], 'building'),
      normalizeRoomPart(dashed[1], 'unit'),
      normalizeRoomPart(dashed.slice(2).join('-'), 'room')
    ]
  }
  const matched = text.match(/^(.+?)(?:号楼|楼|幢|栋)(.+?)单元(.+?)(?:房间|房|室)?$/)
  if (!matched) return null
  return [
    normalizeRoomPart(matched[1], 'building'),
    normalizeRoomPart(matched[2], 'unit'),
    normalizeRoomPart(matched[3], 'room')
  ]
}

function formatRoomNumber(building, unit, room) {
  const rawValues = [building, unit, room].map((item) => String(item || '').trim()).filter(Boolean)
  const parsed = parseRoomText(rawValues.join('')) || (rawValues.length === 1 ? parseRoomText(rawValues[0]) : null)
  const parts = parsed || [
    normalizeRoomPart(building, 'building'),
    normalizeRoomPart(unit, 'unit'),
    normalizeRoomPart(room, 'room')
  ]
  return parts.filter(Boolean).join('-')
}

function findHeaderIndex(rows) {
  const index = rows.findIndex((row) => row.some(isAreaHeader) && row.some(isCommunityHeader))
  return index
}

function buildSheetColumnIndexes(header, dataRows, snapshot) {
  const reportedColumnCount = Number((snapshot && snapshot.columnCount) || 0)
  const columnCount = Math.max(
    1,
    reportedColumnCount,
    (header || []).length,
    ...dataRows.map((row) => (row || []).length)
  )
  const indexes = Array.from({ length: columnCount })
    .map((_, index) => index)
    .filter((index) => {
      if (String((header || [])[index] || '').trim()) return true
      return dataRows.some((row) => String((row || [])[index] || '').trim())
    })
  return indexes.length ? indexes : [0]
}

function buildRoomMerge(header) {
  const buildingIndex = header.findIndex(isBuildingHeader)
  const unitIndex = header.findIndex(isUnitHeader)
  const roomIndex = header.findIndex(isRoomHeader)
  if (buildingIndex === -1 || unitIndex === -1 || roomIndex === -1) return null
  const firstIndex = Math.min(buildingIndex, unitIndex, roomIndex)
  return {
    firstIndex,
    buildingIndex,
    unitIndex,
    roomIndex,
    skipped: [buildingIndex, unitIndex, roomIndex].filter((index) => index !== firstIndex)
  }
}

function applyRoomMergeToRow(row, merge, headerRow) {
  if (!merge) return row.slice()
  const skipped = new Set(merge.skipped)
  const next = []
  row.forEach((cell, index) => {
    if (skipped.has(index)) return
    if (index === merge.firstIndex) {
      next.push(headerRow ? '房间号' : formatRoomNumber(row[merge.buildingIndex], row[merge.unitIndex], row[merge.roomIndex]))
      return
    }
    next.push(cell)
  })
  return next
}

const sheetDisplayColumns = [
  { title: '区域', aliases: ['区域', '区', '片区', '商圈', 'district', 'area'], minWidth: 132, maxWidth: 180 },
  { title: '小区', aliases: ['小区', '小区名称', '楼盘', '社区', 'community', 'sourceCommunity'], minWidth: 180, maxWidth: 260 },
  { title: '房号', aliases: ['房号', '房间号', '门牌号', '室号', '房源房号', 'roomNumber', 'roomNo', 'houseNo', 'doorNo'], minWidth: 150, maxWidth: 210 },
  { title: '户型描述', aliases: ['户型描述', '描述', '房源描述', '户型信息', '房源信息', '房源详情', 'layoutDescription', 'description'], minWidth: 420, maxWidth: 620 },
  { title: '户型分类', aliases: ['户型分类', '户型', '格局', '分类', 'category', 'layoutCategory'], minWidth: 170, maxWidth: 230 },
  { title: '押一付一', aliases: ['押一付一', '押一', '月租', '租金', '价格', 'rent', 'price'], minWidth: 140, maxWidth: 180 },
  { title: '押二付一', aliases: ['押二付一', '押二', '押二付一价格', '押二价格'], minWidth: 140, maxWidth: 180 },
  { title: '备注', aliases: ['备注', '说明', '备注说明', '水电', 'note', 'remark'], minWidth: 240, maxWidth: 360 }
]

function normalizeFieldKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[|\s·,，。；;:：/\\_\-（）()【】\[\]{}#号幢栋单元室房]/g, '')
}

function columnIndexByAliases(header, aliases) {
  const keys = (header || []).map((item) => normalizeFieldKey(item))
  return (aliases || []).map(normalizeFieldKey).reduce((matched, alias) => {
    if (matched !== -1 || !alias) return matched
    return keys.findIndex((key) => key && key === alias)
  }, -1)
}

function firstCellByAliases(cells, header, aliases) {
  for (let index = 0; index < (aliases || []).length; index += 1) {
    const colIndex = columnIndexByAliases(header, [aliases[index]])
    if (colIndex >= 0) {
      const value = String(cells[colIndex] || '').trim()
      if (value) return value
    }
  }
  return ''
}

function longestText(values) {
  return (values || []).map((item) => String(item || '').trim()).filter(Boolean).sort((left, right) => textWeight(right) - textWeight(left))[0] || ''
}

function projectSheetRow(cells, header) {
  const building = firstCellByAliases(cells, header, ['楼栋', '几栋', '栋', '幢', '楼号', '幢号', 'building', 'buildingNo'])
  const unit = firstCellByAliases(cells, header, ['单元', '几单元', 'unit', 'unitNo'])
  const room = firstCellByAliases(cells, header, sheetDisplayColumns[2].aliases)
  return sheetDisplayColumns.map((column) => {
    if (column.title === '房号') return formatRoomNumber(building, unit, room)
    if (column.title === '户型描述') {
      return firstCellByAliases(cells, header, column.aliases) ||
        firstCellByAliases(cells, header, ['户型', '格局', 'layout']) ||
        firstCellByAliases(cells, header, ['标题', 'title'])
    }
    if (column.title === '户型分类') {
      return firstCellByAliases(cells, header, column.aliases) ||
        firstCellByAliases(cells, header, ['房间', '室', 'room'])
    }
    return firstCellByAliases(cells, header, column.aliases)
  })
}

function sheetColumnSizing(title) {
  const matched = sheetDisplayColumns.find((column) => {
    return column.title === title || columnIndexByAliases([title], column.aliases) >= 0
  })
  if (matched) return matched
  if (/户型|描述|备注|说明/.test(title)) return { minWidth: 220, maxWidth: 440 }
  if (/密码|联系|电话|微信/.test(title)) return { minWidth: 180, maxWidth: 280 }
  return { minWidth: 132, maxWidth: 240 }
}

function buildColumnWidths(model) {
  const rows = [model.header].concat(model.dataRows.map((row) => row.cells))
  return model.header.map((title, colIndex) => {
    const maxWeight = Math.max(...rows.map((row) => textWeight(row[colIndex])))
    const column = sheetColumnSizing(title)
    return Math.min(column.maxWidth || 260, Math.max(column.minWidth || 132, maxWeight * 10 + 42))
  })
}

function makeSpan(rows, colIndex, keyBuilder) {
  const spans = []
  let current = null
  rows.forEach((row, index) => {
    if (row.isSection) {
      current = null
      return
    }
    const value = row.cells[colIndex] || ''
    const key = keyBuilder ? keyBuilder(row) : value
    if (!value) return
    if (current && current.key === key) {
      current.count += 1
      return
    }
    current = {
      colIndex,
      key,
      value,
      start: index,
      count: 1
    }
    spans.push(current)
  })
  return spans
}

function buildSheetModel(snapshot) {
  const rawRows = getSheetRows(snapshot).filter(hasCellText)
  if (!rawRows.length) {
    return {
      noteRows: [],
      header: ['区域', '小区', '房源信息'],
      dataRows: [],
      listingCount: 0,
      groupColumns: [],
      spans: []
    }
  }

  const headerIndex = findHeaderIndex(rawRows)
  const hasHeader = headerIndex >= 0
  const sourceHeader = hasHeader ? rawRows[headerIndex] : sheetDisplayColumns.map((column) => column.title)
  const sourceDataRows = (hasHeader ? rawRows.slice(headerIndex + 1) : rawRows).filter(hasCellText)
  const columnIndexes = buildSheetColumnIndexes(sourceHeader, sourceDataRows, snapshot)
  const baseHeader = columnIndexes.map((sourceIndex, index) => {
    const text = String(sourceHeader[sourceIndex] || '').trim()
    return text || `字段${index + 1}`
  })
  const header = baseHeader
  const areaCol = header.findIndex(isAreaHeader)
  const communityCol = header.findIndex(isCommunityHeader)
  let lastArea = ''
  let lastCommunity = ''
  const dataRows = sourceDataRows.map((sourceRow) => {
    const cells = columnIndexes.map((sourceIndex) => String(sourceRow[sourceIndex] || '').trim())
    const hasListingValue = cells.some((cell, index) => {
      if (index === areaCol || index === communityCol) return false
      return Boolean(String(cell || '').trim())
    })
    const sectionText = !hasListingValue ? longestText(cells) : ''
    if (sectionText) {
      return {
        area: '',
        community: '',
        cells: Array.from({ length: header.length }).map(() => ''),
        isSection: true,
        sectionText
      }
    }
    if (areaCol >= 0) {
      if (cells[areaCol]) {
        lastArea = cells[areaCol]
        lastCommunity = ''
      } else {
        cells[areaCol] = lastArea
      }
    }
    if (communityCol >= 0) {
      if (cells[communityCol]) {
        lastCommunity = cells[communityCol]
      } else {
        cells[communityCol] = lastCommunity
      }
    }
    return {
      area: areaCol >= 0 ? cells[areaCol] : '',
      community: communityCol >= 0 ? cells[communityCol] : '',
      cells
    }
  }).filter((row) => row.isSection || row.cells.some((cell) => String(cell || '').trim()))

  const groupColumns = [areaCol, communityCol].filter((index) => index >= 0)
  const spans = []
  if (areaCol >= 0) {
    spans.push(...makeSpan(dataRows, areaCol, (row) => row.area))
  }
  if (communityCol >= 0) {
    spans.push(...makeSpan(dataRows, communityCol, (row) => `${row.area}|${row.community}`))
  }

  return {
    noteRows: hasHeader ? rawRows.slice(0, headerIndex).filter(hasCellText) : [],
    header,
    dataRows,
    listingCount: dataRows.filter((row) => !row.isSection).length,
    groupColumns,
    areaCol,
    communityCol,
    spans
  }
}

function buildSnapshotMetrics(snapshot) {
  const model = buildSheetModel(snapshot)
  const widths = buildColumnWidths(model)
  const maxImageWidth = 5200
  const baseWidth = widths.reduce((sum, item) => sum + item, 0) + snapshotCanvasPadding * 2
  const scale = baseWidth > maxImageWidth ? (maxImageWidth - snapshotCanvasPadding * 2) / (baseWidth - snapshotCanvasPadding * 2) : 1
  const columnWidths = widths.map((item) => Math.max(112, Math.floor(item * scale)))
  const headerHeight = 56
  const dataRowHeight = 48
  const noteHeight = model.noteRows.length ? model.noteRows.length * 38 + 10 : 0
  return {
    model,
    columnWidths,
    headerHeight,
    dataRowHeight,
    noteHeight,
    width: Math.max(640, columnWidths.reduce((sum, item) => sum + item, 0) + snapshotCanvasPadding * 2),
    height: 116 + noteHeight + headerHeight + Math.max(1, model.dataRows.length) * dataRowHeight + 54
  }
}

function buildSheetPreview(snapshot) {
  const model = buildSheetModel(snapshot)
  const widths = buildColumnWidths(model)
  const header = model.header.map((title, index) => ({
    id: `h${index}`,
    title,
    width: widths[index] || 150
  }))
  const rows = model.dataRows.slice(0, 9).map((row, rowIndex) => {
    if (row.isSection) {
      return {
        id: `r${rowIndex}`,
        isSection: true,
        sectionText: row.sectionText
      }
    }
    return {
      id: `r${rowIndex}`,
      cells: row.cells.map((text, cellIndex) => ({
        id: `r${rowIndex}c${cellIndex}`,
        text,
        width: widths[cellIndex] || 150,
        strong: cellIndex < 2
      }))
    }
  })
  return {
    header,
    rows,
    tableWidth: widths.reduce((sum, item) => sum + item, 0),
    listingCount: model.listingCount,
    hiddenCount: Math.max(0, model.dataRows.length - rows.length)
  }
}

function fitCellText(text, maxWeight) {
  const source = String(text || '')
  if (textWeight(source) <= maxWeight) return source
  let result = ''
  let weight = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const nextWeight = /[\u4e00-\u9fa5]/.test(char) ? 2 : 1
    if (weight + nextWeight > Math.max(2, maxWeight - 2)) break
    result += char
    weight += nextWeight
  }
  return `${result}…`
}

function splitCellText(text, maxWeight, maxLines = 2) {
  const source = String(text || '').trim()
  if (!source) return ['']
  const lines = []
  let current = ''
  let weight = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const nextWeight = /[\u4e00-\u9fa5]/.test(char) ? 2 : 1
    if (current && weight + nextWeight > maxWeight) {
      lines.push(current)
      current = ''
      weight = 0
      if (lines.length >= maxLines) break
    }
    current += char
    weight += nextWeight
  }
  if (current && lines.length < maxLines) lines.push(current)
  const consumed = lines.join('')
  if (consumed.length < source.length && lines.length) {
    lines[lines.length - 1] = fitCellText(lines[lines.length - 1], Math.max(2, maxWeight - 1))
  }
  return lines.length ? lines : ['']
}

function drawCellText(ctx, text, left, top, width, height, options = {}) {
  const maxWeight = Math.max(4, Math.floor((width - 20) / 9))
  const lines = splitCellText(text, maxWeight, options.maxLines || 2)
  const lineHeight = options.lineHeight || 22
  const startY = top + Math.floor((height - (lines.length - 1) * lineHeight) / 2) + 7
  lines.forEach((line, index) => {
    ctx.fillText(line, left + 10, startY + index * lineHeight)
  })
}

function drawCenteredText(ctx, text, left, top, width, height, maxWeight) {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(fitCellText(text, maxWeight || Math.floor((width - 18) / 9)), left + width / 2, top + height / 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawSheetSnapshot(canvas, snapshot, metrics, pixelRatio) {
  const ctx = canvas.getContext('2d')
  const model = metrics.model
  canvas.width = metrics.width * pixelRatio
  canvas.height = metrics.height * pixelRatio
  ctx.scale(pixelRatio, pixelRatio)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, metrics.width, metrics.height)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, metrics.width, 92)
  ctx.fillStyle = '#153f36'
  ctx.font = '700 28px sans-serif'
  ctx.fillText((snapshot && snapshot.title) || '寓你住一起房源表', snapshotCanvasPadding, 40)
  ctx.fillStyle = '#849a94'
  ctx.font = '400 18px sans-serif'
  ctx.fillText(`实时更新：${(snapshot && snapshot.updatedAt) || '刚刚'}`, snapshotCanvasPadding, 72)

  const tableWidth = metrics.columnWidths.reduce((sum, item) => sum + item, 0)
  const columnLefts = []
  metrics.columnWidths.reduce((left, width) => {
    columnLefts.push(left)
    return left + width
  }, snapshotCanvasPadding)

  let top = 96
  model.noteRows.forEach((row) => {
    ctx.fillStyle = '#ffd966'
    ctx.fillRect(snapshotCanvasPadding, top, tableWidth, 34)
    ctx.strokeStyle = '#8f8f8f'
    ctx.strokeRect(snapshotCanvasPadding, top, tableWidth, 34)
    ctx.fillStyle = '#ff0000'
    ctx.font = '700 16px sans-serif'
    drawCenteredText(ctx, row.filter(Boolean).join('  '), snapshotCanvasPadding, top, tableWidth, 34, Math.floor((tableWidth - 20) / 9))
    top += 38
  })
  if (model.noteRows.length) top += 8

  let left = snapshotCanvasPadding
  ctx.fillStyle = '#ffe699'
  ctx.fillRect(snapshotCanvasPadding, top, tableWidth, metrics.headerHeight)
  model.header.forEach((cell, colIndex) => {
    const width = metrics.columnWidths[colIndex]
    ctx.strokeStyle = '#8f8f8f'
    ctx.strokeRect(left, top, width, metrics.headerHeight)
    ctx.fillStyle = '#222222'
    ctx.font = '700 17px sans-serif'
    drawCenteredText(ctx, cell, left, top, width, metrics.headerHeight, Math.floor((width - 20) / 9))
    left += width
  })

  const dataTop = top + metrics.headerHeight
  model.dataRows.forEach((row, rowIndex) => {
    const rowTop = dataTop + rowIndex * metrics.dataRowHeight
    if (row.isSection) {
      ctx.fillStyle = '#ffd966'
      ctx.fillRect(snapshotCanvasPadding, rowTop, tableWidth, metrics.dataRowHeight)
      ctx.strokeStyle = '#8f8f8f'
      ctx.strokeRect(snapshotCanvasPadding, rowTop, tableWidth, metrics.dataRowHeight)
      ctx.fillStyle = '#ff0000'
      ctx.font = '700 16px sans-serif'
      drawCenteredText(ctx, row.sectionText, snapshotCanvasPadding, rowTop, tableWidth, metrics.dataRowHeight, Math.floor((tableWidth - 20) / 9))
      return
    }
    let rowLeft = snapshotCanvasPadding
    ctx.fillStyle = '#e7e7e7'
    ctx.fillRect(snapshotCanvasPadding, rowTop, tableWidth, metrics.dataRowHeight)
    row.cells.forEach((cell, colIndex) => {
      const width = metrics.columnWidths[colIndex]
      if (model.groupColumns.indexOf(colIndex) !== -1) {
        rowLeft += width
        return
      }
      ctx.strokeStyle = '#a8a8a8'
      ctx.strokeRect(rowLeft, rowTop, width, metrics.dataRowHeight)
      ctx.fillStyle = '#222222'
      ctx.font = '400 15px sans-serif'
      drawCellText(ctx, cell, rowLeft, rowTop, width, metrics.dataRowHeight, { maxLines: colIndex === 3 ? 2 : 1, lineHeight: 18 })
      rowLeft += width
    })
  })

  model.spans.forEach((span) => {
    const spanLeft = columnLefts[span.colIndex]
    const spanTop = dataTop + span.start * metrics.dataRowHeight
    const spanWidth = metrics.columnWidths[span.colIndex]
    const spanHeight = span.count * metrics.dataRowHeight
    const isArea = span.colIndex === model.areaCol
    ctx.fillStyle = isArea ? '#fff2cc' : '#e7e7e7'
    ctx.fillRect(spanLeft, spanTop, spanWidth, spanHeight)
    ctx.strokeStyle = '#a8a8a8'
    ctx.strokeRect(spanLeft, spanTop, spanWidth, spanHeight)
    ctx.fillStyle = isArea ? '#ff0000' : '#222222'
    ctx.font = `${isArea ? '700' : '600'} 15px sans-serif`
    const maxWeight = Math.max(4, Math.floor((spanWidth - 20) / 9))
    drawCenteredText(ctx, span.value, spanLeft, spanTop, spanWidth, spanHeight, maxWeight)
  })

  ctx.fillStyle = '#78918a'
  ctx.font = '400 18px sans-serif'
  ctx.fillText(`已按区域/小区划分：${model.listingCount || 0} 条房源 · ${metrics.columnWidths.length} 列`, snapshotCanvasPadding, metrics.height - 20)
}

Page({
  data: {
    assistantText: '',
    voiceMode: true,
    isVoiceListening: false,
    voiceCancelActive: false,
    voicePhase: '',
    voiceText: '',
    voiceTip: '说出预算、区域、户型和特点',
    categories: [
      { name: '整租', icon: '整', desc: '内部可带看' },
      { name: '合租', icon: '合', desc: '同事共享' },
      { name: '业主房源', icon: '业', desc: '查看会留痕' },
      { name: '公寓', icon: '寓', desc: '视频优先' }
    ],
    quickActions: [
      {
        title: '地图找房',
        desc: '查看分级标注的小区级真实可租房源',
        icon: '图',
        url: '/pages/map/map'
      },
      {
        title: '合作房源',
        desc: '查看公司合作的真实可租房源',
        icon: '合',
        url: '/pages/listings/listings'
      }
    ],
    listings: [],
    companySheetSnapshot: null,
    sheetPreview: null,
    sheetSnapshotImagePath: '',
    sheetSnapshotStatus: '正在同步飞书表格',
    snapshotCanvasWidth: 640,
    snapshotCanvasHeight: 480,
    todayTasks: [],
    visibleTodayTasks: [],
    collapsedTaskCount: 0,
    taskExpanded: false,
    taskFoldText: '展开其他任务',
    taskFoldMeta: '',
    maintenanceWorkbench: {
      count: 0,
      unit: '套',
      foldedText: '0 项已折叠'
    },
    taskSummary: {
      pendingCount: 0,
      updatedAt: ''
    },
    taskLoading: false,
    workbench: [
      { title: '实名查看留痕', value: '地址和电话查看同步上传人和管理员' },
      { title: '分佣规则', value: '签单后按当前分佣配置结算' },
      { title: '视频房源', value: '普通房源上传只允许视频' },
      { title: '房态维护', value: '第3天提醒，第5天再次提醒，第7天未更新失效' }
    ]
  },

  onLoad() {
    this.initVoiceInput();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    // 节流：任务与飞书快照 60 秒内切回首页不重复拉取（快照还伴随 canvas 重绘，开销大）
    const now = Date.now();
    if (!this._heavyLoadedAt || now - this._heavyLoadedAt > 60000) {
      this._heavyLoadedAt = now;
      this.loadTodayTasks();
      this.loadCompanySheetSnapshot();
    }
    apiService.getHomeListings().then((listings) => {
      this.setData({ listings })
    }).catch(() => {
      wx.showToast({ title: '首页房源加载失败', icon: 'none' })
    });
  },

  onHide() {
    this.cleanupVoiceInput();
  },

  onUnload() {
    this.cleanupVoiceInput();
  },

  cleanupVoiceInput() {
    const controller = this.voiceController;
    if (!controller) return;
    const busy = typeof controller.isBusy === 'function' ? controller.isBusy() : this.data.isVoiceListening;
    if (busy && typeof controller.cancel === 'function') {
      controller.cancel();
    } else if (busy && typeof controller.stop === 'function') {
      controller.stop();
    } else if (typeof controller.release === 'function') {
      controller.release();
    }
    if (this.data.isVoiceListening) {
      this.setData({ isVoiceListening: false });
    }
  },

  ensureVoiceInput() {
    if (!this.voiceController || (typeof this.voiceController.isErrored === 'function' && this.voiceController.isErrored())) {
      this.initVoiceInput();
    }
    return this.voiceController;
  },

  initVoiceInput() {
    if (this.voiceController && typeof this.voiceController.release === 'function') {
      this.voiceController.release();
    }
    this.voiceController = voiceInput.createController({
      onStart: () => {
        this.lastVoiceRecognizedText = '';
        this.setData({
          isVoiceListening: true,
          voicePhase: 'recording',
          voiceCancelActive: false,
          voiceText: '',
          voiceTip: '正在听，请说出租客需求'
        });
        // 极快点按/慢启动：start 回调晚于 touchend，用户已松手 → 静默丢弃本次（cancel 不走 2.2s 空转与「没有识别到内容」，也避免误触凭杂音帧自动匹配）。
        if (this.voicePressing === false && this.voiceController) {
          try { this.voiceController.cancel(); } catch (error) {}
        }
      },
      onRecognize: (text) => {
        const recognizedText = String(text || '').trim();
        if (recognizedText) this.lastVoiceRecognizedText = recognizedText;
        // 录音中实时字幕只更新浮层，松开确认后再填入框并搜索（仿微信按住说话）。
        this.setData({ voiceText: text });
      },
      onTranscribing: () => {
        if (this.data.voicePhase === 'recording') this.setData({ voicePhase: 'transcribing' });
      },
      onStop: (text) => {
        const content = String(text || this.lastVoiceRecognizedText || '').trim();
        this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false });
        if (!content) {
          wx.showToast({ title: '没有识别到内容', icon: 'none' });
          return;
        }
        this.lastVoiceRecognizedText = '';
        this.applyVoiceText(content, true);
      },
      onCancel: () => {
        this.lastVoiceRecognizedText = '';
        this.setData({
          isVoiceListening: false,
          voicePhase: '',
          voiceCancelActive: false,
          voiceText: '',
          voiceTip: '说出预算、区域、户型和特点'
        });
      },
      onError: (error) => {
        this.setData({
          isVoiceListening: false,
          voicePhase: '',
          voiceCancelActive: false,
          voiceText: '',
          voiceTip: '语音识别失败，请重试或手动输入'
        });
        wx.showToast({ title: voiceInput.errorMessage(error, '语音识别失败'), icon: 'none' });
      }
    });
  },

  loadCompanySheetSnapshot() {
    this.setData({ sheetSnapshotStatus: '正在同步飞书表格' });
    apiService.getCompanySheetSnapshot().then((snapshot) => {
      const metrics = buildSnapshotMetrics(snapshot);
      const sheetPreview = buildSheetPreview(snapshot);
      this.setData({
        companySheetSnapshot: snapshot,
        sheetPreview,
        sheetSnapshotImagePath: '',
        sheetSnapshotStatus: snapshot && snapshot.rows && snapshot.rows.length ? '正在生成截图' : '飞书表格暂无内容',
        snapshotCanvasWidth: metrics.width,
        snapshotCanvasHeight: metrics.height
      }, () => this.renderCompanySheetSnapshot(metrics));
    }).catch(() => {
      this.setData({
        companySheetSnapshot: null,
        sheetPreview: null,
        sheetSnapshotImagePath: '',
        sheetSnapshotStatus: '飞书表格截图加载失败'
      });
      wx.showToast({ title: '飞书表格加载失败', icon: 'none' });
    });
  },

  renderCompanySheetSnapshot(metrics) {
    const snapshot = this.data.companySheetSnapshot;
    if (!snapshot || !snapshot.rows || !snapshot.rows.length) return;
    wx.createSelectorQuery()
      .in(this)
      .select('#companySheetCanvas')
      .fields({ node: true, size: true })
      .exec((result) => {
        const canvas = result && result[0] && result[0].node;
        if (!canvas) {
          this.setData({ sheetSnapshotStatus: '当前环境暂不支持生成截图' });
          return;
        }
        const pixelRatio = Math.min(getSystemPixelRatio(), 2);
        drawSheetSnapshot(canvas, snapshot, metrics, pixelRatio);
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'png',
          width: metrics.width,
          height: metrics.height,
          destWidth: metrics.width * pixelRatio,
          destHeight: metrics.height * pixelRatio,
          success: (res) => {
            this.setData({
              sheetSnapshotImagePath: res.tempFilePath,
              sheetSnapshotStatus: ''
            });
          },
          fail: () => {
            this.setData({ sheetSnapshotStatus: '截图生成失败，请下拉刷新重试' });
          }
        }, this);
      });
  },

  ensureSheetSnapshotImage() {
    if (this.data.sheetSnapshotImagePath) return true;
    wx.showToast({ title: this.data.sheetSnapshotStatus || '截图正在生成', icon: 'none' });
    return false;
  },

  previewCompanySheetSnapshot() {
    if (!this.ensureSheetSnapshotImage()) return;
    wx.previewImage({
      current: this.data.sheetSnapshotImagePath,
      urls: [this.data.sheetSnapshotImagePath]
    });
  },

  shareCompanySheetSnapshot() {
    if (!this.ensureSheetSnapshotImage()) return;
    if (!wx.showShareImageMenu) {
      wx.showToast({ title: '当前微信版本暂不支持转发图片', icon: 'none' });
      return;
    }
    wx.showShareImageMenu({
      path: this.data.sheetSnapshotImagePath,
      fail: () => {
        wx.showToast({ title: '图片转发未完成', icon: 'none' });
      }
    });
  },

  saveCompanySheetSnapshot() {
    if (!this.ensureSheetSnapshotImage()) return;
    wx.saveImageToPhotosAlbum({
      filePath: this.data.sheetSnapshotImagePath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (error) => {
        const message = error && error.errMsg ? error.errMsg : '';
        if (/auth|authorize|permission/i.test(message)) {
          wx.showModal({
            title: '需要相册权限',
            content: '请允许保存图片到相册后再下载。',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm && wx.openSetting) wx.openSetting({});
            }
          });
          return;
        }
        wx.showToast({ title: '图片保存失败', icon: 'none' });
      }
    });
  },

  loadTodayTasks() {
    this.setData({ taskLoading: true });
    apiService.getTodayTasks().then((result) => {
      const todayTasks = (result && result.tasks) || [];
      this.setData({
        taskLoading: false,
        todayTasks,
        taskSummary: (result && result.summary) || { pendingCount: 0, updatedAt: '' },
        ...this.buildTaskView(todayTasks, this.data.taskExpanded)
      });
    }).catch(() => {
      this.setData({ taskLoading: false });
      wx.showToast({ title: '今日任务加载失败', icon: 'none' });
    });
  },

  buildTaskView(tasks, expanded) {
    const taskList = tasks || [];
    const primaryTypes = ['maintenance'];
    let primaryTasks = taskList.filter((item) => primaryTypes.includes(item.type));
    if (!primaryTasks.length) primaryTasks = taskList.slice(0, 1);
    const primaryKeys = new Set(primaryTasks.map((item) => item.type || item.title));
    const foldedTasks = taskList.filter((item) => !primaryKeys.has(item.type || item.title));
    const collapsedTaskCount = foldedTasks.length;
    const maintenanceTask = primaryTasks[0] || {};
    return {
      visibleTodayTasks: expanded ? taskList : primaryTasks,
      collapsedTaskCount,
      taskFoldText: expanded ? '收起工作台任务' : '展开工作台任务',
      taskFoldMeta: expanded ? '已显示全部' : `${collapsedTaskCount} 项已折叠`,
      maintenanceWorkbench: {
        count: maintenanceTask.count || 0,
        unit: maintenanceTask.unit || '套',
        foldedText: collapsedTaskCount ? `${collapsedTaskCount} 项已折叠` : '暂无折叠任务'
      }
    };
  },

  toggleTaskFold() {
    const taskExpanded = !this.data.taskExpanded;
    this.setData({
      taskExpanded,
      ...this.buildTaskView(this.data.todayTasks, taskExpanded)
    });
  },

  // 语音/键盘切换（仿微信）：录音/识别中不切换。
  toggleVoiceMode() {
    if (this.data.voicePhase) return;
    const nextVoice = !this.data.voiceMode;
    if (nextVoice && wx.hideKeyboard) {
      try { wx.hideKeyboard(); } catch (error) {}
    }
    this.setData({ voiceMode: nextVoice });
  },

  // 按住说话：按下开始录音
  onVoiceTouchStart(event) {
    const controller = this.ensureVoiceInput();
    if (!controller) {
      const message = (voiceInput.getSupportStatus && voiceInput.getSupportStatus().message) || '当前环境暂不支持语音输入';
      wx.showToast({ title: message, icon: 'none' });
      return;
    }
    // 上一句仍在录音/识别收尾（FINAL_WAIT 窗口）时忽略新的按下，避免震动+清屏假象与串句自动提交。
    if (this.data.voicePhase || (typeof controller.isBusy === 'function' && controller.isBusy())) return;
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]) || {};
    this.voiceStartY = Number(touch.clientY || touch.pageY || 0);
    this.voicePressing = true;
    this.lastVoiceRecognizedText = '';
    this.setData({ voiceCancelActive: false, voiceText: '' });
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: 'light' }); } catch (error) {}
    }
    try {
      controller.start();
    } catch (error) {
      this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false });
      wx.showToast({ title: voiceInput.errorMessage(error, '语音输入启动失败'), icon: 'none' });
    }
  },

  // 按住说话：上滑超过阈值进入「取消发送」态
  onVoiceTouchMove(event) {
    if (this.data.voicePhase !== 'recording') return;
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]) || {};
    const y = Number(touch.clientY || touch.pageY || 0);
    const slideUp = (this.voiceStartY - y) > 80;
    if (slideUp !== this.data.voiceCancelActive) this.setData({ voiceCancelActive: slideUp });
  },

  // 按住说话：松开——取消态则丢弃，否则停止录音并发送识别结果
  onVoiceTouchEnd() {
    this.voicePressing = false;
    const controller = this.voiceController;
    if (!controller) {
      this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false });
      return;
    }
    if (this.data.voiceCancelActive) {
      controller.cancel();
      return;
    }
    // 已在录音则停止发送；若极快点按（start 回调还没来）由 onStart 里的 voicePressing 守卫收尾。
    if (this.data.voicePhase === 'recording') {
      try { controller.stop(); } catch (error) { controller.cancel(); }
    }
  },

  onVoiceTouchCancel() {
    this.voicePressing = false;
    const controller = this.voiceController;
    if (controller) {
      controller.cancel();
    } else {
      this.setData({ isVoiceListening: false, voicePhase: '', voiceCancelActive: false });
    }
  },

  noop() {},

  applyVoiceText(text, shouldMatch) {
    const nextData = {
      assistantText: text,
      voiceText: text,
      voiceTip: '已识别，可继续修改'
    };
    this.setData(nextData, () => {
      if (shouldMatch) this.runTextMatch();
    });
  },

  handleAssistantInput(event) {
    this.setData({
      assistantText: event.detail.value
    });
  },

  runTextMatch() {
    const text = String(this.data.assistantText || '').trim();
    if (!text) {
      wx.showToast({ title: '请输入租客需求', icon: 'none' });
      return;
    }
    const voiceText = String(this.data.voiceText || '').trim();
    wx.navigateTo({
      url: `/pages/match-chat/match-chat?text=${encodeURIComponent(text)}&voiceText=${encodeURIComponent(voiceText)}`,
      fail: () => {
        wx.showToast({ title: '配房客服打开失败', icon: 'none' });
      }
    });
  },

  handleTap(event) {
    const name = event.currentTarget.dataset.name || '功能';
    if (name === '我的工作台') {
      wx.switchTab({
        url: '/pages/profile/profile'
      });
      return;
    }
    wx.showModal({
      title: name,
      content: '该标签用于提示内部协作规则：查看地址和电话会实名留痕，签单后按当前分佣配置结算。',
      showCancel: false
    });
  },

  openPage(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    if (tabBarPages.includes(url)) {
      wx.switchTab({
        url,
        fail: () => {
          wx.showToast({ title: '页面打开失败', icon: 'none' });
        }
      });
      return;
    }
    wx.navigateTo({
      url,
      fail: () => {
        wx.showToast({ title: '页面打开失败', icon: 'none' });
      }
    });
  },

  openTask(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    this.openPage({ currentTarget: { dataset: { url } } });
  },

  openCategory(event) {
    const name = event.currentTarget.dataset.name || '全部';
    const category = name === '全部' ? '全部' : name;
    const filters = {
      category,
      filters: {
        area: '',
        block: '',
        community: '',
        layout: '',
        rentMax: ''
      }
    };
    try {
      wx.setStorageSync(pendingListingFiltersKey, filters);
    } catch (error) {
      wx.showToast({ title: '筛选条件保存失败', icon: 'none' });
      return;
    }
    wx.switchTab({
      url: listingTabUrl,
      fail: () => {
        wx.showToast({ title: '房源页打开失败', icon: 'none' });
      }
    });
  },

  openListing(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '房源不存在或已下架', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/listing-detail/listing-detail?id=${id}`
    });
  },

  // 视频首帧封面加载失败（如 OSS 未开通媒体处理/编码不支持）时清掉该项 coverUrl，退回占位图，避免裂图。
  onCoverError(event) {
    const index = event.currentTarget.dataset.index;
    if (index === undefined || index === null) return;
    this.setData({ [`listings[${index}].coverUrl`]: '' });
  }
})
