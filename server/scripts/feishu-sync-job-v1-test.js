const assert = require('assert')
const fs = require('fs')
const path = require('path')

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

function testIndexWiringContract() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.js'), 'utf8')
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
  assert.ok(manualBlock.includes('feishuSync.parseAdminDryRun(body)'), '手动同步必须在调用飞书前统一校验 dryRun 类型')
  assert.ok(manualBlock.indexOf('if (feishuSyncRunning)') < manualBlock.indexOf('if (dryRun)'), 'dry-run 必须与正式同步共用互斥锁')
  assert.ok(manualBlock.includes('feishuSync.isCommittableSyncResult(result)'), '手动同步必须检查完整发布分类')
  assert.ok(manualBlock.indexOf('feishuSync.isCommittableSyncResult(result)') < manualBlock.indexOf('dbStore.commitDelta(baseSnapshot, nextDb)'), '手动同步必须先过发布门禁再提交数据库')

  const scheduledStart = source.indexOf('async function runScheduledFeishuSync()')
  const scheduledEnd = source.indexOf('function startFeishuSyncTimer()', scheduledStart)
  const scheduledBlock = source.slice(scheduledStart, scheduledEnd)
  assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart, '必须定位定时同步函数')
  assert.ok(scheduledBlock.includes('if (!config.feishu.syncEnabled || !config.feishu.autoSyncEnabled) return'), '总开关或自动开关关闭时定时任务必须零执行')
  assert.ok(scheduledBlock.includes('feishuSync.isCommittableSyncResult(result)'), '定时同步必须检查完整发布分类')
  assert.ok(scheduledBlock.indexOf('feishuSync.isCommittableSyncResult(result)') < scheduledBlock.indexOf('dbStore.commitDelta(baseSnapshot, nextDb)'), '定时同步必须先过发布门禁再提交数据库')
  assert.ok(
    scheduledBlock.includes('if (result.success !== true)'),
    '库存可提交但素材失败时，定时同步必须单独识别整轮失败'
  )
  assert.ok(
    scheduledBlock.indexOf('dbStore.commitDelta(baseSnapshot, nextDb)') <
      scheduledBlock.indexOf('if (result.success !== true)'),
    '整轮失败日志只能在库存成功提交后说明库存已提交、素材失败'
  )
  assert.ok(
    scheduledBlock.includes('库存已提交，但素材同步未完整成功'),
    '定时同步不得把嵌套素材失败写成自动同步完成'
  )
  const timerBlock = source.slice(scheduledEnd, source.indexOf('// 实时 ASR', scheduledEnd))
  assert.ok(timerBlock.includes('if (!config.feishu.syncEnabled || !config.feishu.autoSyncEnabled) return'), '自动开关关闭时不得启动定时器，但手动 dry-run 仍可用')

  const syncSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'feishu-sync.js'), 'utf8')
  const mirrorStart = syncSource.indexOf('async function syncViaMirror')
  const mirrorEnd = syncSource.indexOf('function isCommittableSyncResult', mirrorStart)
  const mirrorBlock = syncSource.slice(mirrorStart, mirrorEnd)
  assert.ok(mirrorBlock.includes('activeFeishuSourceRecordIds(db)'), '镜像同步必须从线上活跃飞书库存生成第二撤下基线')
  assert.ok(mirrorBlock.includes('baselinePublishedSourceIds'), '线上库存撤下基线必须传入专用表写前熔断')

  const adminSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'admin-web', 'index.html'), 'utf8')
  assert.ok(
    adminSource.includes('库存已提交，但素材同步未完整成功'),
    '后台同步面板必须明确区分库存已提交与素材失败，不能显示成整体完成'
  )
  assert.ok(
    adminSource.includes('inventoryCommittable: Boolean(lastLog.inventoryCommittable)'),
    '后台同步结果必须展示库存可提交状态'
  )
  assert.ok(
    adminSource.includes('noteMaterials: lastLog.noteMaterials || null'),
    '后台同步结果必须展示嵌套素材阶段，供人工对账完整成功'
  )
  assert.ok(
    adminSource.includes('const lastLog = payload.result || status.lastLog || null'),
    '刚执行同步时必须优先展示本轮整轮结果，不能被库存阶段旧日志遮住素材失败'
  )
}

async function main() {
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
