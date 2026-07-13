'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..', '..')
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8')

const appJson = JSON.parse(read('app.json'))
const archivedPageManifest = JSON.parse(read('pages/archived-pages.json'))
const archivedPageByPath = new Map(archivedPageManifest.pages.map((item) => [item.path, item]))
assert.ok(!appJson.pages.includes('pages/client-reports/client-reports'), '暂停期间不得注册报备页面')
assert.ok(!appJson.pages.includes('pages/deal-records/deal-records'), '暂停期间不得注册签单页面')
assert.ok(fs.existsSync(path.join(rootDir, 'pages/client-reports/client-reports.js')), '历史报备页面代码应保留归档')
assert.ok(fs.existsSync(path.join(rootDir, 'pages/deal-records/deal-records.js')), '历史签单页面代码应保留归档')

assert.strictEqual(archivedPageByPath.get('pages/client-reports/client-reports').status, 'paused-read-only-history', '报备历史页必须明确标为暂停且只读保留')
assert.strictEqual(archivedPageByPath.get('pages/deal-records/deal-records').status, 'paused-read-only-history', '签单历史页必须明确标为暂停且只读保留')

const activePageSource = appJson.pages.flatMap((pagePath) => ['.js', '.wxml'].map((extension) => `${pagePath}${extension}`))
  .filter((relativePath) => fs.existsSync(path.join(rootDir, relativePath)))
  .map((relativePath) => `${relativePath}\n${read(relativePath)}`)
  .join('\n')
assert.ok(
  !/签单后按当前分佣配置结算|管理员确认签单后|去签单|提交签单/.test(activePageSource),
  '所有已注册页面不得继续引导用户发起或等待已暂停的签单流程'
)
assert.ok(
  !/pages\/(?:client-reports|deal-records)|\b(?:createClientReport|createDealFromReport|registerDeal)\s*\(/.test(activePageSource),
  '所有已注册页面不得通过改文案重新挂回历史报备/签单路径或写方法'
)

const detailWxml = read('pages/listing-detail/listing-detail.wxml')
assert.ok(!/先报备|客户报备|提交签单|startReportDeal|submitClientReport|submitDealFromReport/.test(detailWxml), '详情页不得保留报备/签单入口')
assert.ok(!/sensitivePurpose|purpose-options|need-bind-row/.test(detailWxml), '详情页敏感查看不得再绑定需求或用途')

const profileJs = read('pages/profile/profile.js')
const profileWxml = read('pages/profile/profile.wxml')
assert.ok(!/我的报备|我的签单|client-reports|deal-records/.test(profileJs), '我的页不得保留报备/签单卡片')
assert.ok(!/报备签单|报备和签单|报备、签单/.test(profileWxml), '我的页不得继续引导报备/签单')

const adminHtml = read('admin-web/index.html')
assert.ok(!/confirm-deal-button|confirmAdminDeal/.test(adminHtml), '后台暂停期间不得保留确认签单动作')
assert.ok(/报备与签单.*暂停|报备\/签单.*暂停|功能暂停/.test(adminHtml), '后台历史报备/签单面板必须明确暂停')
assert.ok(/只读/.test(adminHtml), '后台历史报备/签单面板必须明确只读')

const footprintJs = read('pages/footprint/footprint.js')
assert.ok(/filters:\s*\[\s*['"]我的房源被查看['"]\s*,\s*['"]电话查看['"]\s*\]/.test(footprintJs), '足迹页只保留两个业务筛选')
assert.ok(/activeFilter:\s*['"]我的房源被查看['"]/.test(footprintJs), '足迹页默认展示我的房源被查看')

const domainSource = read('server/src/domain.js')
const todayTasksBlock = domainSource.slice(domainSource.indexOf('function todayTasks'), domainSource.indexOf('function groupState'))
assert.ok(!/client-reports|deal-records|待跟进报备|待确认签单/.test(todayTasksBlock), '今日任务不得生成已暂停报备/签单入口')

const apiSource = read('utils/api-service.js')
const fallbackBlock = apiSource.slice(apiSource.indexOf('function buildTodayTasksFromProfile'), apiSource.indexOf('function getApiBase'))
assert.ok(!/client-reports|deal-records|pendingReports|pendingDeals/.test(fallbackBlock), '客户端今日任务兜底不得生成已暂停入口')

console.log('mini-paused-entry-v1-test: ok')
