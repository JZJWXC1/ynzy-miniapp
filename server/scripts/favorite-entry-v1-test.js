'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath))
}

const app = JSON.parse(read('app.json'))
assert.ok((app.pages || []).includes('pages/favorites/favorites'), 'app.json 必须注册我的收藏页')

;[
  'components/favorite-toggle/favorite-toggle.js',
  'components/favorite-toggle/favorite-toggle.json',
  'components/favorite-toggle/favorite-toggle.wxml',
  'components/favorite-toggle/favorite-toggle.wxss',
  'pages/favorites/favorites.js',
  'pages/favorites/favorites.json',
  'pages/favorites/favorites.wxml',
  'pages/favorites/favorites.wxss',
  'utils/favorite-store.js'
].forEach((file) => assert.ok(exists(file), `缺少收藏前端文件 ${file}`))

const componentWxml = read('components/favorite-toggle/favorite-toggle.wxml')
const componentJs = read('components/favorite-toggle/favorite-toggle.js')
assert.ok(/catchtap\s*=\s*["']toggleFavorite["']/.test(componentWxml), '星标必须 catchtap，不能冒泡打开详情')
assert.ok(/disabled\s*=\s*["']\{\{busy\}\}["']/.test(componentWxml), '请求中必须禁用重复点击')
assert.ok(componentJs.includes('favoriteStore'), '星标组件必须统一使用 token 绑定的收藏状态仓库')
assert.ok(componentJs.includes('busy'), '星标组件必须具备并发点击保护')

const favoriteStore = read('utils/favorite-store.js')
assert.ok(!/setStorageSync|removeStorageSync/.test(favoriteStore), '收藏状态不得写入本地存储')
assert.ok(favoriteStore.includes('getAuthToken'), '收藏状态必须与当前 token 绑定')
assert.ok(favoriteStore.includes('getFavoriteIds'), '收藏状态必须从服务端加载')
assert.ok(favoriteStore.includes('setFavorite'), '收藏写入必须走显式目标态接口，不能用 toggle 接口')

const surfaces = [
  ['pages/index/index', '首页推荐', 'listing-id="{{item.id}}"'],
  ['pages/listings/listings', '房源列表', 'listing-id="{{item.id}}"'],
  ['pages/map/map', '地图房源卡', 'listing-id="{{item.id}}"'],
  ['pages/match-chat/match-chat', '找房助手推荐', 'listing-id="{{listing.id}}"'],
  ['pages/listing-detail/listing-detail', '房源详情', 'listing-id="{{listing.id}}"']
]
surfaces.forEach(([base, name, binding]) => {
  const config = JSON.parse(read(`${base}.json`))
  assert.strictEqual(
    config.usingComponents && config.usingComponents['favorite-toggle'],
    '/components/favorite-toggle/favorite-toggle',
    `${name}必须注册共享星标组件`
  )
  const wxml = read(`${base}.wxml`)
  assert.ok(wxml.includes('<favorite-toggle'), `${name}必须渲染星标`)
  assert.ok(wxml.includes(binding), `${name}必须把当前卡片真实房源 id 传给星标`)
})

assert.ok(!read('pages/my-listings/my-listings.wxml').includes('<favorite-toggle'), '我的房源管理卡不得出现星标')

const profile = read('pages/profile/profile.js')
assert.ok(profile.includes("title: '我的收藏'"), '我的页工作台必须新增我的收藏入口')
assert.ok(profile.includes("url: '/pages/favorites/favorites'"), '我的收藏入口路径必须正确')
assert.ok(profile.includes('favoriteCount'), '我的页收藏数量必须来自服务端资料')

const favoritesWxml = read('pages/favorites/favorites.wxml')
const favoritesJs = read('pages/favorites/favorites.js')
assert.ok(favoritesWxml.includes('<listing-filter'), '我的收藏必须复用完整房源筛选组件')
assert.ok(favoritesJs.includes('availabilityOptions'), '我的收藏必须支持可用状态筛选')
assert.ok(favoritesJs.includes('categories'), '我的收藏必须支持公司/业主/二房东来源筛选')
assert.ok(favoritesJs.includes('getFavorites'), '我的收藏筛选必须请求服务端结果')
assert.ok(favoritesWxml.includes('item.isAvailable'), '不可用收藏必须灰态展示')
assert.ok(favoritesWxml.includes('<favorite-toggle'), '不可用收藏仍必须能够取消')

const api = read('utils/api-service.js')
assert.ok(api.includes('function getFavoriteIds'), '客户端 API 必须提供收藏 ID 同步')
assert.ok(api.includes('function getFavorites'), '客户端 API 必须提供服务端筛选列表')
assert.ok(api.includes('function setFavorite'), '客户端 API 必须提供幂等目标态写入')
assert.ok(api.includes("method: desired ? 'PUT' : 'DELETE'"), '收藏接口必须使用 PUT/DELETE 目标态，不得使用 toggle')
const favoriteApiStart = api.indexOf('function getFavoriteIds')
const favoriteApiEnd = api.indexOf('function getProfileState')
assert.ok(favoriteApiStart >= 0 && favoriteApiEnd > favoriteApiStart, '收藏 API 安全扫描切片边界必须有效')
assert.ok(!/userId\s*:|viewerId\s*:|role\s*:|maintainerId\s*:/.test(
  api.slice(favoriteApiStart, favoriteApiEnd)
), '收藏客户端 API 不得提交身份、角色或维护人字段')

console.log('favorite-entry-v1-test passed')
