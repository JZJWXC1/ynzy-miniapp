const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  classifyMirrorRunResult,
  runCompanySourceSync
} = require('../src/feishu-source-mirror')
const feishuSync = require('../src/feishu-sync')

function validMirrorResult(overrides = {}) {
  return {
    complete: true,
    published: true,
    failed: 0,
    schemaInvalid: false,
    mirrorIncomplete: false,
    noop: false,
    records: [{
      enabled: true,
      published: true,
      canonical: true,
      district: '拱墅区',
      block: '城北万象城',
      community: '瑷颐湾',
      roomLabel: '瑷颐湾 8幢1单元802'
    }],
    ...overrides
  }
}

function settled(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  )
}

function testFailClosedSyncDefaults() {
  const env = { ...process.env }
  ;[
    'FEISHU_AUTO_SYNC_ENABLED',
    'FEISHU_NOTE_MATERIAL_FIELD_ID',
    'FEISHU_SYNC_CONTROLLER_MODE',
    'FEISHU_APPROVED_SCHEMA_SHA256',
    'FEISHU_APPROVED_RESOURCE_IDENTITY_SHA256'
  ].forEach((name) => { delete env[name] })
  const script = [
    "const config = require('./src/config')",
    'process.stdout.write(JSON.stringify({',
    '  autoSyncEnabled: config.feishu.autoSyncEnabled,',
    '  noteMaterialFieldId: config.feishu.noteMaterialFieldId,',
    '  syncControllerMode: config.feishu.syncControllerMode,',
    '  approvedSchemaSha256: config.feishu.approvedSchemaSha256,',
    '  approvedResourceIdentitySha256: config.feishu.approvedResourceIdentitySha256,',
    '  syncIntervalMinutes: config.feishu.syncIntervalMinutes',
    '}))'
  ].join('\n')
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8'
  })
  assert.strictEqual(child.status, 0, child.stderr || '配置子进程必须成功')
  const actual = JSON.parse(child.stdout)
  assert.strictEqual(actual.autoSyncEnabled, false, '未显式配置时自动同步必须默认关闭')
  assert.strictEqual(actual.noteMaterialFieldId, '', '房源笔记字段 ID 必须来自显式生产配置，不得内置某张表的固定 ID')
  assert.strictEqual(actual.syncControllerMode, '', '未显式批准后台控制器时不得启动自动同步')
  assert.strictEqual(actual.approvedSchemaSha256, '', '字段契约摘要不得由代码伪造默认值')
  assert.strictEqual(actual.approvedResourceIdentitySha256, '', '飞书资源身份摘要不得由代码伪造默认值')
  assert.strictEqual(actual.syncIntervalMinutes, 30, 'V2 自动同步默认时间桶必须固定为半小时')
}

