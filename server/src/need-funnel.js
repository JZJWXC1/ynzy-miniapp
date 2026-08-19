'use strict'

const FUNNEL_VERSION = 'need-funnel-v1'
const MILESTONE_FIELDS = Object.freeze({
  recommendation: 'firstRecommendedAt',
  l1: 'l1SensitiveViewedAt',
  l2: 'l2ReportedAt',
  showing: 'showingAt',
  l3Submitted: 'l3DealSubmittedAt',
  l3Confirmed: 'l3DealConfirmedAt'
})

function text(value) {
  return String(value || '').trim()
}

function needRows(db) {
  if (Array.isArray(db && db.rentalNeeds)) return db.rentalNeeds
  if (Array.isArray(db && db.clientNeeds)) return db.clientNeeds
  return []
}

function ownedNeed(db, userId, needId) {
  const actor = text(userId)
  const id = text(needId)
  if (!actor || !id) return null
  return needRows(db).find((need) => (
    need &&
    text(need.id) === id &&
    text(need.brokerId) === actor
  )) || null
}

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  const source = text(value)
  if (!source) return null
  const parsed = Date.parse(source)
  return Number.isFinite(parsed) ? parsed : null
}

function isoTime(value) {
  const parsed = timeMs(value)
  return new Date(parsed === null ? Date.now() : parsed).toISOString()
}

function markMilestone(db, userId, needId, stage, at) {
  const field = MILESTONE_FIELDS[stage]
  if (!field) throw new Error(`未知需求漏斗阶段：${stage}`)
  const need = ownedNeed(db, userId, needId)
  if (!need) return null
  const current = need.funnel && typeof need.funnel === 'object' && !Array.isArray(need.funnel)
    ? need.funnel
    : {}
  if (!text(current.version)) current.version = FUNNEL_VERSION
  if (timeMs(current[field]) === null) current[field] = isoTime(at)
  need.funnel = current
  return need
}

function recordRecommendation(db, userId, needId, traceLog) {
  if (!traceLog || typeof traceLog !== 'object') return null
  const id = text(needId)
  const actor = text(userId)
  if (!id || !actor) return null
  if (text(traceLog.feedbackNeedId) !== id || text(traceLog.userId) !== actor) return null
  const hasListing = Array.isArray(traceLog.listings) && traceLog.listings.some((item) => item && text(item.id))
  if (!hasListing) return null
  return markMilestone(db, actor, id, 'recommendation', traceLog.createdAt)
}

function pct(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null
}

function roundOne(value) {
  return Math.round(value * 10) / 10
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  return sorted[Math.min(index, sorted.length - 1)]
}

function median(sorted) {
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function buildNeedIndex(db) {
  const index = new Map()
  for (const need of needRows(db)) {
    const id = text(need && need.id)
    const brokerId = text(need && need.brokerId)
    if (id && brokerId && !index.has(id)) index.set(id, need)
  }
  return index
}

function ownedRowNeed(index, row, actorField) {
  const need = index.get(text(row && row.needId))
  if (!need) return null
  return text(row && row[actorField]) === text(need.brokerId) ? need : null
}

function milestoneSet(index, field) {
  const out = new Set()
  for (const [needId, need] of index.entries()) {
    if (timeMs(need && need.funnel && need.funnel[field]) !== null) out.add(needId)
  }
  return out
}

function addOwnedRows(target, index, rows, actorField, predicate) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const need = ownedRowNeed(index, row, actorField)
    if (need && predicate(row)) target.add(text(need.id))
  }
}

function earliestRecommendationTimes(db, index) {
  const times = new Map()
  for (const [needId, need] of index.entries()) {
    const at = timeMs(need && need.funnel && need.funnel.firstRecommendedAt)
    if (at !== null) times.set(needId, at)
  }
  for (const trace of Array.isArray(db && db.assistantTraceLogs) ? db.assistantTraceLogs : []) {
    const need = ownedRowNeed(index, { ...trace, needId: trace && trace.feedbackNeedId }, 'userId')
    const hasListing = Array.isArray(trace && trace.listings) && trace.listings.some((item) => item && text(item.id))
    const at = timeMs(trace && trace.createdAt)
    if (!need || !hasListing || at === null) continue
    const needId = text(need.id)
    if (!times.has(needId) || at < times.get(needId)) times.set(needId, at)
  }
  return times
}

function computeMetrics(db) {
  const index = buildNeedIndex(db)
  const l1 = milestoneSet(index, MILESTONE_FIELDS.l1)
  const l2 = milestoneSet(index, MILESTONE_FIELDS.l2)
  const showing = milestoneSet(index, MILESTONE_FIELDS.showing)
  const l3Submitted = milestoneSet(index, MILESTONE_FIELDS.l3Submitted)
  const l3Confirmed = milestoneSet(index, MILESTONE_FIELDS.l3Confirmed)

  addOwnedRows(l1, index, db && db.footprints, 'viewerId', (row) => row.action === '查看地址和电话')
  addOwnedRows(l2, index, db && db.clientReports, 'brokerId', () => true)
  addOwnedRows(showing, index, db && db.showingUploads, 'userId', (row) => row.status === '已通过')
  addOwnedRows(showing, index, db && db.footprints, 'viewerId', (row) => row.action === '记录带看' && row.proofStatus === '已通过')
  addOwnedRows(l3Submitted, index, db && db.dealRecords, 'brokerId', () => true)
  addOwnedRows(l3Confirmed, index, db && db.dealRecords, 'brokerId', (row) => row.status === '已确认')

  const showingFromReported = new Set([...showing].filter((needId) => l2.has(needId)))
  const confirmedFromSubmitted = new Set([...l3Confirmed].filter((needId) => l3Submitted.has(needId)))
  const recommendationTimes = earliestRecommendationTimes(db, index)
  const recommendationMinutes = []
  for (const [needId, recommendedAt] of recommendationTimes.entries()) {
    const createdAt = timeMs(index.get(needId) && index.get(needId).createdAt)
    if (createdAt === null || recommendedAt < createdAt) continue
    recommendationMinutes.push((recommendedAt - createdAt) / 60000)
  }
  recommendationMinutes.sort((a, b) => a - b)

  const total = index.size
  return {
    needsTotal: total,
    fillL1_viewPct: pct(l1.size, total),
    fillL2_reportPct: pct(l2.size, total),
    fillL3_dealSubmitPct: pct(l3Submitted.size, total),
    fillL3_dealConfirmedPct: pct(l3Confirmed.size, total),
    firstRecommendationMeasuredCount: recommendationMinutes.length,
    firstEffectiveRecommendationMedianMinutes: recommendationMinutes.length ? roundOne(median(recommendationMinutes)) : null,
    firstEffectiveRecommendationP95Minutes: recommendationMinutes.length ? roundOne(percentile(recommendationMinutes, 0.95)) : null,
    showingRatePct: pct(showingFromReported.size, l2.size),
    dealConfirmationRatePct: pct(confirmedFromSubmitted.size, l3Submitted.size),
    _counts: {
      l1: l1.size,
      l2: l2.size,
      showing: showingFromReported.size,
      l3s: l3Submitted.size,
      l3c: confirmedFromSubmitted.size
    }
  }
}

module.exports = {
  FUNNEL_VERSION,
  MILESTONE_FIELDS,
  ownedNeed,
  markMilestone,
  recordRecommendation,
  computeMetrics,
  _internal: { timeMs, isoTime, buildNeedIndex, earliestRecommendationTimes }
}
