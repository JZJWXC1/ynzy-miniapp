function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== ''
}

function coreFields(need = {}) {
  return {
    budget: Boolean(need.maxBudget || need.minBudget || need.budget),
    location: Boolean(need.area || need.community || need.anchorName),
    layout: Boolean(need.layout || need.rentMode)
  }
}

function coreCount(need = {}) {
  const fields = coreFields(need)
  return Object.keys(fields).filter((key) => fields[key]).length
}

function conflictQuestion(need = {}) {
  const layout = String(need.layout || '')
  const rentMode = String(need.rentMode || '')
  if (layout === '单间' && rentMode === '整租') {
    return '客户是想看合租单间，还是整租一室？'
  }
  return ''
}

function radiusQuestion(need = {}) {
  if (need.searchMode !== 'radius_around_place') return ''
  if (!need.anchorName) return '想围绕哪个地点找房？'
  if (!hasValue(need.radiusKm)) return `是按${need.anchorName}附近几公里内找？`
  return ''
}

function missingCoreQuestion(need = {}) {
  if (coreCount(need) >= 2) return ''
  if (!need.maxBudget && !need.minBudget && !need.budget) return '预算大概多少？'
  if (!need.area && !need.community && !need.anchorName) return '想看哪个区域、小区或地点周边？'
  if (!need.layout && !need.rentMode) return '客户想要几室或单间？'
  return ''
}

function evaluateConfidence(need = {}) {
  const reasons = []
  const conflict = conflictQuestion(need)
  if (conflict) {
    return {
      confidence: 'low',
      reasons: ['租法和户型冲突'],
      nextQuestion: conflict,
      readyToContinue: false
    }
  }

  const radius = radiusQuestion(need)
  if (radius) {
    return {
      confidence: 'low',
      reasons: ['半径找房地点条件不完整'],
      nextQuestion: radius,
      readyToContinue: false
    }
  }

  const missing = missingCoreQuestion(need)
  if (missing) {
    reasons.push('核心找房字段不足')
    return {
      confidence: 'low',
      reasons,
      nextQuestion: missing,
      readyToContinue: false
    }
  }

  if (!need.maxBudget && !need.minBudget && !need.budget) reasons.push('未提供预算')
  if (need.searchMode === 'radius_around_place') reasons.push('地点半径找房')
  if (need.community && !need.area) reasons.push('仅提供小区')

  return {
    confidence: reasons.length ? 'medium' : 'high',
    reasons,
    nextQuestion: '',
    readyToContinue: true
  }
}

module.exports = {
  evaluateConfidence,
  _internal: {
    coreCount,
    coreFields,
    conflictQuestion,
    missingCoreQuestion,
    radiusQuestion
  }
}