function testIndexWiringContract() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.js'), 'utf8')
  const publicV2Start = source.indexOf("pathname === '/mini/v2/company-sheet-snapshot'")
  const publicV2End = source.indexOf("pathname === '/mini/company-sheet-snapshot'", publicV2Start)
  const publicV2Block = source.slice(publicV2Start, publicV2End)
  assert.ok(publicV2Start >= 0 && publicV2End > publicV2Start, '必须提供固定十列 v2 快照路由')
  assert.ok(publicV2Block.includes('feishuSync.cachedSheetSnapshotV2(db)'), 'v2 公开接口必须只读已提交缓存')
  assert.ok(publicV2Block.includes('feishuSync.unavailableSheetSnapshotV2()'), 'v2 坏缓存或无缓存必须返回可验证 unavailable')
  assert.ok(!/refresh|sync\s*\(/.test(publicV2Block), 'v2 公开 GET 不得联网或触发同步')
  const publicStart = source.indexOf("pathname === '/mini/company-sheet-snapshot'")
  const publicEnd = source.indexOf("pathname === '/mini/listings'", publicStart)
  const publicBlock = source.slice(publicStart, publicEnd)
  assert.ok(publicStart >= 0 && publicEnd > publicStart, '必须定位公开待租快照路由')
  assert.ok(publicBlock.includes('config.feishu.mirrorSyncEnabled'), '镜像模式公开 GET 必须有独立只读分支')
  assert.ok(publicBlock.includes('feishuSync.unavailableSheetSnapshot()'), '镜像无缓存时必须返回固定安全占位')
  assert.ok(publicBlock.indexOf('feishuSync.unavailableSheetSnapshot()') < publicBlock.indexOf('feishuSync.refreshSheetSnapshot'), '镜像分支必须在旧 Sheet 回源之前返回')

  const manualStart = source.indexOf("pathname === '/admin/feishu-sync/run'")
  const manualEnd = source.indexOf("pathname === '/admin/listings'", manualStart)
  const manualBlock = source.slice(manualStart, manualEnd)
  assert.ok(manualStart >= 0 && manualEnd > manualStart, '必须定位手动飞书同步路由')
  assert.ok(
    manualBlock.includes('feishuSync.parseAdminSyncRequest(body, { externalWorkerRequest: true })'),
    '手动同步外部请求只允许 dryRun，任务身份与摘要由服务端生成'
  )
  assert.ok(
    manualBlock.indexOf('feishuSync.parseAdminSyncRequest') < manualBlock.indexOf('feishuSyncWorker.enqueue'),
    '手动同步必须先校验请求，再持久化任务'
  )
  assert.ok(
    manualBlock.includes('actorId: adminAccount.userId || adminAccount.id'),
    '手动同步必须把已认证管理员身份写入后台任务，不能跨进程回退成系统账号'
  )
  assert.ok(manualBlock.includes('startFeishuSyncWorkerProcess(queued.runId)'), 'HTTP 入队后必须交给独立后台进程')
  assert.ok(manualBlock.includes('}, 202)'), '手动同步必须立即返回 202，不能再等待网关超时')
  assert.ok(!manualBlock.includes('await feishuSync.sync'), 'HTTP 路由不得直接执行长同步')
  assert.ok(!source.includes('runScheduledFeishuSync') && !source.includes('startFeishuSyncTimer'), '应用进程内旧定时器必须彻底移除，避免双控制器并发写')
  const workerCli = fs.readFileSync(path.resolve(__dirname, 'run-feishu-sync-worker.js'), 'utf8')
  assert.ok(workerCli.includes("args.mode === 'schedule'"), '独立 worker CLI 必须提供定时入口')
  assert.ok(
    workerCli.includes('feishuSync.automaticWorkerConfigurationStatus().ready'),
    '自动执行必须复用业务层统一门，同时校验 worker-v2、两项批准摘要与正式笔记素材配置'
  )

  const syncSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'feishu-sync.js'), 'utf8')
  assert.ok(
    syncSource.includes('}, { fillMergedCells: false })'),
    '镜像发布 v2 前必须禁用旧表格合并单元格向下补齐'
  )
  const mirrorStart = syncSource.indexOf('async function syncViaMirror')
  const mirrorEnd = syncSource.indexOf('function isCommittableSyncResult', mirrorStart)
  const mirrorBlock = syncSource.slice(mirrorStart, mirrorEnd)
  assert.ok(mirrorBlock.includes('activeFeishuSourceRecordIds(db)'), '镜像同步必须从线上活跃飞书库存生成第二撤下基线')
  assert.ok(mirrorBlock.includes('baselinePublishedSourceIds'), '线上库存撤下基线必须传入专用表写前熔断')
  assert.ok(
    mirrorBlock.includes('activeFeishuFoundationIdentityKeys(db)'),
    'AI 数据底座必须从线上活跃飞书库存生成独立数量下限输入'
  )
  assert.ok(
    mirrorBlock.includes('baselinePublishedFoundationIdentityKeys'),
    'AI 数据底座线上库存数量下限必须传入专用表写前熔断'
  )
  assert.strictEqual(
    (mirrorBlock.match(/baselinePublishedFoundationIdentityKeys/g) || []).length,
    4,
    '线上库存数量下限必须覆盖生成、内容计划预演、安全摘要预演和正式镜像四处接线'
  )
  assert.ok(
    /\.\.\.coordinates,\s*baselinePublishedSourceIds,\s*baselinePublishedFoundationIdentityKeys,\s*dryRun:\s*true/.test(
      mirrorBlock
    ),
    '正式前内容计划预演必须传入真实稳定物理身份第二基线，不得替换为空数组或占位值'
  )
  assert.ok(
    /mirrorSync:\s*\(\)\s*=>\s*configuredMirrorTableSync\(\{\s*\.\.\.effectiveOptions,\s*baselinePublishedSourceIds,\s*baselinePublishedFoundationIdentityKeys\s*\}\)/.test(
      mirrorBlock
    ),
    '正式镜像必须传入真实稳定物理身份第二基线，不得替换为空数组或占位值'
  )
  const foundationProfileGuardIndex = mirrorBlock.indexOf(
    'aiFoundationProfileEnabled(config.feishu.sourceCompatibilityProfile)'
  )
  const foundationIdentityBaselineIndex = mirrorBlock.indexOf(
    'activeFeishuFoundationIdentityKeys(db)'
  )
  assert.ok(
    foundationProfileGuardIndex >= 0 &&
      foundationIdentityBaselineIndex >= 0 &&
      foundationProfileGuardIndex < foundationIdentityBaselineIndex,
    'legacy profile 不得尝试从稀疏旧库存生成 AI 数据底座物理身份'
  )
  const foundationSyncStart = syncSource.indexOf('async function executeAiFoundationSync(')
  const foundationSyncEnd = syncSource.indexOf('\nasync function executeMirrorTableSync(', foundationSyncStart)
  assert.ok(
    foundationSyncStart >= 0 && foundationSyncEnd > foundationSyncStart,
    '必须能定位 AI 数据底座正式同步实现'
  )
  const foundationSyncBlock = syncSource.slice(foundationSyncStart, foundationSyncEnd)
  assert.ok(
    foundationSyncBlock.includes('foundationIdentityMode: true') &&
      foundationSyncBlock.includes(
        'baselinePublishedFoundationIdentityKeys: options.baselinePublishedFoundationIdentityKeys'
      ),
    'AI 数据底座正式写前熔断必须启用 foundation 实体身份并接入线上库存数量下限'
  )
  const fuseStart = syncSource.indexOf('function assertMirrorDeactivateSafety(')
  const foundationFuseEnd = syncSource.indexOf('const recordIdentity =', fuseStart)
  const foundationFuseBlock = syncSource.slice(fuseStart, foundationFuseEnd)
  assert.ok(
    foundationFuseBlock.includes('publishedFoundationIdentities(mirrorSnapshot.records') &&
      foundationFuseBlock.includes('publishedFoundationIdentities(plannedRecords') &&
      foundationFuseBlock.includes('Math.max(publishedBefore.size, baselineCount)') &&
      foundationFuseBlock.includes('baselineCount - publishedBefore.size') &&
      /Math\.max\(\s*targetWithdrawCount,\s*baselineCoverageWithdrawCount,\s*countFloorWithdrawCount\s*\)/.test(
        foundationFuseBlock
      ),
    'AI 熔断必须按目标主档实体比较前后，并把线上库存作为数量与目标覆盖率双下限'
  )
  assert.ok(
    !foundationFuseBlock.includes('publishedBefore.add(identityKey)'),
    'AI 熔断不得再把数据库物理键与目标主档实体 ID 合并进同一身份集合'
  )
  const physicalKeyStart = syncSource.indexOf('function foundationPhysicalUnitKey(')
  const physicalKeyEnd = syncSource.indexOf('\nfunction deterministicTemporaryListingId(', physicalKeyStart)
  const physicalKeyBlock = syncSource.slice(physicalKeyStart, physicalKeyEnd)
  assert.ok(
    physicalKeyStart >= 0 && physicalKeyEnd > physicalKeyStart &&
      !physicalKeyBlock.includes('fields.district') &&
      !physicalKeyBlock.includes('fields.block'),
    '物理房间身份不得包含可变的行政区或板块分类'
  )

  const adminSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'admin-web', 'index.html'), 'utf8')
  assert.ok(
    adminSource.includes('出现“状态未知”或“已阻断”时自动同步会停止'),
    '后台同步面板必须明确提示未知或阻断状态不会自动重放'
  )
  assert.ok(
    adminSource.includes('externalWritesMayHaveOccurred: Boolean(latestRun.externalWritesMayHaveOccurred)'),
    '后台同步结果必须展示外部写入可能性，不能把状态未知伪装成失败前安全退出'
  )
  assert.ok(
    ['schemaSha256', 'mirrorPlanSha256', 'contentPlanSha256', 'schemaBindings'].every((field) =>
      adminSource.includes(`${field}: latestRun.${field}`)
    ),
    '后台同步结果必须展示字段、镜像、素材摘要与脱敏字段绑定，供人工核对'
  )
  assert.ok(
    adminSource.includes("const terminalStates = new Set(['dry-succeeded', 'succeeded', 'failed-before-write', 'unknown', 'blocked'])") &&
      adminSource.includes('const runId = result && result.run && result.run.runId'),
    '后台必须按服务端 runId 轮询到稳定终态，不能把入队成功显示成同步完成'
  )
}

