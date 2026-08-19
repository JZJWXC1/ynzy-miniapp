const DEFAULT_API_CONFIG = {
  env: 'mock',
  baseUrl: '',
  timeout: 15000,
  token: '',
  paymentMode: 'manual',
  llm: {
    provider: 'local',
    protocol: 'openai-compatible',
    apiBaseUrl: '',
    model: 'local-match-v1',
    enabled: false
  }
}

function mergeConfig(base, extra) {
  const next = Object.assign({}, base, extra || {})
  next.llm = Object.assign({}, base.llm, (extra && extra.llm) || {})
  return next
}

function getRuntimeConfig() {
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      if (app && app.globalData && app.globalData.apiConfig) {
        return mergeConfig(DEFAULT_API_CONFIG, app.globalData.apiConfig)
      }
    }
  } catch (error) {
    return DEFAULT_API_CONFIG
  }
  return DEFAULT_API_CONFIG
}

function shouldUseMock(config) {
  const runtime = config || getRuntimeConfig()
  // 仅在显式 mock 环境启用本地模拟数据。生产环境即便 baseUrl 误配为空也绝不静默降级到 mock，
  // 否则线上会展示成套假房源/假登录/假分佣（历史“多数据源混用”bug 的结构性根源）；
  // baseUrl 缺失应由请求层报错暴露，而非以假数据蒙混。
  if (runtime.env === 'mock') return true
  if (runtime.env === 'prod') return false
  // 其它/未知环境保持旧的宽松判断（缺 baseUrl 回退 mock），便于本地联调。
  return !runtime.baseUrl
}

module.exports = {
  DEFAULT_API_CONFIG,
  getRuntimeConfig,
  shouldUseMock,
  mergeConfig
}
