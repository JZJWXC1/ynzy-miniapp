const crypto = require('crypto')
const fs = require('fs')
const config = require('./config')

const payApiBase = 'https://api.mch.weixin.qq.com'

function requiredMissing() {
  const missing = []
  if (!config.wechatPay.appId) missing.push('WECHAT_APP_ID')
  if (!config.wechatPay.appSecret) missing.push('WECHAT_APP_SECRET')
  if (!config.wechatPay.mchId) missing.push('WECHAT_PAY_MCH_ID')
  if (!config.wechatPay.apiV3Key) missing.push('WECHAT_PAY_API_V3_KEY')
  if (!config.wechatPay.certSerialNo) missing.push('WECHAT_PAY_CERT_SERIAL_NO')
  if (!config.wechatPay.privateKeyPath) missing.push('WECHAT_PAY_PRIVATE_KEY_PATH')
  const hasWechatPayPublicKey = config.wechatPay.publicKeyPath
  const hasPlatformCert = config.wechatPay.platformCertPath
  if (!hasWechatPayPublicKey && !hasPlatformCert) {
    if (!config.wechatPay.publicKeyPath) missing.push('WECHAT_PAY_PUBLIC_KEY_PATH')
  }
  if (!config.wechatPay.notifyUrl) missing.push('WECHAT_PAY_NOTIFY_URL')
  return missing
}

function signingMissing() {
  const missing = []
  if (!config.wechatPay.mchId) missing.push('WECHAT_PAY_MCH_ID')
  if (!config.wechatPay.certSerialNo) missing.push('WECHAT_PAY_CERT_SERIAL_NO')
  if (!config.wechatPay.privateKeyPath) missing.push('WECHAT_PAY_PRIVATE_KEY_PATH')
  return missing
}

function isConfigured() {
  return config.wechatPay.enabled && requiredMissing().length === 0
}

function assertConfigured() {
  if (!config.wechatPay.enabled) {
    const error = new Error('当前未启用微信支付充值')
    error.statusCode = 503
    throw error
  }
  const missing = requiredMissing()
  if (missing.length) {
    const error = new Error(`微信支付参数未配置：${missing.join('、')}`)
    error.statusCode = 503
    throw error
  }
}

function assertSigningConfigured() {
  const missing = signingMissing()
  if (missing.length) {
    const error = new Error(`微信支付签名参数未配置：${missing.join('、')}`)
    error.statusCode = 503
    throw error
  }
}

function privateKey() {
  const keyPath = config.wechatPay.privateKeyPath
  if (!keyPath || !fs.existsSync(keyPath)) {
    const error = new Error('微信支付商户私钥文件不存在')
    error.statusCode = 503
    throw error
  }
  return fs.readFileSync(keyPath, 'utf8')
}

function platformCertificate() {
  const certPath = config.wechatPay.platformCertPath
  if (!certPath || !fs.existsSync(certPath)) {
    const error = new Error('微信支付平台证书文件不存在')
    error.statusCode = 503
    throw error
  }
  return fs.readFileSync(certPath, 'utf8')
}

function wechatPayVerifyKey() {
  const publicKeyPath = config.wechatPay.publicKeyPath
  if (publicKeyPath) {
    if (!fs.existsSync(publicKeyPath)) {
      const error = new Error('WECHAT_PAY_PUBLIC_KEY_PATH file not found')
      error.statusCode = 503
      throw error
    }
    return fs.readFileSync(publicKeyPath, 'utf8')
  }

  return platformCertificate()
}

function nonce() {
  return crypto.randomBytes(16).toString('hex')
}

function sign(message) {
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKey(), 'base64')
}