async function main() {
  testFailClosedSyncDefaults()
  testIndexWiringContract()
  const invalidDryRunValues = ['true', 'false', 1, 0, {}, []]
  invalidDryRunValues.forEach((dryRun) => {
    let fakeWriteCount = 0
    assert.throws(() => {
      const parsed = feishuSync.parseAdminDryRun({ dryRun })
      if (!parsed) fakeWriteCount += 1
    }, /dryRun|布尔|boolean/i, `dryRun=${JSON.stringify(dryRun)} 必须在任何飞书写入前拒绝`)
    assert.strictEqual(fakeWriteCount, 0, '非法 dryRun 类型不得进入正式同步或产生专用表写请求')
  })
  assert.strictEqual(feishuSync.parseAdminDryRun({}), false, '缺省 dryRun 必须明确解释为正式同步')
  assert.strictEqual(feishuSync.parseAdminDryRun({ dryRun: false }), false, 'JSON false 必须解释为正式同步')
  assert.strictEqual(feishuSync.parseAdminDryRun({ dryRun: true }), true, '只有 JSON true 才能进入预演')
  const classifiedSuccess = classifyMirrorRunResult(validMirrorResult())
  assert.strictEqual(classifiedSuccess.success, true, '五项完整条件全部满足时才允许标记同步成功')

  const failureCases = [
    { name: 'complete=false', patch: { complete: false } },
    { name: 'published=false', patch: { published: false } },
    { name: 'failed>0', patch: { failed: 1 } },
    { name: 'schemaInvalid=true', patch: { schemaInvalid: true } },
    { name: 'mirrorIncomplete=true', patch: { mirrorIncomplete: true } },
    { name: 'blocked', patch: { status: 'blocked', complete: false } },
    { name: 'partial', patch: { status: 'partial', complete: false } },
    { name: 'failed', patch: { status: 'failed', failed: 2 } }
  ]
  failureCases.forEach(({ name, patch }) => {
    const classified = classifyMirrorRunResult(validMirrorResult(patch))
    assert.strictEqual(classified.success, false, `${name} 不得标记成功`)
    assert.notStrictEqual(classified.status, 'success-noop', `${name} 不得伪装成 no-op 成功`)
  })

  const incompleteNoop = classifyMirrorRunResult(validMirrorResult({
    noop: true,
    complete: false,
    published: false,
    mirrorIncomplete: true
  }))
  assert.strictEqual(incompleteNoop.success, false, '未完成全量读取与校验的空变化不得称 no-op')
  assert.notStrictEqual(incompleteNoop.status, 'success-noop', '被阻断的 no-op 声明必须降级为失败')

  {
    const calls = { inventory: 0, snapshot: 0, commit: 0 }
    const run = await settled(runCompanySourceSync({
      db: { marker: 'mirror-failure' },
      mirrorSync: async () => validMirrorResult({ complete: false, published: false, schemaInvalid: true }),
      applyInventory: async () => { calls.inventory += 1 },
      publishSnapshot: async () => { calls.snapshot += 1 },
      commit: async () => { calls.commit += 1 }
    }))
    assert.deepStrictEqual(calls, { inventory: 0, snapshot: 0, commit: 0 }, '镜像失败后库存、快照、提交必须全部零调用')
    if (run.value) {
      assert.strictEqual(run.value.success, false, '镜像失败若返回结果，必须明确标记失败')
      assert.notStrictEqual(run.value.status, 'success-noop', '镜像失败不得伪装成 no-op')
    } else {
      assert.ok(run.error instanceof Error, '镜像失败只能返回失败结果或抛出异常')
    }
  }

  {
    const calls = { snapshot: 0, commit: 0 }
    const run = await runCompanySourceSync({
      db: { marker: 'missing-failed-contract' },
      mirrorSync: async () => validMirrorResult(),
      applyInventory: async () => ({ complete: true, published: true }),
      publishSnapshot: async () => { calls.snapshot += 1 },
      commit: async () => { calls.commit += 1 }
    })
    assert.strictEqual(run.success, false, '库存阶段缺少 failed=0 不能假报成功')
    assert.strictEqual(run.status, 'failed-inventory', '库存阶段契约不完整必须明确失败阶段')
    assert.deepStrictEqual(calls, { snapshot: 0, commit: 0 }, '库存阶段缺 failed 后快照与提交必须零调用')
  }

  {
    const calls = { commit: 0 }
    const run = await runCompanySourceSync({
      db: { marker: 'snapshot-missing-failed' },
      mirrorSync: async () => validMirrorResult(),
      applyInventory: async () => ({ complete: true, published: true, failed: 0 }),
      publishSnapshot: async () => ({ complete: true, published: true }),
      commit: async () => { calls.commit += 1 }
    })
    assert.strictEqual(run.status, 'failed-snapshot', '快照阶段缺少 failed=0 必须阻断')
    assert.strictEqual(calls.commit, 0, '快照阶段契约不完整不得进入提交')
  }

  {
    const calls = { inventory: 0, snapshot: 0, commit: 0 }
    const run = await settled(runCompanySourceSync({
      db: { marker: 'inventory-failure' },
      mirrorSync: async () => validMirrorResult(),
      applyInventory: async () => {
        calls.inventory += 1
        return { complete: false, published: false, failed: 1 }
      },
      publishSnapshot: async () => { calls.snapshot += 1 },
      commit: async () => { calls.commit += 1 }
    }))
    assert.strictEqual(calls.inventory, 1, '镜像成功后必须进入库存同步')
    assert.strictEqual(calls.snapshot, 0, '库存失败后不得发布快照')
    assert.strictEqual(calls.commit, 0, '库存失败后不得提交本轮变更')
    if (run.value) assert.strictEqual(run.value.success, false, '库存失败若返回结果，必须明确标记失败')
    else assert.ok(run.error instanceof Error, '库存失败只能返回失败结果或抛出异常')
  }


  {
    const order = []
    const run = await runCompanySourceSync({
      db: { marker: 'dry-run' },
      mirrorSync: async () => {
        order.push('mirror')
        return validMirrorResult({
          published: false,
          dryRun: true,
          validated: true,
          planned: true,
          noop: true
        })
      },
      applyInventory: async () => {
        order.push('inventory')
        return { complete: true, published: true, failed: 0, noop: true, dryRun: true }
      },
      publishSnapshot: async () => {
        order.push('snapshot')
        return { complete: true, published: true, failed: 0, noop: true, dryRun: true }
      },
      commit: async () => {
        order.push('commit-noop')
        return { complete: true, noop: true, dryRun: true }
      }
    })
    assert.deepStrictEqual(order, ['mirror', 'inventory', 'snapshot', 'commit-noop'], 'dry-run 仍需完整校验四阶段，但提交回调必须是显式 no-op')
    assert.strictEqual(run.status, 'success-dry-run', '完整预演必须使用 success-dry-run，不能伪装真实发布')
    assert.strictEqual(run.published, false, 'dry-run 不得声明远端镜像已发布')
    assert.strictEqual(run.dryRun, true, 'dry-run 结果必须保留预演标记')
  }

  {
    const order = []
    const run = await runCompanySourceSync({
      db: { marker: 'full-success' },
      mirrorSync: async () => {
        order.push('mirror')
        return validMirrorResult()
      },
      applyInventory: async () => {
        order.push('inventory')
        return { complete: true, published: true, failed: 0 }
      },
      publishSnapshot: async () => {
        order.push('snapshot')
        return { complete: true, published: true, failed: 0 }
      },
      commit: async () => {
        order.push('commit')
        return { complete: true }
      }
    })
    assert.deepStrictEqual(order, ['mirror', 'inventory', 'snapshot', 'commit'], '成功链路必须严格按镜像→库存→快照→提交执行')
    assert.strictEqual(run.complete, true, '四阶段全绿后必须返回 complete=true')
    assert.strictEqual(run.success, true, '四阶段全绿后必须返回 success=true')
  }

  {
    const order = []
    const run = await runCompanySourceSync({
      db: { marker: 'validated-noop' },
      mirrorSync: async () => {
        order.push('mirror')
        return validMirrorResult({ noop: true })
      },
      applyInventory: async () => {
        order.push('inventory')
        return { complete: true, published: true, failed: 0, noop: true }
      },
      publishSnapshot: async () => {
        order.push('snapshot')
        return { complete: true, published: true, failed: 0, noop: true }
      },
      commit: async () => {
        order.push('commit')
        return { complete: true, noop: true }
      }
    })
    assert.deepStrictEqual(order, ['mirror', 'inventory', 'snapshot', 'commit'], 'no-op 也必须走完整读取校验、库存、快照和提交边界')
    assert.strictEqual(run.complete, true, '经完整校验的 no-op 才能 complete=true')
    assert.strictEqual(run.success, true, '经完整校验的 no-op 才能 success=true')
    assert.strictEqual(run.status, 'success-noop', '完整无变化运行必须使用明确的 success-noop 状态')
  }
}

main().then(() => {
  console.log('feishu-sync-job-v1-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
