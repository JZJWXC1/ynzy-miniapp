'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const appConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'))
const mapJs = fs.readFileSync(path.join(repoRoot, 'pages', 'map', 'map.js'), 'utf8')
const mapWxml = fs.readFileSync(path.join(repoRoot, 'pages', 'map', 'map.wxml'), 'utf8')
const detailJs = fs.readFileSync(path.join(repoRoot, 'pages', 'listing-detail', 'listing-detail.js'), 'utf8')

function runtimeJavaScriptFiles(root) {
  const files = []
  fs.readdirSync(root, { withFileTypes: true }).forEach((entry) => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) runtimeJavaScriptFiles(target).forEach((file) => files.push(file))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target)
  })
  return files
}

assert.ok(
  !(appConfig.permission && appConfig.permission['scope.userLocation']),
  '运行配置不得再声明 scope.userLocation'
)
assert.ok(
  !Array.isArray(appConfig.requiredPrivateInfos) || !appConfig.requiredPrivateInfos.includes('getLocation'),
  '运行配置不得再声明 requiredPrivateInfos/getLocation'
)
assert.doesNotMatch(mapJs, /wx\.getLocation/, '地图页不得读取手机实时位置')
assert.doesNotMatch(detailJs, /wx\.getLocation/, '带看水印不得读取手机实时位置')
const runtimeRoots = ['pages', 'components', 'custom-tab-bar', 'utils']
const runtimeSources = [path.join(repoRoot, 'app.js')]
  .concat(runtimeRoots.flatMap((name) => runtimeJavaScriptFiles(path.join(repoRoot, name))))
runtimeSources.forEach((file) => {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /wx\.getLocation/, `运行代码不得读取手机实时位置：${path.relative(repoRoot, file)}`)
})
assert.doesNotMatch(mapWxml, /locateToMe|我的位置/, '地图页不得残留实时定位入口')
assert.match(mapWxml, /bindregionchange="handleRegionChange"/, '地图必须保留用户拖动区域监听')
assert.match(mapWxml, /bindtap="searchCurrentRegion"/, '地图必须保留“搜索当前区域”入口')
assert.match(mapJs, /getRegion\s*\(/, '搜索当前区域必须继续读取用户主动选择的地图范围')
assert.match(detailJs, /房源信息作为位置参考/, '带看水印必须保留房源位置参考兜底')

console.log('location-permission-free-v1-test passed')
