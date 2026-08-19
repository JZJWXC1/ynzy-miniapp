'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client'))
const llmServicePath = require.resolve(path.join(repoRoot, 'utils', 'llm-service'))
const mockData = require(path.join(repoRoot, 'utils', 'mock-data'))

let authToken = ''
const calls = []
const authFailures = []
const anonymousRetries = []

global.getApp = () => ({
  globalData: {
    apiConfig: { env: 'mock', baseUrl: '', timeout: 15000 },
    authToken
  }
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function containsAccountContext(value) {
  const accountKeys = new Set([
    'threadId',
    'needId',
    'rentalNeedId',
    'clientNeedId',
    'needTemporary',
    'feedbackMessageId',
    'messageId',
    'userId',
    'viewerId',
    'maintainerId',
    'uploaderId',
    'role',
    'isAdmin'
  ])
  if (Array.isArray(value)) return value.some(containsAccountContext)
  if (!value || typeof value !== 'object') return false
  return Object.keys(value).some((key) => accountKeys.has(key) || containsAccountContext(value[key]))
}

function executeMock(options, requestData) {
  return Promise.resolve().then(() => options.mock(requestData))
}

require.cache[apiClientPath] = {
  id: apiClientPath,
  filename: apiClientPath,
  loaded: true,
  exports: {
    getAuthToken: () => authToken,
    call(options) {
      const record = { options, initialData: clone(options.data || {}), retries: [] }
      calls.push(record)
      return executeMock(options, options.data || {}).catch((error) => {
        authFailures.push(error)
        const method = String(options.method || 'GET').toUpperCase()
        const canRetry = method === 'POST' &&
          options.publicReadAuthFallback === true &&
          options.retryAnonymousOnAuthFailure === true &&
          error && error.statusCode === 401 &&
          error.data && error.data.authFailurePhase === 'pre_execution'
        if (!canRetry) throw error
        authToken = ''
        const anonymousData = options.buildAnonymousRetryData(options.data || {})
        record.retries.push(clone(anonymousData))
        anonymousRetries.push(clone(anonymousData))
        return executeMock(options, anonymousData)
      })
    }
  }
}

delete require.cache[llmServicePath]
const llmService = require(llmServicePath)

const identityPayload = {
  text: '拱墅区 3200 两室，近地铁',
  threadId: 'THREAD-OLD-ACCOUNT',
  needId: 'NEED-OLD-ACCOUNT',
  feedbackMessageId: 'FEEDBACK-OLD-ACCOUNT',
  role: 'admin',
  nested: {
    viewerId: 'USER-OLD-ACCOUNT',
    keep: '公开条件'
  },
  form: {
    budget: 3200,
    area: '拱墅区',
    layout: '两室',
    features: ['近地铁'],
    rentalNeedId: 'RENTAL-NEED-OLD'
  }
}

function resetObservations() {
  calls.length = 0
  authFailures.length = 0
  anonymousRetries.length = 0
}

function assertPreExecutionRetry(label, requestId) {
  assert.strictEqual(calls.length, 1, `${label} 应只发起一个逻辑请求`)
  assert.strictEqual(authFailures.length, 1, `${label} 无效身份必须先稳定抛出一次 401`)
  assert.strictEqual(authFailures[0].statusCode, 401, `${label} 必须使用 401`)
  assert.deepStrictEqual(authFailures[0].data, { authFailurePhase: 'pre_execution' }, `${label} 只能声明执行前鉴权失败`)
  assert.strictEqual(anonymousRetries.length, 1, `${label} pre_execution 401 应且仅应匿名重放一次`)
  assert.strictEqual(containsAccountContext(anonymousRetries[0]), false, `${label} 匿名重放载荷必须递归剥离账号上下文`)
  assert.strictEqual(anonymousRetries[0].nested.keep, '公开条件', `${label} 匿名重放仍须保留公开找房条件`)
  assert.strictEqual(calls[0].options.authFallbackRequestId, requestId, `${label} 必须透传请求级匿名接力标识`)
  assert.ok(!Object.prototype.hasOwnProperty.call(calls[0].initialData, 'authFallbackRequestId'), `${label} 请求级接力标识不得混入业务载荷`)
}

async function main() {
  mockData.loginByPhone('13800010005')

  resetObservations()
  authToken = 'synthetic-forged-llm-token'
  const recognize = await llmService.recognizeRentalNeed(identityPayload, { authFallbackRequestId: 'REQ-RECOGNIZE-001' })
  assertPreExecutionRetry('recognizeRentalNeed', 'REQ-RECOGNIZE-001')
  assert.strictEqual(recognize.need.area, '拱墅区')
  authToken = 'synthetic-forged-llm-token'
  assert.throws(
    () => calls[0].options.mock(calls[0].initialData),
    (error) => error && error.statusCode === 401 && error.data && error.data.authFailurePhase === 'pre_execution',
    'recognize Mock 回调本身必须拒绝非空伪 token'
  )
  authToken = ''
  const recognizeProbe = calls[0].options.mock({ text: '西湖区 4500 一室', stage: 'recognize' })
  assert.strictEqual(recognizeProbe.need.area, '西湖区', 'recognize Mock 回调必须按传入 requestData 重算，不能复用旧闭包')

  resetObservations()
  mockData.loginByPhone('13800010005')
  const revoked = mockData.issueAuthSession('U005')
  mockData.revokeAuthSession(revoked.token)
  authToken = revoked.token
  const originalMatchListings = mockData.matchListings
  let matchBusinessCalls = 0
  mockData.matchListings = (condition) => {
    matchBusinessCalls += 1
    return originalMatchListings(condition)
  }
  try {
    const matched = await llmService.matchRentalNeed(identityPayload, { authFallbackRequestId: 'REQ-MATCH-001' })
    assertPreExecutionRetry('matchRentalNeed', 'REQ-MATCH-001')
    assert.ok(Array.isArray(matched.listings))
    assert.strictEqual(matchBusinessCalls, 1, '撤销 token 的首次鉴权失败不得先执行匹配，匿名重放只执行一次业务')
    authToken = ''
    const matchProbe = calls[0].options.mock({
      confirmed: true,
      stage: 'match',
      form: { budget: 5200, area: '西湖区', layout: '一室', features: [] }
    })
    assert.strictEqual(matchProbe.need.area, '西湖区', 'match Mock 回调必须使用本次 requestData')
    assert.strictEqual(Number(matchProbe.need.maxBudget), 5200, 'match Mock 回调不得保留旧预算闭包')
  } finally {
    mockData.matchListings = originalMatchListings
  }

  resetObservations()
  authToken = 'synthetic-forged-chat-token'
  const chat = await llmService.chatAssistant(identityPayload, { authFallbackRequestId: 'REQ-CHAT-001' })
  assertPreExecutionRetry('chatAssistant', 'REQ-CHAT-001')
  assert.notStrictEqual(chat.threadId, identityPayload.threadId, '匿名 chat 重放不得复活旧账号 threadId')
  assert.ok(!JSON.stringify(chat).includes(identityPayload.needId), '匿名 chat 结果不得夹带旧账号 needId')
  authToken = ''
  const chatProbe = calls[0].options.mock({ text: '滨江区 6800 三室' })
  assert.strictEqual(chatProbe.need.area, '滨江区', 'chat Mock 回调必须使用本次 requestData')

  resetObservations()
  authToken = 'synthetic-forged-feedback-token'
  const feedback = await llmService.submitAssistantFeedback(identityPayload)
  assert.strictEqual(calls.length, 1, 'submitAssistantFeedback 应只发起一个逻辑请求')
  assert.strictEqual(authFailures.length, 1, '反馈伪 token 必须在业务执行前稳定拒绝一次')
  assert.deepStrictEqual(authFailures[0].data, { authFailurePhase: 'pre_execution' })
  assert.strictEqual(anonymousRetries.length, 1, '反馈只允许在执行前 401 后匿名重放一次')
  assert.strictEqual(containsAccountContext(anonymousRetries[0]), false, '反馈匿名重放必须递归剥离账号上下文')
  assert.strictEqual(feedback.status, 'open')

  resetObservations()
  authToken = ''
  await llmService.recognizeRentalNeed({ text: '拱墅区 3000 一室' }, { authFallbackRequestId: { forged: true } })
  assert.ok(!Object.prototype.hasOwnProperty.call(calls[0].options, 'authFallbackRequestId'), '非字符串请求级标识不得透传')

  resetObservations()
  mockData.loginByPhone('13800010005')
  const valid = mockData.issueAuthSession('U005')
  authToken = valid.token
  const realMatchListings = mockData.matchListings
  let postExecutionCalls = 0
  mockData.matchListings = () => {
    postExecutionCalls += 1
    const error = new Error('会话在业务执行后失效')
    error.statusCode = 401
    error.data = { authFailurePhase: 'post_execution' }
    throw error
  }
  try {
    await assert.rejects(
      llmService.matchRentalNeed({ text: '拱墅区 3200 两室' }, { authFallbackRequestId: 'REQ-POST-401' }),
      (error) => error && error.statusCode === 401 && error.data && error.data.authFailurePhase === 'post_execution',
      'post_execution 401 必须原样拒绝，禁止匿名重放或本地兜底'
    )
    assert.strictEqual(postExecutionCalls, 1, 'post_execution 401 不得重复执行匹配业务')
    assert.strictEqual(anonymousRetries.length, 0, 'post_execution 401 不得匿名重放')
  } finally {
    mockData.matchListings = realMatchListings
    mockData.revokeAuthSession(valid.token)
  }

  console.log('llm-service-mock-auth-fallback-v1-test passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
