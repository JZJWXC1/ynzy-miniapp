let pendingState = null

function cloneState(value) {
  if (!value || typeof value !== 'object') return null
  return JSON.parse(JSON.stringify(value))
}

function saveAssistantMapReturnState(state) {
  const snapshot = cloneState(state)
  pendingState = snapshot && String(snapshot.sessionKey || '') ? snapshot : null
}

function restoreAssistantMapReturnState(sessionKey) {
  if (!pendingState) return null
  const snapshot = pendingState
  pendingState = null
  if (String(snapshot.sessionKey || '') !== String(sessionKey || '')) return null
  return cloneState(snapshot)
}

module.exports = {
  saveAssistantMapReturnState,
  restoreAssistantMapReturnState
}