function authHeader(method, urlPath, bodyText, timestamp, nonceStr) {
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${bodyText}\n`
  const signature = sign(message)
  return [
    'WECHATPAY2-SHA256-RSA2048',
    `mchid="${config.wechatPay.mchId}"`,
    `nonce_str="${nonceStr}"`,
    `signature="${signature}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.wechatPay.certSerialNo}"`
  ].join(',')
}

function buildRequestPaymentParams(prepayId) {
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = nonce()
  const packageValue = `prepay_id=${prepayId}`
  const paySign = sign(`${config.wechatPay.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`)
  return {
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign
  }
}

async function createJsapiOrder({ outTradeNo, amountFen, description, openid }) {
  assertConfigured()
  if (!openid) {
    const error = new Error('缺少微信 openid，无法发起 JSAPI 支付')
    error.statusCode = 400
    throw error
  }

  const urlPath = '/v3/pay/transactions/jsapi'
  const body = {
    appid: config.wechatPay.appId,
    mchid: config.wechatPay.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: config.wechatPay.notifyUrl,
    amount: {
      total: amountFen,
      currency: 'CNY'
    },
    payer: {
      openid
    }
  }
  const bodyText = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = nonce()
  const response = await fetch(`${payApiBase}${urlPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader('POST', urlPath, bodyText, timestamp, nonceStr)
    },
    body: bodyText
  })

  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.prepay_id) {
    const error = new Error(result.message || `微信支付下单失败：${response.status}`)
    error.statusCode = response.status || 502
    throw error
  }

  return {
    prepayId: result.prepay_id,
    paymentParams: buildRequestPaymentParams(result.prepay_id)
  }
}

async function queryJsapiOrder(outTradeNo) {
  assertSigningConfigured()
  if (!outTradeNo) {
    const error = new Error('缺少微信支付商户订单号')
    error.statusCode = 400
    throw error
  }

  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.wechatPay.mchId)}`
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = nonce()
  const response = await fetch(`${payApiBase}${urlPath}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader('GET', urlPath, '', timestamp, nonceStr)
    }
  })

  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.message || `微信支付查单失败：${response.status}`)
    error.statusCode = response.status || 502
    throw error
  }
  return result
}

function decryptNotifyResource(resource = {}) {
  const key = Buffer.from(config.wechatPay.apiV3Key, 'utf8')
  const ciphertext = Buffer.from(resource.ciphertext || '', 'base64')
  const authTag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, resource.nonce)
  decipher.setAuthTag(authTag)
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
  }
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  return JSON.parse(decrypted)
}

function verifyNotifySignature(headers = {}, rawBody = '') {
  const timestamp = headers['wechatpay-timestamp']
  const nonceStr = headers['wechatpay-nonce']
  const signature = headers['wechatpay-signature']
  const serialNo = headers['wechatpay-serial']
  const signatureType = headers['wechatpay-signature-type']

  if (!timestamp || !nonceStr || !signature || !serialNo) {
    const error = new Error('微信支付通知缺少签名头')
    error.statusCode = 401
    throw error
  }
  if (signatureType && signatureType !== 'WECHATPAY2-SHA256-RSA2048') {
    const error = new Error('微信支付通知签名类型不支持')
    error.statusCode = 401
    throw error
  }
  if (config.wechatPay.publicKeyId && serialNo !== config.wechatPay.publicKeyId) {
    const error = new Error('WECHAT_PAY_PUBLIC_KEY_ID mismatch')
    error.statusCode = 401
    throw error
  }
  if (!config.wechatPay.publicKeyId && config.wechatPay.platformCertSerialNo && serialNo !== config.wechatPay.platformCertSerialNo) {
    const error = new Error('微信支付平台证书序列号不匹配')
    error.statusCode = 401
    throw error
  }

  const message = `${timestamp}\n${nonceStr}\n${rawBody}\n`
  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(message)
    .verify(wechatPayVerifyKey(), signature, 'base64')

  if (!verified) {
    const error = new Error('微信支付通知签名验证失败')
    error.statusCode = 401
    throw error
  }
}

module.exports = {
  requiredMissing,
  signingMissing,
  isConfigured,
  createJsapiOrder,
  queryJsapiOrder,
  verifyNotifySignature,
  decryptNotifyResource
}
