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
  return runtime.env === 'mock' || !runtime.baseUrl
}

module.exports = {
  DEFAULT_API_CONFIG,
  getRuntimeConfig,
  shouldUseMock,
  mergeConfig
}
