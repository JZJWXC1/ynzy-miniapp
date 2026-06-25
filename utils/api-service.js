const apiClient = require('./api-client')
const mockData = require('./mock-data')
const listingDisplay = require('./listing-display')

function isMissingEndpoint(error) {
  const message = error && error.message ? error.message : ''
  return Boolean(error && (error.statusCode === 404 || message.indexOf('接口不存在') !== -1 || message.indexOf('404') !== -1))
}

function getHomeListings() {
  return apiClient.call({
    path: '/mini/home/listings',
    mock: () => mockData.getHomeListings()
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function buildQuery(params) {
  const query = Object.keys(params || {})
    .filter((key) => params[key] !== undefined && params[key] !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&')
  return query ? `?${query}` : ''
}

function getListings(filter) {
  const query = buildQuery(filter || {})
  return apiClient.call({
    path: `/mini/listings${query}`,
    mock: () => mockData.getListings(filter || {})
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function loginByPhone(phone) {
  return apiClient.call({
    path: '/mini/auth/login',
    method: 'POST',
    data: { phone },
    mock: () => mockData.loginByPhone(phone)
  })
}

function registerUser(form) {
  return apiClient.call({
    path: '/mini/auth/register',
    method: 'POST',
    data: form,
    mock: () => mockData.getCurrentUser()
  })
}

function getCurrentUser() {
  return apiClient.call({
    path: '/mini/auth/me',
    mock: () => mockData.getCurrentUser()
  })
}

function bindWechatOpenid(code) {
  return apiClient.call({
    path: '/mini/auth/wechat-openid',
    method: 'POST',
    data: { code },
    mock: () => mockData.getCurrentUser()
  })
}

function matchListings(condition) {
  return apiClient.call({
    path: '/mini/listings/match',
    method: 'POST',
    data: condition,
    mock: () => mockData.matchListings(condition)
  }).then((result) => Object.assign({}, result, {
    listings: listingDisplay.normalizeListings((result && result.listings) || [])
  }))
}

function getMapPins() {
  return apiClient.call({
    path: '/mini/map/pins',
    mock: () => mockData.getMapPins()
  })
}

function getListingDetail(id) {
  return apiClient.call({
    path: `/mini/listings/${id}`,
    mock: () => mockData.getListingDetail(id)
  }).then((listing) => listingDisplay.normalizeListing(listing))
}

function getListingLogs(id) {
  return apiClient.call({
    path: `/mini/listings/${id}/footprints`,
    mock: () => mockData.getListingLogs(id)
  })
}

function addSensitiveFootprint(listingId, action) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/sensitive-view`,
    method: 'POST',
    data: { action },
    mock: () => mockData.addSensitiveFootprint(listingId, action)
  })
}

function recordShowing(listingId, payload) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/showings`,
    method: 'POST',
    data: payload || {},
    mock: () => mockData.recordShowing(listingId, payload || {})
  }).catch((error) => {
    if (isMissingEndpoint(error)) {
      throw new Error('线上后端还没有水印带看审核接口，请先发布或重启后端服务。')
    }
    throw error
  })
}

function registerDeal(listingId) {
  return apiClient.call({
    path: `/mini/listings/${listingId}/deals`,
    method: 'POST',
    data: {},
    mock: () => ({
      message: '成交已登记'
    })
  })
}

function getFootprintRecords() {
  return apiClient.call({
    path: '/mini/footprints',
    mock: () => mockData.getFootprintRecords()
  })
}

function getOwnedListings() {
  return apiClient.call({
    path: '/mini/my/listings',
    mock: () => mockData.getOwnedListings()
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function verifyMyListing(id) {
  return apiClient.call({
    path: `/mini/my/listings/${id}/verify`,
    method: 'POST',
    data: {},
    mock: () => mockData.verifyMyListing(id)
  }).then((listings) => listingDisplay.normalizeListings(listings))
}

function getEditableListing(id) {
  return apiClient.call({
    path: `/mini/my/listings/${id}`,
    mock: () => mockData.getEditableListing(id)
  })
}

function updateNormalListing(id, form) {
  return apiClient.call({
    path: `/mini/my/listings/${id}`,
    method: 'PUT',
    data: form,
    mock: () => mockData.updateNormalListing(id, form)
  })
}

function getProfileState() {
  return apiClient.call({
    path: '/mini/profile',
    mock: () => mockData.getProfileState()
  })
}

function rechargePoints(points) {
  return apiClient.call({
    path: '/mini/points/recharge',
    method: 'POST',
    data: { points },
    mock: () => mockData.rechargePoints(points)
  })
}

function getCommissionRecords() {
  return apiClient.call({
    path: '/mini/commissions',
    mock: () => []
  })
}

function getGroupState() {
  return apiClient.call({
    path: '/mini/groups',
    mock: () => mockData.getGroupState()
  }).then((state) => listingDisplay.normalizeGroupState(state))
}

function uploadGroupListing(form) {
  return apiClient.call({
    path: '/mini/groups/listings',
    method: 'POST',
    data: form || {},
    mock: () => mockData.uploadGroupListing(form)
  }).then((state) => listingDisplay.normalizeGroupState(state))
}

function createGroupScreenshotUploadPolicy(fileInfo) {
  const info = fileInfo || {}
  return apiClient.call({
    path: '/mini/uploads/group-screenshot-policy',
    method: 'POST',
    data: {
      fileName: info.fileName || 'group-chat.jpg',
      mimeType: info.mimeType || 'image/jpeg',
      size: info.size || 0
    },
    mock: () => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-group-screenshots/${Date.now()}.jpg`,
      fileUrl: info.tempFilePath || '',
      maxSize: 20 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回 OSS 截图直传凭证。'
    })
  })
}

function createShowingPhotoUploadPolicy(fileInfo) {
  const info = fileInfo || {}
  return apiClient.call({
    path: '/mini/uploads/showing-photo-policy',
    method: 'POST',
    data: {
      fileName: info.fileName || 'showing-proof.jpg',
      mimeType: info.mimeType || 'image/jpeg',
      size: info.size || 0
    },
    mock: () => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-showing-photos/${Date.now()}.jpg`,
      fileUrl: info.tempFilePath || '',
      maxSize: 20 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回带看水印照片直传凭证。'
    })
  }).catch((error) => {
    if (!isMissingEndpoint(error)) throw error
    return createGroupScreenshotUploadPolicy({
      fileName: info.fileName || 'showing-proof.jpg',
      mimeType: info.mimeType || 'image/jpeg',
      size: info.size || 0,
      tempFilePath: info.tempFilePath || ''
    }).then((policy) => Object.assign({}, policy, {
      note: '后端带看专用上传接口尚未发布，已临时使用图片上传通道提交水印照片。'
    })).catch(() => {
      throw new Error('线上后端还没有水印照片上传接口，请先发布或重启后端服务。')
    })
  })
}

function createVideoUploadPolicy(fileInfo) {
  const info = fileInfo || {}
  return apiClient.call({
    path: '/mini/uploads/video-policy',
    method: 'POST',
    data: {
      fileName: info.fileName || 'listing-video.mp4',
      mimeType: info.mimeType || 'video/mp4',
      size: info.size || 0
    },
    mock: () => ({
      uploadMode: 'mock',
      uploadUrl: '',
      objectKey: `mock-videos/${Date.now()}.mp4`,
      fileUrl: info.tempFilePath || '',
      maxSize: 300 * 1024 * 1024,
      formData: {},
      note: '本地模拟上传，正式环境由后端返回 OSS 直传凭证。'
    })
  })
}

function uploadVideo(filePath, policy) {
  return uploadOssFile(filePath, policy, '视频上传配置不完整')
}

function uploadGroupScreenshot(filePath, policy) {
  return uploadOssFile(filePath, policy, '截图上传配置不完整')
}

function uploadShowingPhoto(filePath, policy) {
  return uploadOssFile(filePath, policy, '带看照片上传配置不完整')
}

function uploadOssFile(filePath, policy, missingMessage) {
  const uploadPolicy = policy || {}
  if (uploadPolicy.uploadMode === 'mock') {
    return Promise.resolve({
      fileUrl: uploadPolicy.fileUrl || filePath,
      objectKey: uploadPolicy.objectKey || ''
    })
  }

  if (!uploadPolicy.uploadUrl) {
    return Promise.reject(new Error(uploadPolicy.note || missingMessage || '文件上传配置不完整'))
  }

  return apiClient.uploadFile({
    url: uploadPolicy.uploadUrl,
    filePath,
    name: 'file',
    formData: uploadPolicy.formData || {},
    header: uploadPolicy.headers || {},
    mock: () => ({
      fileUrl: uploadPolicy.fileUrl || filePath,
      objectKey: uploadPolicy.objectKey || ''
    })
  }).then(() => ({
    fileUrl: uploadPolicy.fileUrl,
    objectKey: uploadPolicy.objectKey
  }))
}

function unlockGroup(id) {
  return apiClient.call({
    path: `/mini/groups/${id}/unlock`,
    method: 'POST',
    data: {},
    mock: () => mockData.unlockGroup(id)
  }).then((result) => result && result.data
    ? Object.assign({}, result, { data: listingDisplay.normalizeGroupState(result.data) })
    : result)
}

function addNormalListing(form) {
  return apiClient.call({
    path: '/mini/listings',
    method: 'POST',
    data: form,
    mock: () => mockData.addNormalListing(form)
  })
}

module.exports = {
  getHomeListings,
  getListings,
  loginByPhone,
  registerUser,
  getCurrentUser,
  bindWechatOpenid,
  matchListings,
  getMapPins,
  getListingDetail,
  getListingLogs,
  addSensitiveFootprint,
  recordShowing,
  registerDeal,
  getFootprintRecords,
  getOwnedListings,
  verifyMyListing,
  getEditableListing,
  updateNormalListing,
  getProfileState,
  rechargePoints,
  getCommissionRecords,
  getGroupState,
  uploadGroupListing,
  createGroupScreenshotUploadPolicy,
  uploadGroupScreenshot,
  createShowingPhotoUploadPolicy,
  uploadShowingPhoto,
  createVideoUploadPolicy,
  uploadVideo,
  unlockGroup,
  addNormalListing
}
