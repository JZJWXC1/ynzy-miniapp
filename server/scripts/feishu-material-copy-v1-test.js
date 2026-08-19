const assert = require('assert')
const crypto = require('crypto')

const {
  buildMaterialCopyPlan,
  buildMaterialResumePlan,
  createFeishuDriveClient,
  executeMaterialCopyPlan,
  executeMaterialResumePlan,
  toSafePlanSummary,
  buildListingMaterialKey
} = require('../src/feishu-material-copy')
const {
  assertPrivateInputPath,
  assertPrivateResumeStatePath,
  parseCliArgs,
  runCli,
  safeErrorMessage
} = require('./feishu-material-copy')

class MockDrive {
  constructor(tree, options = {}) {
    this.nodes = new Map()
    Object.entries(tree || {}).forEach(([token, items]) => {
      this.nodes.set(token, (items || []).map((item) => ({
        ...item,
        ...(
          item.type === 'file' &&
          !item.modifiedTime &&
          !item.modified_time &&
          options.preserveMissingModifiedTime !== true
            ? { modifiedTime: 'mock-version-1' }
            : {}
        )
      })))
    })
    this.calls = []
    this.nextToken = 1
    this.hideCopiedFile = options.hideCopiedFile === true
    this.copyVisibleAfterLists = Number(options.copyVisibleAfterLists || 0)
    this.pendingVisibility = new Map()
  }

  async listFolder(folderToken) {
    this.calls.push({ operation: 'list', folderToken })
    if (!this.nodes.has(folderToken)) throw new Error('mock folder not found')
    const pending = this.pendingVisibility.get(folderToken) || []
    pending.forEach((item) => {
      item.remaining -= 1
      if (item.remaining <= 0) this.nodes.get(folderToken).push(item.file)
    })
    this.pendingVisibility.set(folderToken, pending.filter((item) => item.remaining > 0))
    return this.nodes.get(folderToken).map((item) => ({ ...item }))
  }

  async createFolder(parentToken, name) {
    this.calls.push({ operation: 'create_folder', parentToken, name })
    const token = `created-folder-${this.nextToken++}`
    this.nodes.set(token, [])
    this.nodes.get(parentToken).push({ token, name, type: 'folder' })
    return { token, name, type: 'folder' }
  }

  async copyFile(sourceToken, targetFolderToken, name) {
    this.calls.push({ operation: 'copy', sourceToken, targetFolderToken, name })
    const token = `copied-file-${this.nextToken++}`
    if (!this.hideCopiedFile) {
      const file = { token, name, type: 'file', modifiedTime: 'mock-copy-version-1' }
      if (this.copyVisibleAfterLists > 0) {
        const pending = this.pendingVisibility.get(targetFolderToken) || []
        pending.push({ remaining: this.copyVisibleAfterLists, file })
        this.pendingVisibility.set(targetFolderToken, pending)
      } else {
        this.nodes.get(targetFolderToken).push(file)
      }
    }
    return { token, name, type: 'file' }
  }
}

class FailNthCopyDrive extends MockDrive {
  constructor(tree, failAt = 2) {
    super(tree)
    this.copyAttempts = 0
    this.failAt = failAt
  }

  async copyFile(sourceToken, targetFolderToken, name) {
    this.copyAttempts += 1
    if (this.copyAttempts === this.failAt) {
      this.calls.push({ operation: 'copy', sourceToken, targetFolderToken, name })
      throw new Error('synthetic copy interruption')
    }
    return super.copyFile(sourceToken, targetFolderToken, name)
  }
}

const ROOTS = {
  sourceRootToken: 'source-root-secret-token',
  activeRootToken: 'active-root-secret-token',
  pendingRootToken: 'pending-root-secret-token'
}

function manifest(overrides = {}) {
  return {
    ...ROOTS,
    locations: [{
      locationId: 'test-city-test-district-test-block-test-garden',
      city: '杭州',
      district: '拱墅区',
      block: '新天地',
      community: '测试花园',
      aliases: ['测试花园', '测试花苑'],
      enabled: true
    }],
    listings: [{
      sourceRecordId: 'source-record-secret-id',
      locationId: 'test-city-test-district-test-block-test-garden',
      building: '15',
      unit: '2',
      roomNumber: 'T01',
      published: true,
      canonical: true,
      enabled: true
    }],
    ...overrides
  }
}

function goodSourceTree(videoName = '员工原视频.mp4') {
  return {
    'source-root-secret-token': [
      { token: 'group-folder-token', name: '旧员工素材分组', type: 'folder' }
    ],
    'group-folder-token': [
      { token: 'room-folder-token', name: '测试花园15-2-T01', type: 'folder' }
    ],
    'room-folder-token': [
      { token: 'source-video-secret-token', name: videoName, type: 'file' },
      { token: 'source-image-secret-token', name: '封面.jpg', type: 'file' }
    ],
    'active-root-secret-token': [],
    'pending-root-secret-token': []
  }
}

function twoVideoSourceTree() {
  return {
    'source-root-secret-token': [
      { token: 'group-folder-token', name: '旧员工素材分组', type: 'folder' }
    ],
    'group-folder-token': [
      { token: 'room-folder-token-a', name: '测试花园15-2-T01', type: 'folder' },
      { token: 'room-folder-token-b', name: '测试花园15-2-T02', type: 'folder' }
    ],
    'room-folder-token-a': [
      { token: 'source-video-secret-token-a', name: '员工原视频A.mp4', type: 'file' }
    ],
    'room-folder-token-b': [
      { token: 'source-video-secret-token-b', name: '员工原视频B.mp4', type: 'file' }
    ],
    'active-root-secret-token': [],
    'pending-root-secret-token': []
  }
}

function twoListingManifest() {
  return manifest({
    listings: [
      manifest().listings[0],
      {
        ...manifest().listings[0],
        sourceRecordId: 'source-record-secret-id-b',
        roomNumber: 'T02'
      }
    ]
  })
}

function countCalls(drive, operation) {
  return drive.calls.filter((call) => call.operation === operation).length
}

function privateTestPath(fileName) {
  return require('path').resolve(__dirname, '..', '..', '..', fileName)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function refreshReceiptStateSha256(receipt) {
  receipt.stateSha256 = canonicalSha256({
    version: receipt.version,
    planBindingSha256: receipt.planBindingSha256,
    completed: receipt.completed,
    inFlight: receipt.inFlight
  })
  return receipt
}

function findMockTargetFolderToken(drive, rootToken, segments) {
  let folderToken = rootToken
  for (const segment of segments) {
    const matches = (drive.nodes.get(folderToken) || []).filter((item) => (
      item.name === segment && item.type === 'folder'
    ))
    assert.strictEqual(matches.length, 1, `测试夹具缺少唯一目标目录：${segment}`)
    folderToken = matches[0].token
  }
  return folderToken
}

function prebuildMockTargetFolders(drive, rootToken, segments) {
  let folderToken = rootToken
  segments.forEach((segment, index) => {
    const children = drive.nodes.get(folderToken) || []
    const existing = children.find((item) => item.name === segment && item.type === 'folder')
    if (existing) {
      folderToken = existing.token
      return
    }
    const token = `prebuilt-target-folder-${index}`
    children.push({ token, name: segment, type: 'folder' })
    drive.nodes.set(folderToken, children)
    drive.nodes.set(token, [])
    folderToken = token
  })
  return folderToken
}

async function expectReject(promise, pattern, message) {
  let error = null
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message || '预期 Promise 拒绝')
  assert.match(String(error.message || error), pattern)
  return error
}

async function run() {
  const goodDrive = new MockDrive(goodSourceTree())
  const goodPlan = await buildMaterialCopyPlan({
    drive: goodDrive,
    manifest: manifest()
  })

  assert.strictEqual(goodPlan.blockers.length, 0, '标准一房一视频不应有阻断')
  assert.strictEqual(goodPlan.operations.length, 1, '标准一房一视频必须恰好生成一个复制动作')
  assert.strictEqual(goodPlan.operations[0].bucket, 'active', '唯一精确匹配必须进入在架素材')
  assert.deepStrictEqual(
    goodPlan.operations[0].targetSegments,
    [
      '杭州',
      '拱墅区',
      '新天地',
      'test-city-test-district-test-block-test-garden__测试花园',
      '15__2__T01'
    ],
    '在架素材路径必须固定为城市/行政区/板块/位置ID__标准小区/房源键'
  )
  assert.strictEqual(
    goodPlan.operations[0].targetName,
    '测试花园-15__2__T01.mp4',
    '目标视频名必须由标准小区和稳定房源键生成，不沿用员工任意文件名'
  )
  assert.strictEqual(
    buildListingMaterialKey({ building: '15', unit: '', roomNumber: 'T01' }),
    '15__T01',
    '缺单元房源键必须省略单元段；严格匹配由独立物理键保证，不能把单元当通配符'
  )
  assert.match(goodPlan.planSha256, /^[a-f0-9]{64}$/, '计划必须提供完整 SHA-256')
  assert.match(
    goodPlan.sourcePlanFingerprint,
    /^[a-f0-9]{64}$/,
    '计划必须提供不依赖目标库存的源计划指纹'
  )
  assert.strictEqual(countCalls(goodDrive, 'create_folder'), 0, '生成计划不得创建目录')
  assert.strictEqual(countCalls(goodDrive, 'copy'), 0, '生成计划不得复制文件')

  const matchingFolderAndFileDrive = new MockDrive(
    goodSourceTree('测试花园15-2-T01.mp4')
  )
  const matchingFolderAndFilePlan = await buildMaterialCopyPlan({
    drive: matchingFolderAndFileDrive,
    manifest: manifest()
  })
  assert.strictEqual(
    matchingFolderAndFilePlan.operations.filter((item) => item.bucket === 'active').length,
    1,
    '叶子目录和文件名都能解析且物理房源一致时必须接受'
  )

  const fileOnlyIdentityTree = goodSourceTree('测试花园15-2-T01.mp4')
  fileOnlyIdentityTree['group-folder-token'] = [{
    token: 'room-folder-token',
    name: '员工临时分组',
    type: 'folder'
  }]
  const fileOnlyIdentityPlan = await buildMaterialCopyPlan({
    drive: new MockDrive(fileOnlyIdentityTree),
    manifest: manifest()
  })
  assert.strictEqual(
    fileOnlyIdentityPlan.operations.filter((item) => item.bucket === 'active').length,
    1,
    '叶子目录解析失败但文件名唯一解析成功时仍应接受'
  )

  const conflictingIdentityTree = goodSourceTree('测试花园15-2-T02.mp4')
  const conflictingIdentityPlan = await buildMaterialCopyPlan({
    drive: new MockDrive(conflictingIdentityTree),
    manifest: manifest({
      listings: [
        manifest().listings[0],
        {
          ...manifest().listings[0],
          sourceRecordId: 'source-record-conflicting-file-id',
          roomNumber: 'T02'
        }
      ]
    })
  })
  assert.strictEqual(
    conflictingIdentityPlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '叶子目录和文件名解析到不同物理房源时不得择一进入在架素材'
  )
  assert.ok(
    conflictingIdentityPlan.operations.some(
      (item) => item.bucket === 'pending' && item.reason === '身份冲突'
    ),
    '叶子目录和文件名冲突必须进入待确认/身份冲突'
  )

  const strongestFailureTree = goodSourceTree('测试花园无法解析.mp4')
  strongestFailureTree['group-folder-token'] = [{
    token: 'room-folder-token',
    name: '虚构小区15-2-T01',
    type: 'folder'
  }]
  const strongestFailurePlan = await buildMaterialCopyPlan({
    drive: new MockDrive(strongestFailureTree),
    manifest: manifest()
  })
  assert.ok(
    strongestFailurePlan.operations.some(
      (item) => item.bucket === 'pending' && item.reason === '房源键格式异常'
    ),
    '叶子目录和文件名都失败时必须返回两者中的最强失败，而不是首个失败'
  )

  const invalidLocationEnabledCases = [
    {
      label: '缺失',
      makeLocation: () => {
        const location = { ...manifest().locations[0] }
        delete location.enabled
        return location
      }
    },
    {
      label: 'null',
      makeLocation: () => ({ ...manifest().locations[0], enabled: null })
    },
    {
      label: '空串',
      makeLocation: () => ({ ...manifest().locations[0], enabled: '' })
    },
    {
      label: '字符串 false',
      makeLocation: () => ({ ...manifest().locations[0], enabled: 'false' })
    }
  ]
  for (const item of invalidLocationEnabledCases) {
    const invalidEnabledDrive = new MockDrive(goodSourceTree())
    await expectReject(
      buildMaterialCopyPlan({
        drive: invalidEnabledDrive,
        manifest: manifest({ locations: [item.makeLocation()] })
      }),
      /enabled.*布尔|布尔.*enabled/i,
      `位置字典 enabled=${item.label} 时必须失败关闭`
    )
    assert.strictEqual(countCalls(invalidEnabledDrive, 'create_folder'), 0, '非法位置开关不得创建目录')
    assert.strictEqual(countCalls(invalidEnabledDrive, 'copy'), 0, '非法位置开关不得复制')
  }

  const disabledLocationDrive = new MockDrive(goodSourceTree())
  await expectReject(
    buildMaterialCopyPlan({
      drive: disabledLocationDrive,
      manifest: manifest({
        locations: [{ ...manifest().locations[0], enabled: false }]
      })
    }),
    /没有启用记录|位置ID未命中字典/,
    '位置字典 enabled=false 时不得进入 active 位置集合'
  )
  assert.strictEqual(countCalls(disabledLocationDrive, 'copy'), 0, '禁用位置不得生成复制动作')

  const mkvDrive = new MockDrive(goodSourceTree('员工原视频.mkv'))
  const mkvPlan = await buildMaterialCopyPlan({
    drive: mkvDrive,
    manifest: manifest()
  })
  assert.strictEqual(mkvPlan.summary.sourceVideos, 0, '.mkv 不在现有同步器视频白名单内')
  assert.strictEqual(mkvPlan.operations.length, 0, '.mkv 不得生成在架或待确认复制动作')

  const rootTokens = [
    ROOTS.sourceRootToken,
    ROOTS.activeRootToken,
    ROOTS.pendingRootToken
  ]
  await expectReject(
    buildMaterialCopyPlan({
      drive: new MockDrive(goodSourceTree()),
      manifest: manifest({ activeRootToken: ROOTS.sourceRootToken })
    }),
    /根目录.*独立|根目录.*相同|相互独立/,
    '三个根目录 token 完全相同时必须拒绝'
  )
  for (const parentRoot of rootTokens) {
    for (const childRoot of rootTokens) {
      if (parentRoot === childRoot) continue
      const nestedTree = goodSourceTree()
      nestedTree[parentRoot].push({
        token: childRoot,
        name: `嵌套根-${rootTokens.indexOf(childRoot)}`,
        type: 'folder'
      })
      const nestedDrive = new MockDrive(nestedTree)
      await expectReject(
        buildMaterialCopyPlan({
          drive: nestedDrive,
          manifest: manifest()
        }),
        /根目录.*嵌套|根目录.*祖先|相互独立/,
        '源素材、在架素材、待确认根目录互为祖先时必须拒绝'
      )
      assert.strictEqual(countCalls(nestedDrive, 'create_folder'), 0, '根目录嵌套不得创建目录')
      assert.strictEqual(countCalls(nestedDrive, 'copy'), 0, '根目录嵌套不得复制')
    }
  }
  for (const parentRoot of rootTokens) {
    for (const childRoot of rootTokens) {
      if (parentRoot === childRoot) continue
      const deepNestedTree = goodSourceTree()
      const bridgeToken = `bridge-${rootTokens.indexOf(parentRoot)}-${rootTokens.indexOf(childRoot)}`
      deepNestedTree[parentRoot].push({
        token: bridgeToken,
        name: '普通中间目录',
        type: 'folder'
      })
      deepNestedTree[bridgeToken] = [{
        token: childRoot,
        name: `深层嵌套根-${rootTokens.indexOf(childRoot)}`,
        type: 'folder'
      }]
      const deepNestedDrive = new MockDrive(deepNestedTree)
      await expectReject(
        buildMaterialCopyPlan({
          drive: deepNestedDrive,
          manifest: manifest()
        }),
        /根目录.*嵌套|根目录.*祖先|相互独立/,
        '三个根目录经普通中间目录形成多层祖先关系时也必须拒绝'
      )
      assert.strictEqual(countCalls(deepNestedDrive, 'create_folder'), 0, '深层根目录嵌套不得创建目录')
      assert.strictEqual(countCalls(deepNestedDrive, 'copy'), 0, '深层根目录嵌套不得复制')
    }
  }

  const defaultDryRun = await executeMaterialCopyPlan({
    drive: goodDrive,
    plan: goodPlan
  })
  assert.strictEqual(defaultDryRun.dryRun, true, '执行器默认必须是 dry-run')
  assert.strictEqual(countCalls(goodDrive, 'create_folder'), 0, '默认 dry-run 不得创建目录')
  assert.strictEqual(countCalls(goodDrive, 'copy'), 0, '默认 dry-run 不得复制文件')

  await expectReject(
    executeMaterialCopyPlan({ drive: goodDrive, plan: goodPlan, apply: true }),
    /confirm.*SHA-256|确认.*SHA-256/i,
    '只有 --apply 没有确认哈希时必须拒绝'
  )
  await expectReject(
    executeMaterialCopyPlan({
      drive: goodDrive,
      plan: goodPlan,
      apply: true,
      confirmPlanSha256: '0'.repeat(64)
    }),
    /计划输入已变化|SHA-256.*不一致/,
    '错误确认哈希必须拒绝'
  )
  assert.strictEqual(countCalls(goodDrive, 'copy'), 0, '确认哈希失败前不得复制')

  const exactUnitDrive = new MockDrive({
    ...goodSourceTree(),
    'group-folder-token': [
      { token: 'room-folder-token', name: '测试花园15-T01', type: 'folder' }
    ]
  })
  const exactUnitPlan = await buildMaterialCopyPlan({
    drive: exactUnitDrive,
    manifest: manifest()
  })
  assert.strictEqual(
    exactUnitPlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '素材缺单元时不得把单元当通配符误配到有单元房源'
  )
  assert.strictEqual(exactUnitPlan.summary.listingsMissingMaterial, 1, '严格单元匹配失败必须计入缺素材房源')
  assert.ok(
    exactUnitPlan.operations.some((item) => item.bucket === 'pending' && item.reason === '未匹配房源'),
    '单位不一致的源素材必须进入待确认，不得丢失'
  )

  const duplicateDrive = new MockDrive({
    ...goodSourceTree(),
    'room-folder-token': [
      { token: 'duplicate-video-token-a', name: '第一份.mp4', type: 'file' },
      { token: 'duplicate-video-token-b', name: '第二份.mov', type: 'file' }
    ]
  })
  const duplicatePlan = await buildMaterialCopyPlan({
    drive: duplicateDrive,
    manifest: manifest()
  })
  assert.strictEqual(
    duplicatePlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '同一物理房源多视频时不得先到先得进入在架素材'
  )
  assert.strictEqual(
    duplicatePlan.operations.filter((item) => item.bucket === 'pending' && item.reason === '已知重复').length,
    2,
    '同一物理房源的全部重复视频都必须分类进入待确认'
  )

  const missingCommunityDrive = new MockDrive({
    ...goodSourceTree(),
    'group-folder-token': [
      { token: 'room-folder-token', name: '_15-1-603', type: 'folder' }
    ]
  })
  const missingCommunityPlan = await buildMaterialCopyPlan({
    drive: missingCommunityDrive,
    manifest: manifest()
  })
  assert.ok(
    missingCommunityPlan.operations.some((item) => item.bucket === 'pending' && item.reason === '缺小区'),
    '素材目录缺小区时必须进入待确认/缺小区'
  )

  const parentGuessDrive = new MockDrive({
    ...goodSourceTree(),
    'source-root-secret-token': [
      { token: 'group-folder-token', name: '测试花园15-2-T01', type: 'folder' }
    ],
    'group-folder-token': [
      { token: 'room-folder-token', name: '_15-2-T01', type: 'folder' }
    ]
  })
  const parentGuessPlan = await buildMaterialCopyPlan({
    drive: parentGuessDrive,
    manifest: manifest()
  })
  assert.strictEqual(
    parentGuessPlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '叶子目录缺小区时不得借上级分组目录猜测身份'
  )
  assert.ok(
    parentGuessPlan.operations.some((item) => item.bucket === 'pending' && item.reason === '缺小区'),
    '叶子目录缺小区即使父目录似乎可匹配，也必须稳定进入待确认/缺小区'
  )

  const unknownAliasDrive = new MockDrive({
    ...goodSourceTree(),
    'group-folder-token': [
      { token: 'room-folder-token', name: '陌生花园15-1-603', type: 'folder' }
    ]
  })
  const unknownAliasPlan = await buildMaterialCopyPlan({
    drive: unknownAliasDrive,
    manifest: manifest()
  })
  assert.ok(
    unknownAliasPlan.operations.some((item) => item.bucket === 'pending' && item.reason === '未知别名'),
    '未命中位置字典的素材小区别名必须进入待确认/未知别名'
  )

  const changedInputPlan = await buildMaterialCopyPlan({
    drive: new MockDrive(goodSourceTree()),
    manifest: manifest({
      listings: [{
        sourceRecordId: 'source-record-secret-id',
        locationId: 'test-city-test-district-test-block-test-garden',
        building: '15',
        unit: '2',
        roomNumber: 'T02',
        published: true,
        canonical: true,
        enabled: true
      }]
    })
  })
  assert.notStrictEqual(
    changedInputPlan.planSha256,
    goodPlan.planSha256,
    '房源计划输入变化必须让旧确认摘要失效'
  )

  const changedSourcePlan = await buildMaterialCopyPlan({
    drive: new MockDrive(goodSourceTree('员工替换后视频.mp4')),
    manifest: manifest()
  })
  assert.notStrictEqual(
    changedSourcePlan.planSha256,
    goodPlan.planSha256,
    '源素材清单变化必须让旧确认摘要失效'
  )

  const changedVersionDrive = new MockDrive(goodSourceTree())
  const changedVersionPlan = await buildMaterialCopyPlan({
    drive: changedVersionDrive,
    manifest: manifest()
  })
  const versionedSource = changedVersionDrive.nodes.get('room-folder-token')
    .find((item) => item.token === 'source-video-secret-token')
  versionedSource.modifiedTime = 'mock-version-2'
  await expectReject(
    executeMaterialCopyPlan({
      drive: changedVersionDrive,
      plan: changedVersionPlan,
      apply: true,
      confirmPlanSha256: changedVersionPlan.planSha256
    }),
    /计划输入已变化/,
    '同 token、同文件名、同路径的源视频版本变化也必须让旧摘要失效'
  )
  assert.strictEqual(countCalls(changedVersionDrive, 'create_folder'), 0, '源版本变化后不得创建目录')
  assert.strictEqual(countCalls(changedVersionDrive, 'copy'), 0, '源版本变化后不得复制')

  const missingVersionDrive = new MockDrive(goodSourceTree(), {
    preserveMissingModifiedTime: true
  })
  const missingVersionPlan = await buildMaterialCopyPlan({
    drive: missingVersionDrive,
    manifest: manifest()
  })
  assert.ok(
    missingVersionPlan.blockers.some((item) => item.code === 'SOURCE_VERSION_MISSING'),
    '源视频缺 modified_time 时必须失败关闭，不能生成可执行复制计划'
  )

  const shortcutTree = goodSourceTree()
  shortcutTree['room-folder-token'] = [{
    token: 'shortcut-secret-token',
    name: '快捷方式视频.mp4',
    type: 'shortcut',
    modifiedTime: 'mock-version-1'
  }]
  const shortcutPlan = await buildMaterialCopyPlan({
    drive: new MockDrive(shortcutTree),
    manifest: manifest()
  })
  assert.strictEqual(shortcutPlan.summary.sourceVideos, 0, '快捷方式、在线文档等非 file 对象不得伪装成视频')
  assert.strictEqual(
    shortcutPlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '扩展名为 mp4 的快捷方式也不得进入在架复制计划'
  )
  assert.ok(
    shortcutPlan.blockers.some((item) => item.code === 'UNSUPPORTED_VIDEO_OBJECT'),
    '疑似视频但原始类型不是 file 时必须显式阻断，不能静默忽略'
  )

  const unpublishedPlan = await buildMaterialCopyPlan({
    drive: new MockDrive(goodSourceTree()),
    manifest: manifest({
      listings: [{
        sourceRecordId: 'source-record-secret-id',
        locationId: 'test-city-test-district-test-block-test-garden',
        building: '15',
        unit: '2',
        roomNumber: 'T01',
        published: false,
        canonical: true,
        enabled: true
      }]
    })
  })
  assert.strictEqual(
    unpublishedPlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '未发布房源的素材不得进入在架素材'
  )
  assert.ok(
    unpublishedPlan.operations.some((item) => item.bucket === 'pending' && item.reason === '未匹配房源'),
    '未发布房源对应的旧素材必须进入待确认，不能静默遗漏'
  )

  const duplicateListingPlan = await buildMaterialCopyPlan({
    drive: new MockDrive(goodSourceTree()),
    manifest: manifest({
      listings: [
        manifest().listings[0],
        {
          ...manifest().listings[0],
          sourceRecordId: 'second-source-record-secret-id'
        }
      ]
    })
  })
  assert.strictEqual(
    duplicateListingPlan.operations.filter((item) => item.bucket === 'active').length,
    0,
    '同一物理键存在多条房源记录时不得择一进入在架素材'
  )
  assert.ok(
    duplicateListingPlan.operations.some((item) => item.bucket === 'pending' && item.reason === '房源重复'),
    '重复房源记录对应素材必须进入待确认/房源重复'
  )

  const changedAfterPlanDrive = new MockDrive(goodSourceTree())
  const changedAfterPlan = await buildMaterialCopyPlan({
    drive: changedAfterPlanDrive,
    manifest: manifest()
  })
  changedAfterPlanDrive.nodes.get('room-folder-token').push({
    token: 'late-source-video-token',
    name: '确认后新增.mp4',
    type: 'file'
  })
  await expectReject(
    executeMaterialCopyPlan({
      drive: changedAfterPlanDrive,
      plan: changedAfterPlan,
      apply: true,
      confirmPlanSha256: changedAfterPlan.planSha256
    }),
    /计划输入已变化/,
    '计划确认后源素材变化必须在写动作前使摘要失效'
  )
  assert.strictEqual(countCalls(changedAfterPlanDrive, 'create_folder'), 0, '源清单变化后不得创建目录')
  assert.strictEqual(countCalls(changedAfterPlanDrive, 'copy'), 0, '源清单变化后不得复制')

  for (const rootToken of [ROOTS.activeRootToken, ROOTS.pendingRootToken]) {
    const targetChangedDrive = new MockDrive(goodSourceTree())
    const targetChangedPlan = await buildMaterialCopyPlan({
      drive: targetChangedDrive,
      manifest: manifest()
    })
    targetChangedDrive.nodes.get(rootToken).push({
      token: `${rootToken}-late-file-token`,
      name: '确认后新增目标文件.txt',
      type: 'file',
      modifiedTime: 'mock-target-version-2'
    })
    await expectReject(
      executeMaterialCopyPlan({
        drive: targetChangedDrive,
        plan: targetChangedPlan,
        apply: true,
        confirmPlanSha256: targetChangedPlan.planSha256
      }),
      /计划输入已变化/,
      '确认后在架或待确认目标清单变化必须让旧摘要失效'
    )
    assert.strictEqual(countCalls(targetChangedDrive, 'create_folder'), 0, '目标清单变化后不得创建目录')
    assert.strictEqual(countCalls(targetChangedDrive, 'copy'), 0, '目标清单变化后不得复制')
  }

  const conflictTree = goodSourceTree()
  conflictTree['active-root-secret-token'] = [
    { token: 'city-folder-token', name: '杭州', type: 'folder' }
  ]
  conflictTree['city-folder-token'] = [
    { token: 'district-folder-token', name: '拱墅区', type: 'folder' }
  ]
  conflictTree['district-folder-token'] = [
    { token: 'block-folder-token', name: '新天地', type: 'folder' }
  ]
  conflictTree['block-folder-token'] = [
    {
      token: 'community-folder-token',
      name: 'test-city-test-district-test-block-test-garden__测试花园',
      type: 'folder'
    }
  ]
  conflictTree['community-folder-token'] = [
    { token: 'listing-folder-token', name: '15__2__T01', type: 'folder' }
  ]
  conflictTree['listing-folder-token'] = [
    { token: 'preexisting-target-token', name: '测试花园-15__2__T01.mp4', type: 'file' }
  ]
  const conflictDrive = new MockDrive(conflictTree)
  const conflictPlan = await buildMaterialCopyPlan({
    drive: conflictDrive,
    manifest: manifest()
  })
  assert.ok(conflictPlan.blockers.some((item) => item.code === 'TARGET_CONFLICT'), '目标同名文件必须在计划阶段阻断')
  await expectReject(
    executeMaterialCopyPlan({
      drive: conflictDrive,
      plan: conflictPlan,
      apply: true,
      confirmPlanSha256: conflictPlan.planSha256
    }),
    /目标冲突|阻断/
  )
  assert.strictEqual(countCalls(conflictDrive, 'create_folder'), 0, '目标冲突必须在任何写动作前阻断')
  assert.strictEqual(countCalls(conflictDrive, 'copy'), 0, '目标冲突必须在任何复制前阻断')

  const pathConflictTree = goodSourceTree()
  pathConflictTree['active-root-secret-token'] = [{
    token: 'city-name-file-token',
    name: '杭州',
    type: 'file',
    modifiedTime: 'mock-target-version-1'
  }]
  const pathConflictDrive = new MockDrive(pathConflictTree)
  const pathConflictPlan = await buildMaterialCopyPlan({
    drive: pathConflictDrive,
    manifest: manifest()
  })
  assert.ok(
    pathConflictPlan.blockers.some((item) => item.code === 'TARGET_PATH_CONFLICT'),
    '动态路径任一中间段已有同名文件时必须在计划阶段阻断'
  )
  await expectReject(
    executeMaterialCopyPlan({
      drive: pathConflictDrive,
      plan: pathConflictPlan,
      apply: true,
      confirmPlanSha256: pathConflictPlan.planSha256
    }),
    /目标冲突|阻断/
  )
  assert.strictEqual(countCalls(pathConflictDrive, 'create_folder'), 0, '中间路径冲突不得产生目录写入')
  assert.strictEqual(countCalls(pathConflictDrive, 'copy'), 0, '中间路径冲突不得复制')

  const duplicateFolderTree = goodSourceTree()
  duplicateFolderTree['active-root-secret-token'] = [
    { token: 'duplicate-city-folder-a', name: '杭州', type: 'folder' },
    { token: 'duplicate-city-folder-b', name: '杭州', type: 'folder' }
  ]
  duplicateFolderTree['duplicate-city-folder-a'] = []
  duplicateFolderTree['duplicate-city-folder-b'] = []
  const duplicateFolderDrive = new MockDrive(duplicateFolderTree)
  const duplicateFolderPlan = await buildMaterialCopyPlan({
    drive: duplicateFolderDrive,
    manifest: manifest()
  })
  assert.ok(
    duplicateFolderPlan.blockers.some((item) => item.code === 'TARGET_FOLDER_DUPLICATE'),
    '同级多个同名目录必须在计划阶段阻断'
  )
  await expectReject(
    executeMaterialCopyPlan({
      drive: duplicateFolderDrive,
      plan: duplicateFolderPlan,
      apply: true,
      confirmPlanSha256: duplicateFolderPlan.planSha256
    }),
    /目标冲突|阻断/
  )
  assert.strictEqual(countCalls(duplicateFolderDrive, 'create_folder'), 0, '同名目录冲突不得继续建目录')
  assert.strictEqual(countCalls(duplicateFolderDrive, 'copy'), 0, '同名目录冲突不得复制')

  const createdFolderMixedDrive = new MockDrive(goodSourceTree())
  const createdFolderMixedPlan = await buildMaterialCopyPlan({
    drive: createdFolderMixedDrive,
    manifest: manifest()
  })
  const createFolderWithConcurrentFile = createdFolderMixedDrive.createFolder.bind(
    createdFolderMixedDrive
  )
  let createdFolderMixedInjected = false
  createdFolderMixedDrive.createFolder = async (parentToken, name) => {
    const created = await createFolderWithConcurrentFile(parentToken, name)
    if (!createdFolderMixedInjected) {
      createdFolderMixedInjected = true
      createdFolderMixedDrive.nodes.get(parentToken).push({
        token: 'concurrent-same-name-file-after-create-folder',
        name,
        type: 'file',
        modifiedTime: 'concurrent-create-folder-version'
      })
    }
    return created
  }
  const createdFolderMixedError = await expectReject(
    executeMaterialCopyPlan({
      drive: createdFolderMixedDrive,
      plan: createdFolderMixedPlan,
      apply: true,
      confirmPlanSha256: createdFolderMixedPlan.planSha256,
      readbackAttempts: 1,
      readbackDelayMs: 0
    }),
    /目录创建回读校验失败|目标冲突/,
    'createFolder 返回后若回读出现同名 folder+file，必须阻断'
  )
  assert.strictEqual(
    createdFolderMixedError.partialResult.receipt.completed.length,
    0,
    '目录创建混合冲突不得把动作记为 completed'
  )
  assert.strictEqual(
    createdFolderMixedError.partialResult.receipt.inFlight.phase,
    'preparing',
    '目录创建混合冲突发生在复制请求前，必须保持 preparing'
  )
  assert.strictEqual(
    countCalls(createdFolderMixedDrive, 'copy'),
    0,
    '目录创建混合冲突必须在复制 POST 前阻断'
  )

  const applyDrive = new MockDrive(goodSourceTree())
  const applyPlan = await buildMaterialCopyPlan({
    drive: applyDrive,
    manifest: manifest()
  })
  const applyResult = await executeMaterialCopyPlan({
    drive: applyDrive,
    plan: applyPlan,
    apply: true,
    confirmPlanSha256: applyPlan.planSha256
  })
  assert.strictEqual(applyResult.applied, true, '精确确认后才允许真实复制')
  assert.strictEqual(applyResult.copied, 1, '标准计划必须复制一个文件')
  assert.strictEqual(applyResult.readBackVerified, 1, '每个复制结果都必须通过目标目录回读')
  assert.strictEqual(countCalls(applyDrive, 'copy'), 1, '只允许复制一次')
  assert.ok(countCalls(applyDrive, 'create_folder') >= 5, '动态在架路径不存在时应逐级创建')
  assert.deepStrictEqual(
    [...new Set(applyDrive.calls.map((call) => call.operation))].sort(),
    ['copy', 'create_folder', 'list'],
    '真实执行只能使用 list/create_folder/copy 三种 Drive 操作'
  )

  const asyncReadbackDrive = new MockDrive(goodSourceTree(), { copyVisibleAfterLists: 2 })
  const asyncReadbackPlan = await buildMaterialCopyPlan({
    drive: asyncReadbackDrive,
    manifest: manifest()
  })
  const asyncReadbackResult = await executeMaterialCopyPlan({
    drive: asyncReadbackDrive,
    plan: asyncReadbackPlan,
    apply: true,
    confirmPlanSha256: asyncReadbackPlan.planSha256,
    readbackAttempts: 3,
    readbackDelayMs: 0
  })
  assert.strictEqual(asyncReadbackResult.readBackVerified, 1, '飞书异步复制必须轮询到目标文件后才算成功')

  const copiedFileMixedDrive = new MockDrive(goodSourceTree())
  const copiedFileMixedPlan = await buildMaterialCopyPlan({
    drive: copiedFileMixedDrive,
    manifest: manifest()
  })
  const copyWithConcurrentFolder = copiedFileMixedDrive.copyFile.bind(copiedFileMixedDrive)
  copiedFileMixedDrive.copyFile = async (sourceToken, targetFolderToken, name) => {
    const copied = await copyWithConcurrentFolder(sourceToken, targetFolderToken, name)
    const concurrentFolderToken = 'concurrent-same-name-folder-after-copy'
    copiedFileMixedDrive.nodes.get(targetFolderToken).push({
      token: concurrentFolderToken,
      name,
      type: 'folder'
    })
    copiedFileMixedDrive.nodes.set(concurrentFolderToken, [])
    return copied
  }
  const copiedFileMixedError = await expectReject(
    executeMaterialCopyPlan({
      drive: copiedFileMixedDrive,
      plan: copiedFileMixedPlan,
      apply: true,
      confirmPlanSha256: copiedFileMixedPlan.planSha256,
      readbackAttempts: 1,
      readbackDelayMs: 0
    }),
    /复制回读校验失败|目标冲突/,
    'copyFile 正常返回后若回读出现同名 file+folder，必须阻断'
  )
  assert.strictEqual(
    copiedFileMixedError.partialResult.receipt.completed.length,
    0,
    '复制后的同名混合冲突不得把动作记为 completed'
  )
  assert.strictEqual(
    copiedFileMixedError.partialResult.receipt.inFlight.phase,
    'preparing',
    '正常复制返回后的回读冲突不得伪造 request-uncertain'
  )
  assert.strictEqual(
    countCalls(copiedFileMixedDrive, 'copy'),
    1,
    '正常复制回读混合冲突前只允许一次 copyFile 调用'
  )

  const readbackDrive = new MockDrive(goodSourceTree(), { hideCopiedFile: true })
  const readbackPlan = await buildMaterialCopyPlan({
    drive: readbackDrive,
    manifest: manifest()
  })
  await expectReject(
    executeMaterialCopyPlan({
      drive: readbackDrive,
      plan: readbackPlan,
      apply: true,
      confirmPlanSha256: readbackPlan.planSha256,
      readbackAttempts: 2,
      readbackDelayMs: 0
    }),
    /回读校验失败/
  )

  async function createInterruptedFixture() {
    const drive = new MockDrive(twoVideoSourceTree())
    const plan = await buildMaterialCopyPlan({
      drive,
      manifest: twoListingManifest()
    })
    const progressReceipts = []
    const error = await expectReject(
      executeMaterialCopyPlan({
        drive,
        plan,
        apply: true,
        confirmPlanSha256: plan.planSha256,
        readbackAttempts: 2,
        readbackDelayMs: 0,
        onProgress: async (receipt) => {
          progressReceipts.push(JSON.parse(JSON.stringify(receipt)))
          if (progressReceipts.length === 1) {
            throw new Error('synthetic confirmed checkpoint interruption')
          }
        }
      }),
      /synthetic confirmed checkpoint interruption/,
      '首项确认持久化后中断时必须返回无未决动作的可续传状态'
    )
    return { drive, plan, error, progressReceipts }
  }

  const interrupted = await createInterruptedFixture()
  assert.strictEqual(
    interrupted.progressReceipts.length,
    1,
    '每个复制并回读成功的文件都必须立即触发一次持久化回调'
  )
  assert.strictEqual(
    interrupted.error.partialResult.receipt.completed.length,
    1,
    '部分失败必须在 error.partialResult 中携带已验证完成项的私有 receipt'
  )
  assert.strictEqual(
    interrupted.error.partialResult.receipt.inFlight,
    null,
    '已回读并确认完成后才抛错的断点不得残留未决 inFlight'
  )
  assert.match(
    interrupted.error.partialResult.receipt.stateSha256,
    /^[a-f0-9]{64}$/,
    'receipt 必须用完整 SHA-256 同时保护 completed 与 inFlight'
  )
  assert.deepStrictEqual(
    Object.keys(interrupted.error.partialResult.receipt.completed[0]).sort(),
    ['bucket', 'destinationFingerprint', 'sourceFingerprint', 'targetToken'],
    '续传完成项必须只包含稳定身份、目标桶和回读 token'
  )
  const interruptedReceipt = interrupted.error.partialResult.receipt
  const resumePlan = await buildMaterialResumePlan({
    drive: interrupted.drive,
    manifest: twoListingManifest(),
    resumeReceipt: interruptedReceipt
  })
  assert.strictEqual(resumePlan.mode, 'resume', '断点状态必须生成独立续传计划')
  assert.strictEqual(resumePlan.completedCount, 1, '续传计划必须识别一个已完成前缀')
  assert.strictEqual(resumePlan.operations.length, 1, '续传计划只允许保留一个未完成动作')
  assert.strictEqual(resumePlan.blockers.length, 0, '已完成目标的精确冲突必须被安全消费')
  assert.match(resumePlan.planSha256, /^[a-f0-9]{64}$/, '续传 dry-run 必须生成新的确认 SHA-256')

  const resumeDryRun = await executeMaterialResumePlan({
    drive: interrupted.drive,
    plan: resumePlan
  })
  assert.strictEqual(resumeDryRun.dryRun, true, '续传执行器默认仍必须 dry-run')
  assert.strictEqual(resumeDryRun.remaining, 1, '续传 dry-run 必须报告剩余动作数')
  const resumedProgress = []
  const resumedResult = await executeMaterialResumePlan({
    drive: interrupted.drive,
    plan: resumePlan,
    apply: true,
    confirmPlanSha256: resumePlan.planSha256,
    readbackAttempts: 2,
    readbackDelayMs: 0,
    onProgress: async (receipt) => {
      resumedProgress.push(JSON.parse(JSON.stringify(receipt)))
    }
  })
  assert.strictEqual(resumedResult.copied, 1, '续传只应复制剩余的一个文件')
  assert.strictEqual(resumedResult.receipt.completed.length, 2, '续传成功后必须合并两项完成 receipt')
  assert.strictEqual(resumedProgress.length, 1, '续传剩余项也必须逐项触发持久化回调')
  assert.strictEqual(
    interrupted.drive.calls.filter(
      (call) => call.operation === 'copy' && call.sourceToken === 'source-video-secret-token-a'
    ).length,
    1,
    '续传不得对已完成前缀重复发起复制 POST'
  )
  assert.strictEqual(
    interrupted.drive.calls.filter(
      (call) => call.operation === 'copy' && call.sourceToken === 'source-video-secret-token-b'
    ).length,
    1,
    '已确认断点发生在第二项写入前，续传只能对第二项发起一次复制 POST'
  )

  const preRequestRaceDrive = new MockDrive(goodSourceTree())
  const preRequestRaceDiscovery = await buildMaterialCopyPlan({
    drive: preRequestRaceDrive,
    manifest: manifest()
  })
  const preRequestRaceOperation = preRequestRaceDiscovery.operations[0]
  const preRequestRaceTargetFolder = prebuildMockTargetFolders(
    preRequestRaceDrive,
    ROOTS.activeRootToken,
    preRequestRaceOperation.targetSegments
  )
  preRequestRaceDrive.calls = []
  const preRequestRacePlan = await buildMaterialCopyPlan({
    drive: preRequestRaceDrive,
    manifest: manifest()
  })
  const preRequestRaceError = await expectReject(
    executeMaterialCopyPlan({
      drive: preRequestRaceDrive,
      plan: preRequestRacePlan,
      apply: true,
      confirmPlanSha256: preRequestRacePlan.planSha256,
      onIntent: async (receipt) => {
        assert.strictEqual(receipt.inFlight.phase, 'preparing', '请求前 intent 必须是 preparing')
        preRequestRaceDrive.nodes.get(preRequestRaceTargetFolder).push({
          token: 'foreign-before-copy-token',
          name: preRequestRaceOperation.targetName,
          type: 'file',
          modifiedTime: 'foreign-before-copy-version'
        })
      }
    }),
    /目标冲突/,
    'onIntent 后、copyFile 前出现同名异物时必须在 POST 前阻断'
  )
  assert.strictEqual(
    countCalls(preRequestRaceDrive, 'copy'),
    0,
    '请求前竞态目标冲突不得发起任何 copy POST'
  )
  assert.strictEqual(
    preRequestRaceError.partialResult.receipt.inFlight.phase,
    'preparing',
    '请求前目标冲突不得伪造 request-uncertain 证明'
  )
  await expectReject(
    buildMaterialResumePlan({
      drive: preRequestRaceDrive,
      manifest: manifest(),
      resumeReceipt: preRequestRaceError.partialResult.receipt
    }),
    /准备阶段|禁止自动晋升|禁止.*重发/,
    '请求前出现的唯一异物不得在续传时晋升 completed'
  )
  assert.strictEqual(
    countCalls(preRequestRaceDrive, 'copy'),
    0,
    'preparing 唯一异物的续传校验也必须保持零 POST'
  )

  const unresolvedDrive = new FailNthCopyDrive(twoVideoSourceTree(), 2)
  const unresolvedPlan = await buildMaterialCopyPlan({
    drive: unresolvedDrive,
    manifest: twoListingManifest()
  })
  const unresolvedIntents = []
  const unresolvedIntentWriteCounts = []
  const unresolvedError = await expectReject(
    executeMaterialCopyPlan({
      drive: unresolvedDrive,
      plan: unresolvedPlan,
      apply: true,
      confirmPlanSha256: unresolvedPlan.planSha256,
      readbackAttempts: 2,
      readbackDelayMs: 0,
      onIntent: async (receipt) => {
        unresolvedIntents.push(JSON.parse(JSON.stringify(receipt)))
        unresolvedIntentWriteCounts.push({
          folders: countCalls(unresolvedDrive, 'create_folder'),
          copies: countCalls(unresolvedDrive, 'copy')
        })
      }
    }),
    /synthetic copy interruption/,
    '普通复制异常必须保留 preparing 未决动作'
  )
  assert.strictEqual(unresolvedIntents.length, 2, '每个动作都必须在首次 Drive 写入前先持久化 intent')
  assert.deepStrictEqual(
    Object.keys(unresolvedError.partialResult.receipt.inFlight).sort(),
    ['bucket', 'destinationFingerprint', 'phase', 'sourceFingerprint'],
    '未决动作只能保存稳定身份、目标桶和安全阶段'
  )
  assert.strictEqual(
    unresolvedError.partialResult.receipt.inFlight.phase,
    'preparing',
    '没有真实请求不确定证明的普通错误必须停留在 preparing'
  )
  assert.strictEqual(
    unresolvedError.partialResult.receipt.completed.length,
    1,
    '第二项结果不确定时只能确认第一项完成'
  )
  assert.strictEqual(
    unresolvedIntents[0].completed.length,
    0,
    '首项 intent 必须早于任何已完成动作'
  )
  assert.deepStrictEqual(
    unresolvedIntentWriteCounts[0],
    { folders: 0, copies: 0 },
    '首项 intent 必须早于 resolveTargetFolder 引发的任何 Drive 写入'
  )
  assert.strictEqual(unresolvedIntentWriteCounts[1].copies, 1, '第二项 intent 前只能存在首项复制')
  assert.ok(
    unresolvedIntentWriteCounts[1].folders < countCalls(unresolvedDrive, 'create_folder'),
    '第二项 intent 必须早于该项新增目标目录'
  )
  const unresolvedSecondCopies = () => unresolvedDrive.calls.filter(
    (call) => call.operation === 'copy' && call.sourceToken === 'source-video-secret-token-b'
  ).length
  assert.strictEqual(unresolvedSecondCopies(), 1, '结果不确定项首次只能有一个复制 POST')
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: unresolvedError.partialResult.receipt
    }),
    /准备阶段|结果不确定仍不可见|禁止.*重发/,
    '未决目标仍不可见时必须硬阻断续传'
  )
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: unresolvedError.partialResult.receipt
    }),
    /准备阶段|结果不确定仍不可见|禁止.*重发/,
    '重复构建续传计划仍必须只读阻断'
  )
  assert.strictEqual(unresolvedSecondCopies(), 1, '重复 build 不得对结果不确定项再次 POST')

  const unresolvedOperation = unresolvedPlan.operations[1]
  const unresolvedTargetFolder = findMockTargetFolderToken(
    unresolvedDrive,
    ROOTS.activeRootToken,
    unresolvedOperation.targetSegments
  )
  unresolvedDrive.nodes.get(unresolvedTargetFolder).push({
    token: 'late-non-file-token',
    name: unresolvedOperation.targetName,
    type: 'folder'
  })
  unresolvedDrive.nodes.set('late-non-file-token', [])
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: unresolvedError.partialResult.receipt
    }),
    /准备阶段|禁止自动晋升|禁止.*重发/,
    'preparing 未决目标同名项不是文件时必须阻断'
  )
  unresolvedDrive.nodes.set(
    unresolvedTargetFolder,
    unresolvedDrive.nodes.get(unresolvedTargetFolder).filter(
      (item) => item.token !== 'late-non-file-token'
    )
  )
  unresolvedDrive.nodes.delete('late-non-file-token')
  unresolvedDrive.nodes.get(unresolvedTargetFolder).push(
    {
      token: 'late-duplicate-copy-token-a',
      name: unresolvedOperation.targetName,
      type: 'file',
      modifiedTime: 'late-duplicate-version-a'
    },
    {
      token: 'late-duplicate-copy-token-b',
      name: unresolvedOperation.targetName,
      type: 'file',
      modifiedTime: 'late-duplicate-version-b'
    }
  )
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: unresolvedError.partialResult.receipt
    }),
    /准备阶段|禁止自动晋升|禁止.*重发/,
    'preparing 未决目标出现多个同名文件时必须阻断'
  )
  unresolvedDrive.nodes.set(
    unresolvedTargetFolder,
    unresolvedDrive.nodes.get(unresolvedTargetFolder).filter(
      (item) => !item.token.startsWith('late-duplicate-copy-token-')
    )
  )
  unresolvedDrive.nodes.get(unresolvedTargetFolder).push({
    token: 'foreign-race-token',
    name: unresolvedOperation.targetName,
    type: 'file',
    modifiedTime: 'foreign-race-version'
  })
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: unresolvedError.partialResult.receipt
    }),
    /准备阶段|禁止自动晋升|禁止.*重发/,
    'onIntent 后 copy POST 前并发出现的唯一外来文件不得冒充复制结果'
  )
  assert.strictEqual(unresolvedSecondCopies(), 1, 'preparing 外来目标不得触发任何新 POST')
  unresolvedDrive.nodes.set(
    unresolvedTargetFolder,
    unresolvedDrive.nodes.get(unresolvedTargetFolder).filter(
      (item) => item.token !== 'foreign-race-token'
    )
  )

  const tamperedInFlight = JSON.parse(JSON.stringify(unresolvedError.partialResult.receipt))
  tamperedInFlight.inFlight.bucket = tamperedInFlight.inFlight.bucket === 'active'
    ? 'pending'
    : 'active'
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: tamperedInFlight
    }),
    /状态完整性|state/i,
    '篡改 inFlight 但不重算状态 SHA 必须稳定失败'
  )
  const tamperedPhase = JSON.parse(JSON.stringify(unresolvedError.partialResult.receipt))
  tamperedPhase.inFlight.phase = 'request-uncertain'
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: tamperedPhase
    }),
    /状态完整性|state/i,
    '只篡改 preparing/request-uncertain 阶段但不重算状态 SHA 必须稳定失败'
  )
  const legacyV2Receipt = JSON.parse(JSON.stringify(unresolvedError.partialResult.receipt))
  legacyV2Receipt.version = 2
  delete legacyV2Receipt.inFlight.phase
  legacyV2Receipt.planBindingSha256 = canonicalSha256({
    version: legacyV2Receipt.version,
    originalPlanSha256: legacyV2Receipt.originalPlanSha256,
    sourcePlanFingerprint: legacyV2Receipt.sourcePlanFingerprint
  })
  legacyV2Receipt.stateSha256 = canonicalSha256({
    version: legacyV2Receipt.version,
    planBindingSha256: legacyV2Receipt.planBindingSha256,
    completed: legacyV2Receipt.completed,
    inFlight: legacyV2Receipt.inFlight
  })
  const legacyV2CopiesBefore = unresolvedSecondCopies()
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: legacyV2Receipt
    }),
    /版本不受支持/,
    '缺少可信阶段证明的 v2 inFlight 必须原样 fail-closed，禁止自动迁移'
  )
  assert.strictEqual(
    unresolvedSecondCopies(),
    legacyV2CopiesBefore,
    '拒绝 v2 回执时不得产生任何新 copy POST'
  )
  const wrongNextInFlight = JSON.parse(JSON.stringify(unresolvedError.partialResult.receipt))
  wrongNextInFlight.inFlight.sourceFingerprint = 'not-the-next-source'
  refreshReceiptStateSha256(wrongNextInFlight)
  await expectReject(
    buildMaterialResumePlan({
      drive: unresolvedDrive,
      manifest: twoListingManifest(),
      resumeReceipt: wrongNextInFlight
    }),
    /下一动作/,
    '即使重算状态 SHA，inFlight 也必须精确对应 completed 后的下一动作'
  )

  const trueUncertainDrive = new MockDrive(goodSourceTree())
  const trueUncertainDiscovery = await buildMaterialCopyPlan({
    drive: trueUncertainDrive,
    manifest: manifest()
  })
  const trueUncertainOperation = trueUncertainDiscovery.operations[0]
  const trueUncertainTargetFolder = prebuildMockTargetFolders(
    trueUncertainDrive,
    ROOTS.activeRootToken,
    trueUncertainOperation.targetSegments
  )
  trueUncertainDrive.calls = []
  const trueUncertainPlan = await buildMaterialCopyPlan({
    drive: trueUncertainDrive,
    manifest: manifest()
  })
  let trueUncertainPosts = 0
  const trueUncertainClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    driveQps: 4,
    ambiguousCopyReadbackAttempts: 1,
    ambiguousCopyReadbackDelayMs: 0,
    fetchImpl: async (url) => {
      const text = String(url)
      const response = (payload, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return payload
        }
      })
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return response({
          code: 0,
          tenant_access_token: 'synthetic-tenant-token'
        })
      }
      if (/\/drive\/v1\/files\/[^/]+\/copy$/.test(new URL(text).pathname)) {
        trueUncertainPosts += 1
        return response({ code: 1061001, msg: 'internal error' }, 500)
      }
      return response({
        code: 0,
        data: {
          files: [],
          has_more: false
        }
      })
    }
  })
  trueUncertainDrive.copyFile = async (sourceToken, targetFolderToken, name) => {
    trueUncertainDrive.calls.push({
      operation: 'copy',
      sourceToken,
      targetFolderToken,
      name
    })
    return trueUncertainClient.copyFile(sourceToken, targetFolderToken, name)
  }
  const trueUncertainIntents = []
  const trueUncertainError = await expectReject(
    executeMaterialCopyPlan({
      drive: trueUncertainDrive,
      plan: trueUncertainPlan,
      apply: true,
      confirmPlanSha256: trueUncertainPlan.planSha256,
      onIntent: async (receipt) => {
        trueUncertainIntents.push(JSON.parse(JSON.stringify(receipt)))
      }
    }),
    /飞书素材接口失败/,
    '真实 HTTP500/code1061001 且回读不可见时必须保留请求不确定证明'
  )
  assert.deepStrictEqual(
    trueUncertainIntents.map((receipt) => receipt.inFlight.phase),
    ['preparing', 'request-uncertain'],
    '真实请求进入前后必须分别持久化 preparing 和 request-uncertain'
  )
  assert.strictEqual(
    trueUncertainError.partialResult.receipt.inFlight.phase,
    'request-uncertain',
    '真实不确定请求失败的 partialResult 必须进入 request-uncertain'
  )
  assert.strictEqual(trueUncertainPosts, 1, '真实不确定请求只能发送一次 POST')

  const mixedUncertainDrive = new MockDrive(goodSourceTree())
  const mixedUncertainDiscovery = await buildMaterialCopyPlan({
    drive: mixedUncertainDrive,
    manifest: manifest()
  })
  const mixedUncertainOperation = mixedUncertainDiscovery.operations[0]
  const mixedUncertainTargetFolder = prebuildMockTargetFolders(
    mixedUncertainDrive,
    ROOTS.activeRootToken,
    mixedUncertainOperation.targetSegments
  )
  mixedUncertainDrive.calls = []
  const mixedUncertainPlan = await buildMaterialCopyPlan({
    drive: mixedUncertainDrive,
    manifest: manifest()
  })
  let mixedUncertainPosts = 0
  let mixedUncertainInjected = false
  const mixedUncertainItems = [
    {
      token: 'mixed-uncertain-file-token',
      name: mixedUncertainOperation.targetName,
      type: 'file',
      modified_time: 'mixed-uncertain-file-version'
    },
    {
      token: 'mixed-uncertain-folder-token',
      name: mixedUncertainOperation.targetName,
      type: 'folder'
    },
    {
      token: 'mixed-uncertain-shortcut-token',
      name: mixedUncertainOperation.targetName,
      type: 'shortcut'
    }
  ]
  const mixedUncertainClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    driveQps: 4,
    ambiguousCopyReadbackAttempts: 1,
    ambiguousCopyReadbackDelayMs: 0,
    fetchImpl: async (url) => {
      const text = String(url)
      const response = (payload, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return payload
        }
      })
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return response({
          code: 0,
          tenant_access_token: 'synthetic-tenant-token'
        })
      }
      if (/\/drive\/v1\/files\/[^/]+\/copy$/.test(new URL(text).pathname)) {
        mixedUncertainPosts += 1
        if (!mixedUncertainInjected) {
          mixedUncertainInjected = true
          mixedUncertainDrive.nodes.get(mixedUncertainTargetFolder).push(
            ...mixedUncertainItems.map((item) => ({
              token: item.token,
              name: item.name,
              type: item.type,
              modifiedTime: item.modified_time
            }))
          )
          mixedUncertainDrive.nodes.set('mixed-uncertain-folder-token', [])
        }
        return response({ code: 1061001, msg: 'internal error' }, 500)
      }
      return response({
        code: 0,
        data: {
          files: mixedUncertainItems,
          has_more: false
        }
      })
    }
  })
  mixedUncertainDrive.copyFile = async (sourceToken, targetFolderToken, name) => {
    mixedUncertainDrive.calls.push({
      operation: 'copy',
      sourceToken,
      targetFolderToken,
      name
    })
    return mixedUncertainClient.copyFile(sourceToken, targetFolderToken, name)
  }
  const mixedUncertainIntents = []
  const mixedUncertainError = await expectReject(
    executeMaterialCopyPlan({
      drive: mixedUncertainDrive,
      plan: mixedUncertainPlan,
      apply: true,
      confirmPlanSha256: mixedUncertainPlan.planSha256,
      readbackAttempts: 1,
      readbackDelayMs: 0,
      onIntent: async (receipt) => {
        mixedUncertainIntents.push(JSON.parse(JSON.stringify(receipt)))
      }
    }),
    /同名|目标冲突/,
    'HTTP500/code1061001 后回读同名 file+folder+shortcut 必须阻断'
  )
  assert.strictEqual(
    mixedUncertainPosts,
    1,
    '不确定复制回读同名混合类型前后只能发送一次 POST'
  )
  assert.deepStrictEqual(
    mixedUncertainIntents.map((receipt) => receipt.inFlight.phase),
    ['preparing', 'request-uncertain'],
    '同名混合冲突也必须保留真实请求前后的阶段证明'
  )
  assert.strictEqual(
    mixedUncertainError.partialResult.receipt.inFlight.phase,
    'request-uncertain',
    '真实不确定 POST 后的同名混合冲突必须保留 request-uncertain'
  )
  assert.strictEqual(
    mixedUncertainError.partialResult.receipt.completed.length,
    0,
    '不确定复制的同名混合冲突不得误晋升 completed'
  )

  let postRequestDuplicatePosts = 0
  const postRequestDuplicateClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    driveQps: 4,
    ambiguousCopyReadbackAttempts: 1,
    ambiguousCopyReadbackDelayMs: 0,
    fetchImpl: async (url) => {
      const text = String(url)
      const response = (payload, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return payload
        }
      })
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return response({
          code: 0,
          tenant_access_token: 'synthetic-tenant-token'
        })
      }
      if (/\/drive\/v1\/files\/[^/]+\/copy$/.test(new URL(text).pathname)) {
        postRequestDuplicatePosts += 1
        return response({ code: 1061001, msg: 'internal error' }, 500)
      }
      return response({
        code: 0,
        data: {
          files: [
            {
              token: 'post-request-duplicate-a',
              name: trueUncertainOperation.targetName,
              type: 'file',
              modified_time: 'post-request-duplicate-version-a'
            },
            {
              token: 'post-request-duplicate-b',
              name: trueUncertainOperation.targetName,
              type: 'file',
              modified_time: 'post-request-duplicate-version-b'
            }
          ],
          has_more: false
        }
      })
    }
  })
  trueUncertainDrive.copyFile = async (sourceToken, targetFolderToken, name) => {
    trueUncertainDrive.calls.push({
      operation: 'copy',
      sourceToken,
      targetFolderToken,
      name
    })
    return postRequestDuplicateClient.copyFile(sourceToken, targetFolderToken, name)
  }
  const postRequestDuplicateError = await expectReject(
    executeMaterialCopyPlan({
      drive: trueUncertainDrive,
      plan: trueUncertainPlan,
      apply: true,
      confirmPlanSha256: trueUncertainPlan.planSha256
    }),
    /多个同名文件/,
    '真实 POST 后回读多个同名目标必须阻断'
  )
  assert.strictEqual(postRequestDuplicatePosts, 1, '回读重复目标前只能发出一个真实 POST')
  assert.strictEqual(
    postRequestDuplicateError.partialResult.receipt.inFlight.phase,
    'request-uncertain',
    '真实 POST 后的重复目标冲突也必须保留 request-uncertain 阶段事实'
  )

  await expectReject(
    buildMaterialResumePlan({
      drive: trueUncertainDrive,
      manifest: manifest(),
      resumeReceipt: trueUncertainError.partialResult.receipt
    }),
    /结果不确定仍不可见|禁止重发/,
    'request-uncertain 目标仍不可见时必须只读阻断'
  )
  assert.strictEqual(trueUncertainPosts, 1, '不可见 request-uncertain 续传不得重发 POST')

  trueUncertainDrive.nodes.get(trueUncertainTargetFolder).push({
    token: 'uncertain-late-non-file-token',
    name: trueUncertainOperation.targetName,
    type: 'folder'
  })
  trueUncertainDrive.nodes.set('uncertain-late-non-file-token', [])
  await expectReject(
    buildMaterialResumePlan({
      drive: trueUncertainDrive,
      manifest: manifest(),
      resumeReceipt: trueUncertainError.partialResult.receipt
    }),
    /不是唯一文件|禁止重发/,
    'request-uncertain 同名目标不是文件时必须阻断'
  )
  trueUncertainDrive.nodes.set(
    trueUncertainTargetFolder,
    trueUncertainDrive.nodes.get(trueUncertainTargetFolder).filter(
      (item) => item.token !== 'uncertain-late-non-file-token'
    )
  )
  trueUncertainDrive.nodes.delete('uncertain-late-non-file-token')
  trueUncertainDrive.nodes.get(trueUncertainTargetFolder).push(
    {
      token: 'uncertain-late-duplicate-a',
      name: trueUncertainOperation.targetName,
      type: 'file',
      modifiedTime: 'uncertain-late-duplicate-version-a'
    },
    {
      token: 'uncertain-late-duplicate-b',
      name: trueUncertainOperation.targetName,
      type: 'file',
      modifiedTime: 'uncertain-late-duplicate-version-b'
    }
  )
  await expectReject(
    buildMaterialResumePlan({
      drive: trueUncertainDrive,
      manifest: manifest(),
      resumeReceipt: trueUncertainError.partialResult.receipt
    }),
    /不是唯一文件|禁止重发/,
    'request-uncertain 出现多个同名目标时必须阻断'
  )
  trueUncertainDrive.nodes.set(
    trueUncertainTargetFolder,
    trueUncertainDrive.nodes.get(trueUncertainTargetFolder).filter(
      (item) => !item.token.startsWith('uncertain-late-duplicate-')
    )
  )
  trueUncertainDrive.nodes.get(trueUncertainTargetFolder).push({
    token: 'uncertain-late-visible-token',
    name: trueUncertainOperation.targetName,
    type: 'file',
    modifiedTime: 'uncertain-late-visible-version'
  })
  const trueUncertainResumePlan = await buildMaterialResumePlan({
    drive: trueUncertainDrive,
    manifest: manifest(),
    resumeReceipt: trueUncertainError.partialResult.receipt
  })
  assert.strictEqual(trueUncertainResumePlan.completedCount, 1, '唯一迟到目标必须安全晋升 completed')
  assert.strictEqual(trueUncertainResumePlan.operations.length, 0, '安全收敛后不得保留重复动作')
  assert.strictEqual(trueUncertainResumePlan.resumeReceipt.inFlight, null, '安全收敛后必须清空 inFlight')
  const trueUncertainResult = await executeMaterialResumePlan({
    drive: trueUncertainDrive,
    plan: trueUncertainResumePlan,
    apply: true,
    confirmPlanSha256: trueUncertainResumePlan.planSha256
  })
  assert.strictEqual(trueUncertainResult.copied, 0, '执行二次重验不得重新复制迟到目标')
  assert.strictEqual(trueUncertainPosts, 1, '迟到目标收敛后的真实 POST 总数必须保持 1')

  const wrongTokenFixture = await createInterruptedFixture()
  const wrongTokenReceipt = JSON.parse(JSON.stringify(
    wrongTokenFixture.error.partialResult.receipt
  ))
  wrongTokenReceipt.completed[0].targetToken = 'wrong-target-token'
  refreshReceiptStateSha256(wrongTokenReceipt)
  const wrongTokenCopiesBefore = countCalls(wrongTokenFixture.drive, 'copy')
  await expectReject(
    buildMaterialResumePlan({
      drive: wrongTokenFixture.drive,
      manifest: twoListingManifest(),
      resumeReceipt: wrongTokenReceipt
    }),
    /token|回读/,
    'receipt 目标 token 与真实回读不一致时必须拒绝续传'
  )
  assert.strictEqual(
    countCalls(wrongTokenFixture.drive, 'copy'),
    wrongTokenCopiesBefore,
    '错误目标 token 的续传校验不得产生写动作'
  )

  const sourceChangedFixture = await createInterruptedFixture()
  sourceChangedFixture.drive.nodes.get('room-folder-token-b')[0].modifiedTime = 'mock-version-changed'
  await expectReject(
    buildMaterialResumePlan({
      drive: sourceChangedFixture.drive,
      manifest: twoListingManifest(),
      resumeReceipt: sourceChangedFixture.error.partialResult.receipt
    }),
    /源计划已变化/,
    '源素材版本变化后旧 receipt 必须失效'
  )

  const extraConflictFixture = await createInterruptedFixture()
  extraConflictFixture.drive.nodes.get(ROOTS.activeRootToken).push({
    token: 'extra-conflict-token',
    name: '杭州',
    type: 'file',
    modifiedTime: 'mock-version-extra'
  })
  await expectReject(
    buildMaterialResumePlan({
      drive: extraConflictFixture.drive,
      manifest: twoListingManifest(),
      resumeReceipt: extraConflictFixture.error.partialResult.receipt
    }),
    /额外阻断/,
    '除已完成目标的 TARGET_CONFLICT 外出现任何额外阻断都必须拒绝续传'
  )

  const nonPrefixFixture = await createInterruptedFixture()
  const nonPrefixReceipt = JSON.parse(JSON.stringify(
    nonPrefixFixture.error.partialResult.receipt
  ))
  const secondIdentity = nonPrefixFixture.plan.operations[1]
  nonPrefixReceipt.completed[0].sourceFingerprint = secondIdentity.sourceFingerprint
  nonPrefixReceipt.completed[0].destinationFingerprint = canonicalSha256(
    [
      ...secondIdentity.targetSegments,
      secondIdentity.targetName
    ].join('\u001f')
  )
  refreshReceiptStateSha256(nonPrefixReceipt)
  await expectReject(
    buildMaterialResumePlan({
      drive: nonPrefixFixture.drive,
      manifest: twoListingManifest(),
      resumeReceipt: nonPrefixReceipt
    }),
    /严格前缀/,
    'receipt 跳过首项而声称后项完成时必须拒绝'
  )

  const wrongOriginalFixture = await createInterruptedFixture()
  const wrongOriginalReceipt = JSON.parse(JSON.stringify(
    wrongOriginalFixture.error.partialResult.receipt
  ))
  wrongOriginalReceipt.originalPlanSha256 = '0'.repeat(64)
  wrongOriginalReceipt.planBindingSha256 = canonicalSha256({
    version: wrongOriginalReceipt.version,
    originalPlanSha256: wrongOriginalReceipt.originalPlanSha256,
    sourcePlanFingerprint: wrongOriginalReceipt.sourcePlanFingerprint
  })
  await expectReject(
    buildMaterialResumePlan({
      drive: wrongOriginalFixture.drive,
      manifest: twoListingManifest(),
      resumeReceipt: wrongOriginalReceipt
    }),
    /原计划校验材料/,
    'receipt 原计划 SHA 与绑定哈希一起被替换时仍必须由原计划校验材料拒绝'
  )

  const safeSummary = toSafePlanSummary(goodPlan)
  const safeText = JSON.stringify(safeSummary)
  ;[
    ROOTS.sourceRootToken,
    ROOTS.activeRootToken,
    ROOTS.pendingRootToken,
    'source-video-secret-token',
    'source-record-secret-id',
    '员工原视频.mp4',
    '测试花园15-2-T01'
  ].forEach((secret) => {
    assert.ok(!safeText.includes(secret), `日志摘要不得泄露 token、记录 ID、源文件名或完整房源路径：${secret}`)
  })
  assert.strictEqual(safeSummary.planSha256, goodPlan.planSha256, '安全摘要必须保留用于人工确认的计划 SHA-256')
  assert.strictEqual(safeSummary.counts.activeCopies, 1, '安全摘要必须保留可审计计数')

  const parsedDryRun = parseCliArgs(['--input', 'synthetic-plan.json'])
  assert.strictEqual(parsedDryRun.apply, false, '命令行入口默认必须是 dry-run')
  assert.strictEqual(parsedDryRun.confirmPlanSha256, '', '默认不得隐式确认计划')
  assert.throws(
    () => parseCliArgs(['--input', 'synthetic-plan.json', '--apply']),
    /--confirm-plan-sha256/,
    '命令行真实复制必须同时提供确认 SHA-256'
  )
  assert.throws(
    () => parseCliArgs(['--input', 'synthetic-plan.json', '--confirm-plan-sha256', '0'.repeat(64)]),
    /--apply/,
    '只有确认哈希但没有 --apply 也必须拒绝，避免操作者误判执行模式'
  )
  assert.throws(
    () => parseCliArgs(['--input', 'synthetic-plan.json', '--delete']),
    /未知参数/,
    '命令行入口不得接受删除、移动等未授权参数'
  )
  assert.throws(
    () => parseCliArgs([
      '--input',
      'synthetic-plan.json',
      '--apply',
      '--confirm-plan-sha256',
      '0'.repeat(64)
    ]),
    /--resume-state/,
    '真实复制必须指定私有续传状态文件，不能只在进程内保留进度'
  )
  assert.throws(
    () => parseCliArgs(['--input', 'synthetic-plan.json', '--resume']),
    /--resume-state/,
    '续传预演必须显式指定私有状态文件'
  )
  const parsedResume = parseCliArgs([
    '--input',
    'synthetic-plan.json',
    '--resume',
    '--resume-state',
    'private-resume.json'
  ])
  assert.strictEqual(parsedResume.resume, true, '--resume 必须进入续传模式')
  assert.strictEqual(
    parsedResume.resumeState,
    'private-resume.json',
    '续传状态路径只应保留在进程参数，不进入安全输出'
  )
  const syntheticProjectRoot = require('path').resolve(__dirname, '..', '..')
  assert.throws(
    () => assertPrivateInputPath(
      require('path').resolve(syntheticProjectRoot, 'server', 'private-plan.json'),
      { projectRoot: syntheticProjectRoot }
    ),
    /项目目录之外/,
    '计划输入即使内容合法也不得放入仓库'
  )
  const lexicalOutsideThroughJunction = require('path').resolve(
    syntheticProjectRoot,
    '..',
    'junction-back-into-project',
    'resume.json'
  )
  assert.throws(
    () => assertPrivateResumeStatePath(lexicalOutsideThroughJunction, {
      projectRoot: syntheticProjectRoot,
      existsSync: (candidate) => (
        require('path').resolve(candidate) !== lexicalOutsideThroughJunction
      ),
      realpathSync: (candidate) => (
        require('path').resolve(candidate) === require('path').dirname(lexicalOutsideThroughJunction)
          ? syntheticProjectRoot
          : require('path').resolve(candidate)
      )
    }),
    /实际路径|项目目录之外/,
    '仓库外 junction 指回项目时不得绕过私有状态路径门禁'
  )
  assert.throws(
    () => assertPrivateInputPath(lexicalOutsideThroughJunction, {
      projectRoot: syntheticProjectRoot,
      existsSync: (candidate) => (
        require('path').resolve(candidate) !== lexicalOutsideThroughJunction
      ),
      realpathSync: (candidate) => (
        require('path').resolve(candidate) === require('path').dirname(lexicalOutsideThroughJunction)
          ? syntheticProjectRoot
          : require('path').resolve(candidate)
      )
    }),
    /实际路径|项目目录之外/,
    '仓库外 junction 指回项目时也不得绕过计划输入路径门禁'
  )
  if (process.platform === 'win32') {
    const aliasInputPath = require('path').resolve(
      __dirname,
      '..',
      '..',
      '..',
      'PRIVATE-MATERIAL-ALIAS.JSON'
    )
    const aliasStatePath = aliasInputPath.toLowerCase()
    const aliasDrive = new MockDrive(goodSourceTree())
    const aliasPlan = await buildMaterialCopyPlan({
      drive: aliasDrive,
      manifest: manifest()
    })
    await expectReject(
      runCli({
        argv: [
          '--input',
          aliasInputPath,
          '--resume-state',
          aliasStatePath,
          '--apply',
          '--confirm-plan-sha256',
          aliasPlan.planSha256
        ],
        env: {
          FEISHU_APP_ID: 'secret-app-id',
          FEISHU_APP_SECRET: 'secret-app-secret'
        },
        readFile: () => JSON.stringify(manifest()),
        writeFile: () => undefined,
        renameFile: () => undefined,
        removeFile: () => undefined,
        createDrive: () => aliasDrive,
        writeLine: () => undefined
      }),
      /不得覆盖计划输入文件/,
      'Windows 大小写别名不得把续传状态覆盖到计划输入本体'
    )
  }

  const cliDrive = new MockDrive(goodSourceTree())
  const cliOutput = []
  const cliDryRunInputPath = privateTestPath('synthetic-plan.json')
  const cliResult = await runCli({
    argv: ['--input', cliDryRunInputPath],
    env: {
      FEISHU_APP_ID: 'secret-app-id',
      FEISHU_APP_SECRET: 'secret-app-secret'
    },
    readFile: () => JSON.stringify(manifest()),
    createDrive: () => cliDrive,
    writeLine: (line) => cliOutput.push(String(line))
  })
  assert.strictEqual(cliResult.dryRun, true, '命令行默认必须返回 dry-run')
  assert.strictEqual(countCalls(cliDrive, 'create_folder'), 0, '命令行 dry-run 不得创建目录')
  assert.strictEqual(countCalls(cliDrive, 'copy'), 0, '命令行 dry-run 不得复制文件')
  const cliText = cliOutput.join('\n')
  ;[
    'secret-app-id',
    'secret-app-secret',
    ROOTS.sourceRootToken,
    ROOTS.activeRootToken,
    ROOTS.pendingRootToken,
    'source-video-secret-token',
    'source-record-secret-id',
    '员工原视频.mp4'
  ].forEach((secret) => {
    assert.ok(!cliText.includes(secret), `命令行日志不得泄露凭据、token、记录ID或源文件名：${secret}`)
  })
  assert.ok(cliText.includes(goodPlan.planSha256), '命令行 dry-run 必须输出可供第二步确认的计划 SHA-256')

  const repeatedApplyDrive = new FailNthCopyDrive(goodSourceTree(), 1)
  const repeatedApplyDiscovery = await buildMaterialCopyPlan({
    drive: repeatedApplyDrive,
    manifest: manifest()
  })
  prebuildMockTargetFolders(
    repeatedApplyDrive,
    ROOTS.activeRootToken,
    repeatedApplyDiscovery.operations[0].targetSegments
  )
  repeatedApplyDrive.calls = []
  const repeatedApplyPlan = await buildMaterialCopyPlan({
    drive: repeatedApplyDrive,
    manifest: manifest()
  })
  const repeatedApplyFiles = new Map()
  const repeatedApplyInputPath = privateTestPath('synthetic-repeated-apply.json')
  const repeatedApplyStatePath = require('path').resolve(
    __dirname,
    '..',
    '..',
    '..',
    'private-repeated-apply-state.json'
  )
  repeatedApplyFiles.set(repeatedApplyInputPath, JSON.stringify(manifest()))
  const repeatedApplyRead = (filePath) => {
    const resolved = require('path').resolve(filePath)
    if (!repeatedApplyFiles.has(resolved)) throw new Error('synthetic repeated apply file missing')
    return repeatedApplyFiles.get(resolved)
  }
  const repeatedApplyWrite = (filePath, content, fileOptions = {}) => {
    const resolved = require('path').resolve(filePath)
    if (fileOptions.flag === 'wx' && repeatedApplyFiles.has(resolved)) {
      const error = new Error('synthetic EEXIST')
      error.code = 'EEXIST'
      throw error
    }
    repeatedApplyFiles.set(resolved, String(content))
  }
  const repeatedApplyRename = (fromPath, toPath) => {
    const from = require('path').resolve(fromPath)
    const to = require('path').resolve(toPath)
    repeatedApplyFiles.set(to, repeatedApplyFiles.get(from))
    repeatedApplyFiles.delete(from)
  }
  const repeatedApplyRemove = (filePath) => {
    repeatedApplyFiles.delete(require('path').resolve(filePath))
  }
  const repeatedApplyArgs = [
    '--input',
    repeatedApplyInputPath,
    '--resume-state',
    repeatedApplyStatePath,
    '--apply',
    '--confirm-plan-sha256',
    repeatedApplyPlan.planSha256
  ]
  await expectReject(
    runCli({
      argv: repeatedApplyArgs,
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      existsSync: (filePath) => repeatedApplyFiles.has(require('path').resolve(filePath)),
      readFile: repeatedApplyRead,
      writeFile: repeatedApplyWrite,
      renameFile: repeatedApplyRename,
      removeFile: repeatedApplyRemove,
      createDrive: () => repeatedApplyDrive,
      writeLine: () => undefined
    }),
    /synthetic copy interruption/,
    '首次普通 apply 的不确定失败必须落盘未决状态'
  )
  assert.strictEqual(
    repeatedApplyDrive.calls.filter((call) => call.operation === 'copy').length,
    1,
    '首次不确定失败只能产生一次 copy POST'
  )
  const repeatedApplyStateBytes = repeatedApplyFiles.get(repeatedApplyStatePath)
  assert.ok(JSON.parse(repeatedApplyStateBytes).inFlight, '首次失败状态必须保留 inFlight')
  await expectReject(
    runCli({
      argv: repeatedApplyArgs,
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      existsSync: (filePath) => repeatedApplyFiles.has(require('path').resolve(filePath)),
      readFile: repeatedApplyRead,
      writeFile: repeatedApplyWrite,
      renameFile: repeatedApplyRename,
      removeFile: repeatedApplyRemove,
      createDrive: () => repeatedApplyDrive,
      writeLine: () => undefined
    }),
    /已存在|--resume/,
    '已有状态时重复普通 apply 必须拒绝并要求显式续传'
  )
  assert.strictEqual(
    repeatedApplyDrive.calls.filter((call) => call.operation === 'copy').length,
    1,
    '重复普通 apply 不得覆盖 inFlight 后再次 copy POST'
  )
  assert.strictEqual(
    repeatedApplyFiles.get(repeatedApplyStatePath),
    repeatedApplyStateBytes,
    '重复普通 apply 必须保持原状态文件语义和字节完全不变'
  )
  assert.ok(
    !repeatedApplyFiles.has(`${repeatedApplyStatePath}.lock`),
    '首次执行异常退出时必须释放本进程持有的独占锁'
  )

  const concurrentResumeFixture = await createInterruptedFixture()
  const concurrentResumePlan = await buildMaterialResumePlan({
    drive: concurrentResumeFixture.drive,
    manifest: twoListingManifest(),
    resumeReceipt: concurrentResumeFixture.error.partialResult.receipt
  })
  const concurrentFiles = new Map()
  let concurrentLockAttempts = 0
  let concurrentCreateDriveCalls = 0
  let releaseFirstConcurrentLock
  const firstConcurrentLockHeld = new Promise((resolve) => {
    releaseFirstConcurrentLock = resolve
  })
  const concurrentInputPath = privateTestPath('synthetic-concurrent-resume.json')
  const concurrentStatePath = require('path').resolve(
    __dirname,
    '..',
    '..',
    '..',
    'private-concurrent-resume-state.json'
  )
  concurrentFiles.set(concurrentInputPath, JSON.stringify(twoListingManifest()))
  concurrentFiles.set(
    concurrentStatePath,
    `${JSON.stringify(concurrentResumeFixture.error.partialResult.receipt)}\n`
  )
  const concurrentRead = (filePath) => {
    const resolved = require('path').resolve(filePath)
    if (!concurrentFiles.has(resolved)) throw new Error('synthetic concurrent file missing')
    return concurrentFiles.get(resolved)
  }
  const concurrentWrite = (filePath, content, fileOptions = {}) => {
    const resolved = require('path').resolve(filePath)
    if (resolved === `${concurrentStatePath}.lock`) {
      concurrentLockAttempts += 1
    }
    if (fileOptions.flag === 'wx' && concurrentFiles.has(resolved)) {
      if (resolved === `${concurrentStatePath}.lock`) releaseFirstConcurrentLock()
      const error = new Error('synthetic EEXIST')
      error.code = 'EEXIST'
      throw error
    }
    concurrentFiles.set(resolved, String(content))
    if (resolved === `${concurrentStatePath}.lock`) return firstConcurrentLockHeld
  }
  const concurrentRename = (fromPath, toPath) => {
    const from = require('path').resolve(fromPath)
    const to = require('path').resolve(toPath)
    concurrentFiles.set(to, concurrentFiles.get(from))
    concurrentFiles.delete(from)
  }
  const concurrentRemove = (filePath) => {
    concurrentFiles.delete(require('path').resolve(filePath))
  }
  const concurrentArgs = [
    '--input',
    concurrentInputPath,
    '--resume',
    '--resume-state',
    concurrentStatePath,
    '--apply',
    '--confirm-plan-sha256',
    concurrentResumePlan.planSha256
  ]
  const concurrentResults = await Promise.allSettled([
    runCli({
      argv: concurrentArgs,
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      existsSync: (filePath) => concurrentFiles.has(require('path').resolve(filePath)),
      readFile: concurrentRead,
      writeFile: concurrentWrite,
      renameFile: concurrentRename,
      removeFile: concurrentRemove,
      createDrive: () => {
        concurrentCreateDriveCalls += 1
        return concurrentResumeFixture.drive
      },
      writeLine: () => undefined
    }),
    runCli({
      argv: concurrentArgs,
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      existsSync: (filePath) => concurrentFiles.has(require('path').resolve(filePath)),
      readFile: concurrentRead,
      writeFile: concurrentWrite,
      renameFile: concurrentRename,
      removeFile: concurrentRemove,
      createDrive: () => {
        concurrentCreateDriveCalls += 1
        return concurrentResumeFixture.drive
      },
      writeLine: () => undefined
    })
  ])
  assert.deepStrictEqual(
    concurrentResults.map((item) => item.status).sort(),
    ['fulfilled', 'rejected'],
    '并发两个 resume apply 必须只有一个获得独占锁'
  )
  assert.match(
    String(concurrentResults.find((item) => item.status === 'rejected').reason.message),
    /并发 apply|正在执行/,
    '未获得锁的并发续传必须给出安全阻断'
  )
  assert.strictEqual(concurrentLockAttempts, 2, 'barrier 必须证明第二进程在第一进程持锁时竞争')
  assert.strictEqual(
    concurrentCreateDriveCalls,
    1,
    '未获得锁的一方必须在创建 Drive 客户端及任何远端读写之前失败'
  )
  assert.strictEqual(
    concurrentResumeFixture.drive.calls.filter(
      (call) => call.operation === 'copy' && call.sourceToken === 'source-video-secret-token-b'
    ).length,
    1,
    '并发续传对同一剩余 source 的 copy POST 总数必须为 1'
  )
  assert.strictEqual(
    JSON.parse(concurrentFiles.get(concurrentStatePath)).completed.length,
    2,
    '获得锁的续传必须完整落盘新 receipt'
  )
  assert.ok(
    !concurrentFiles.has(`${concurrentStatePath}.lock`),
    '并发续传完成后必须释放获胜进程持有的锁'
  )

  const foreignLockDrive = new MockDrive(goodSourceTree())
  const foreignLockPlan = await buildMaterialCopyPlan({
    drive: foreignLockDrive,
    manifest: manifest()
  })
  const foreignLockFiles = new Map()
  const foreignLockInputPath = privateTestPath('synthetic-foreign-lock.json')
  const foreignLockStatePath = require('path').resolve(
    __dirname,
    '..',
    '..',
    '..',
    'private-foreign-lock-state.json'
  )
  const foreignLockPath = `${foreignLockStatePath}.lock`
  const foreignOwnerBytes = '{"version":1,"owner":"foreign-owner"}\n'
  foreignLockFiles.set(foreignLockInputPath, JSON.stringify(manifest()))
  const originalForeignCopy = foreignLockDrive.copyFile.bind(foreignLockDrive)
  foreignLockDrive.copyFile = async (...args) => {
    const copied = await originalForeignCopy(...args)
    foreignLockFiles.set(foreignLockPath, foreignOwnerBytes)
    return copied
  }
  const foreignRead = (filePath) => {
    const resolved = require('path').resolve(filePath)
    if (!foreignLockFiles.has(resolved)) throw new Error('synthetic foreign lock file missing')
    return foreignLockFiles.get(resolved)
  }
  const foreignWrite = (filePath, content, fileOptions = {}) => {
    const resolved = require('path').resolve(filePath)
    if (fileOptions.flag === 'wx' && foreignLockFiles.has(resolved)) {
      const error = new Error('synthetic EEXIST')
      error.code = 'EEXIST'
      throw error
    }
    foreignLockFiles.set(resolved, String(content))
  }
  const foreignRename = (fromPath, toPath) => {
    const from = require('path').resolve(fromPath)
    const to = require('path').resolve(toPath)
    foreignLockFiles.set(to, foreignLockFiles.get(from))
    foreignLockFiles.delete(from)
  }
  const foreignRemove = (filePath) => {
    foreignLockFiles.delete(require('path').resolve(filePath))
  }
  await runCli({
    argv: [
      '--input',
      foreignLockInputPath,
      '--resume-state',
      foreignLockStatePath,
      '--apply',
      '--confirm-plan-sha256',
      foreignLockPlan.planSha256
    ],
    env: {
      FEISHU_APP_ID: 'secret-app-id',
      FEISHU_APP_SECRET: 'secret-app-secret'
    },
    existsSync: (filePath) => foreignLockFiles.has(require('path').resolve(filePath)),
    readFile: foreignRead,
    writeFile: foreignWrite,
    renameFile: foreignRename,
    removeFile: foreignRemove,
    createDrive: () => foreignLockDrive,
    writeLine: () => undefined
  })
  assert.strictEqual(
    foreignLockFiles.get(foreignLockPath),
    foreignOwnerBytes,
    'finally 发现锁已不属于本进程时不得误删他人锁'
  )

  const cliPlanDrive = new MockDrive(twoVideoSourceTree())
  const cliInitialPlan = await buildMaterialCopyPlan({
    drive: cliPlanDrive,
    manifest: twoListingManifest()
  })
  const cliResumeDrive = new MockDrive(twoVideoSourceTree())
  let cliCopyAttempts = 0
  let cliUncertainPosts = 0
  const cliUncertainClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    driveQps: 4,
    ambiguousCopyReadbackAttempts: 1,
    ambiguousCopyReadbackDelayMs: 0,
    fetchImpl: async (url) => {
      const text = String(url)
      const response = (payload, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return payload
        }
      })
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return response({
          code: 0,
          tenant_access_token: 'synthetic-tenant-token'
        })
      }
      if (/\/drive\/v1\/files\/[^/]+\/copy$/.test(new URL(text).pathname)) {
        cliUncertainPosts += 1
        return response({ code: 1061001, msg: 'internal error' }, 500)
      }
      return response({
        code: 0,
        data: {
          files: [],
          has_more: false
        }
      })
    }
  })
  cliResumeDrive.copyFile = async (sourceToken, targetFolderToken, name) => {
    cliCopyAttempts += 1
    if (cliCopyAttempts !== 2) {
      return MockDrive.prototype.copyFile.call(
        cliResumeDrive,
        sourceToken,
        targetFolderToken,
        name
      )
    }
    cliResumeDrive.calls.push({
      operation: 'copy',
      sourceToken,
      targetFolderToken,
      name
    })
    return cliUncertainClient.copyFile(sourceToken, targetFolderToken, name)
  }
  const virtualFiles = new Map()
  const virtualRenames = []
  const virtualWrites = []
  const syntheticInputPath = privateTestPath('synthetic-two-plan.json')
  const syntheticStatePath = require('path').resolve(
    __dirname,
    '..',
    '..',
    '..',
    'private-material-resume.json'
  )
  virtualFiles.set(syntheticInputPath, JSON.stringify(twoListingManifest()))
  const virtualReadFile = (filePath) => {
    const resolved = require('path').resolve(filePath)
    if (!virtualFiles.has(resolved)) throw new Error('synthetic file missing')
    return virtualFiles.get(resolved)
  }
  const virtualWriteFile = (filePath, content, fileOptions) => {
    const resolved = require('path').resolve(filePath)
    if (fileOptions && fileOptions.flag === 'wx' && virtualFiles.has(resolved)) {
      const error = new Error('synthetic EEXIST')
      error.code = 'EEXIST'
      throw error
    }
    virtualFiles.set(resolved, String(content))
    virtualWrites.push({ path: resolved, options: { ...(fileOptions || {}) } })
  }
  const virtualRenameFile = (fromPath, toPath) => {
    const from = require('path').resolve(fromPath)
    const to = require('path').resolve(toPath)
    if (!virtualFiles.has(from)) throw new Error('synthetic temp missing')
    virtualFiles.set(to, virtualFiles.get(from))
    virtualFiles.delete(from)
    virtualRenames.push({ from, to })
  }
  const virtualRemoveFile = (filePath) => {
    virtualFiles.delete(require('path').resolve(filePath))
  }
  const unwritableStateDrive = new MockDrive(twoVideoSourceTree())
  const unwritableStatePlan = await buildMaterialCopyPlan({
    drive: unwritableStateDrive,
    manifest: twoListingManifest()
  })
  const unwritableFiles = new Map()
  const unwritableLockPath = `${syntheticStatePath}.lock`
  await expectReject(
    runCli({
      argv: [
        '--input',
        syntheticInputPath,
        '--resume-state',
        syntheticStatePath,
        '--apply',
        '--confirm-plan-sha256',
        unwritableStatePlan.planSha256
      ],
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      readFile: (filePath) => {
        const resolved = require('path').resolve(filePath)
        if (unwritableFiles.has(resolved)) return unwritableFiles.get(resolved)
        return virtualReadFile(filePath)
      },
      writeFile: (filePath, content) => {
        const resolved = require('path').resolve(filePath)
        if (resolved === unwritableLockPath) {
          unwritableFiles.set(resolved, String(content))
          return
        }
        throw new Error('synthetic state is unwritable')
      },
      renameFile: virtualRenameFile,
      removeFile: (filePath) => {
        unwritableFiles.delete(require('path').resolve(filePath))
      },
      createDrive: () => unwritableStateDrive,
      writeLine: () => undefined
    }),
    /独占创建失败/,
    '状态文件不可写时必须在任何 Drive 写动作之前失败'
  )
  assert.strictEqual(
    countCalls(unwritableStateDrive, 'copy'),
    0,
    '状态文件不可写时不得先复制文件再丢失回执'
  )
  assert.strictEqual(
    countCalls(unwritableStateDrive, 'create_folder'),
    0,
    '状态文件不可写时不得先创建目录再丢失回执'
  )
  assert.ok(!unwritableFiles.has(unwritableLockPath), '状态初始化失败后必须释放本进程独占锁')
  const persistedCliOutput = []
  await expectReject(
    runCli({
      argv: [
        '--input',
        syntheticInputPath,
        '--resume-state',
        syntheticStatePath,
        '--apply',
        '--confirm-plan-sha256',
        cliInitialPlan.planSha256
      ],
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      readFile: virtualReadFile,
      writeFile: virtualWriteFile,
      renameFile: virtualRenameFile,
      removeFile: virtualRemoveFile,
      createDrive: () => cliResumeDrive,
      writeLine: (line) => persistedCliOutput.push(String(line))
    }),
    /飞书素材接口失败/,
    'CLI 真实不确定失败必须保留已回读完成项和请求阶段'
  )
  assert.ok(virtualFiles.has(syntheticStatePath), '首项完成后必须原子生成私有状态文件')
  assert.strictEqual(
    virtualRenames.length,
    4,
    '初始回执独占创建后，必须持久化首项 intent/完成及第二项 preparing/request-uncertain'
  )
  const persistedReceipt = JSON.parse(virtualFiles.get(syntheticStatePath))
  assert.strictEqual(persistedReceipt.completed.length, 1, '落盘状态必须包含一个已完成前缀')
  assert.ok(persistedReceipt.inFlight, '复制结果不确定时落盘状态必须保留未决动作')
  assert.strictEqual(
    persistedReceipt.inFlight.phase,
    'request-uncertain',
    'CLI 必须把真实 HTTP 不确定证明原子落盘'
  )
  assert.ok(
    virtualRenames[0].from.startsWith(`${syntheticStatePath}.tmp-`),
    '状态必须先写同目录临时文件再原子替换'
  )
  const initialStateWrite = virtualWrites.find((write) => write.path === syntheticStatePath)
  assert.strictEqual(initialStateWrite.options.flag, 'wx', '初始状态最终路径必须用 wx 独占创建')
  virtualWrites.filter((write) => write.path.includes('.tmp-')).forEach((write) => {
    assert.strictEqual(write.options.flag, 'wx', '临时状态必须用 wx 独占创建，拒绝预置文件或链接')
    assert.match(
      write.path,
      /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      '临时状态名必须使用不可预测的 randomUUID'
    )
  })

  const resumeCliOutput = []
  await expectReject(
    runCli({
      argv: [
        '--input',
        syntheticInputPath,
        '--resume',
        '--resume-state',
        syntheticStatePath
      ],
      env: {
        FEISHU_APP_ID: 'secret-app-id',
        FEISHU_APP_SECRET: 'secret-app-secret'
      },
      readFile: virtualReadFile,
      createDrive: () => cliResumeDrive,
      writeLine: (line) => resumeCliOutput.push(String(line))
    }),
    /结果不确定仍不可见|禁止重发/,
    'CLI 不得把结果不确定且仍不可见的 POST 当成安全重试'
  )
  const cliSecondOperation = cliInitialPlan.operations[1]
  const cliLateTargetFolder = findMockTargetFolderToken(
    cliResumeDrive,
    ROOTS.activeRootToken,
    cliSecondOperation.targetSegments
  )
  cliResumeDrive.nodes.get(cliLateTargetFolder).push({
    token: 'cli-late-visible-copy-token',
    name: cliSecondOperation.targetName,
    type: 'file',
    modifiedTime: 'cli-late-visible-version'
  })
  const resumeCliDryRun = await runCli({
    argv: [
      '--input',
      syntheticInputPath,
      '--resume',
      '--resume-state',
      syntheticStatePath
    ],
    env: {
      FEISHU_APP_ID: 'secret-app-id',
      FEISHU_APP_SECRET: 'secret-app-secret'
    },
    readFile: virtualReadFile,
    createDrive: () => cliResumeDrive,
    writeLine: (line) => resumeCliOutput.push(String(line))
  })
  assert.strictEqual(resumeCliDryRun.dryRun, true, 'CLI 跨进程续传必须先输出新的 dry-run')
  assert.strictEqual(resumeCliDryRun.remaining, 0, '迟到唯一目标必须自动收敛且不再报告重复动作')

  const resumeCliApplyOutput = []
  const resumeCliApplied = await runCli({
    argv: [
      '--input',
      syntheticInputPath,
      '--resume',
      '--resume-state',
      syntheticStatePath,
      '--apply',
      '--confirm-plan-sha256',
      resumeCliDryRun.planSha256
    ],
    env: {
      FEISHU_APP_ID: 'secret-app-id',
      FEISHU_APP_SECRET: 'secret-app-secret'
    },
    readFile: virtualReadFile,
    writeFile: virtualWriteFile,
    renameFile: virtualRenameFile,
    removeFile: virtualRemoveFile,
    createDrive: () => cliResumeDrive,
    writeLine: (line) => resumeCliApplyOutput.push(String(line))
  })
  assert.strictEqual(resumeCliApplied.copied, 0, 'CLI 续传不得重复 POST 已安全收敛的迟到目标')
  assert.strictEqual(
    JSON.parse(virtualFiles.get(syntheticStatePath)).completed.length,
    2,
    'CLI 续传成功后必须原子落盘合并后的完整 receipt'
  )
  assert.strictEqual(
    virtualRenames.length,
    5,
    '初始执行四次原子替换后，续传只需再持久化一次已收敛完整 receipt'
  )
  assert.strictEqual(
    cliResumeDrive.calls.filter(
      (call) => call.operation === 'copy' && call.sourceToken === 'source-video-secret-token-a'
    ).length,
    1,
    '跨进程续传不得重复 POST 已完成首项'
  )
  assert.strictEqual(
    cliResumeDrive.calls.filter(
      (call) => call.operation === 'copy' && call.sourceToken === 'source-video-secret-token-b'
    ).length,
    1,
    '跨进程续传不得重复 POST 结果不确定后迟到可见的第二项'
  )
  const allCliSafeText = [
    ...persistedCliOutput,
    ...resumeCliOutput,
    ...resumeCliApplyOutput
  ].join('\n')
  ;[
    syntheticStatePath,
    'source-video-secret-token-a',
    'source-video-secret-token-b',
    persistedReceipt.completed[0].targetToken
  ].forEach((secret) => {
    assert.ok(!allCliSafeText.includes(secret), `CLI 续传输出不得泄露状态路径或 token：${secret}`)
  })

  const driveClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    fetchImpl: async () => {
      throw new Error('该断言不应发起网络请求')
    }
  })
  assert.deepStrictEqual(
    Object.keys(driveClient).sort(),
    ['copyFile', 'createFolder', 'listFolder'],
    '真实 Drive 适配器只能暴露 list/create_folder/copy 能力'
  )

  const adapterRequests = []
  const adapterClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    fetchImpl: async (url, options = {}) => {
      adapterRequests.push({ url: String(url), method: options.method })
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              code: 0,
              tenant_access_token: 'synthetic-tenant-token'
            }
          }
        }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 0,
            data: {
              files: [
                {
                  token: 'adapter-file-token',
                  name: '标准视频.mp4',
                  type: 'file',
                  modified_time: 'v-file'
                },
                {
                  token: 'adapter-shortcut-token',
                  name: '快捷方式.mp4',
                  type: 'shortcut',
                  modified_time: 'v-shortcut'
                }
              ],
              has_more: false
            }
          }
        }
      }
    }
  })
  const adapterItems = await adapterClient.listFolder('synthetic-root-token')
  assert.deepStrictEqual(
    adapterItems.map((item) => ({
      name: item.name,
      type: item.type,
      modifiedTime: item.modifiedTime
    })),
    [
      { name: '标准视频.mp4', type: 'file', modifiedTime: 'v-file' },
      { name: '快捷方式.mp4', type: 'shortcut', modifiedTime: 'v-shortcut' }
    ],
    '真实适配层必须原样保留 Drive type，并把 modified_time 稳定投影为 modifiedTime'
  )
  assert.strictEqual(adapterRequests.length, 2, '单页 listFolder 只应包含一次鉴权和一次目录清单请求')

  async function drivePayloadResponse(payload, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload
      }
    }
  }

  async function makeDriveListClient(recordPayload) {
    let listCalls = 0
    const client = createFeishuDriveClient({
      appId: 'synthetic-app-id',
      appSecret: 'synthetic-app-secret',
      driveQps: 4,
      fetchImpl: async (url) => {
        if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
          return drivePayloadResponse({
            code: 0,
            tenant_access_token: 'synthetic-tenant-token'
          })
        }
        listCalls += 1
        return recordPayload({ listCalls, url: String(url) })
      }
    })
    return { client, getListCalls: () => listCalls }
  }

  for (const [payload, label] of [
    [{ code: 0, data: { has_more: false } }, '缺少 files/items'],
    [{ code: 0, data: { files: {}, has_more: false } }, 'files 不是数组'],
    [{ code: 0, data: { files: [{ token: 'one', name: 'one.mp4', type: 'file' }] } }, '缺少 has_more']
  ]) {
    const malformed = await makeDriveListClient(async () => drivePayloadResponse(payload))
    await expectReject(
      malformed.client.listFolder('synthetic-root-token'),
      /files|items|数组|has_more|分页|目录清单/i,
      `Drive 目录响应${label}时必须 fail-closed`
    )
    assert.strictEqual(malformed.getListCalls(), 1, `Drive 目录响应${label}时必须在首个异常页停止`)
  }

  const repeatedToken = await makeDriveListClient(async ({ listCalls }) => {
    if (listCalls > 2) throw new Error('synthetic bounded guard')
    return drivePayloadResponse({
      code: 0,
      data: {
        files: [],
        has_more: true,
        next_page_token: 'same-page-token'
      }
    })
  })
  await expectReject(
    repeatedToken.client.listFolder('synthetic-root-token'),
    /重复|循环|page_token|分页/i,
    'Drive 重复返回同一个下一页 token 时必须主动阻断，不能无限轮询'
  )
  assert.strictEqual(repeatedToken.getListCalls(), 2, '重复 token 必须在第二次出现时阻断')

  for (const invalidPageToken of [123, true, { token: 'next' }]) {
    const malformedPageToken = await makeDriveListClient(async () => drivePayloadResponse({
      code: 0,
      data: {
        files: [],
        has_more: true,
        next_page_token: invalidPageToken
      }
    }))
    await expectReject(
      malformedPageToken.client.listFolder('synthetic-root-token'),
      /next_page_token|page_token|分页|字符串/i,
      'has_more=true 时数字、布尔或对象页游标必须 fail-closed'
    )
    assert.strictEqual(
      malformedPageToken.getListCalls(),
      1,
      '非法原始页游标必须在首个异常页停止'
    )
  }

  let ambiguousCopyPosts = 0
  let ambiguousCopyReadbacks = 0
  const ambiguousCopyClient = createFeishuDriveClient({
    appId: 'synthetic-app-id',
    appSecret: 'synthetic-app-secret',
    driveQps: 4,
    ambiguousCopyReadbackAttempts: 2,
    ambiguousCopyReadbackDelayMs: 0,
    fetchImpl: async (url) => {
      const text = String(url)
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return drivePayloadResponse({
          code: 0,
          tenant_access_token: 'synthetic-tenant-token'
        })
      }
      if (/\/drive\/v1\/files\/[^/]+\/copy$/.test(new URL(text).pathname)) {
        ambiguousCopyPosts += 1
        return drivePayloadResponse({ code: 1061001, msg: 'internal error' }, 500)
      }
      ambiguousCopyReadbacks += 1
      return drivePayloadResponse({
        code: 0,
        data: {
          files: [{
            token: 'copied-after-ambiguous-error',
            name: '恢复视频.mp4',
            type: 'file',
            modified_time: 'copy-version-1'
          }],
          has_more: false
        }
      })
    }
  })
  const reconciledCopy = await ambiguousCopyClient.copyFile(
    'synthetic-source-token',
    'synthetic-target-folder',
    '恢复视频.mp4'
  )
  assert.strictEqual(reconciledCopy.token, 'copied-after-ambiguous-error', '复制接口 500 后若唯一目标已出现，必须以回读结果安全收敛')
  assert.strictEqual(ambiguousCopyPosts, 1, '不确定 500 后不得盲目重发复制请求制造重复文件')
  assert.strictEqual(ambiguousCopyReadbacks, 1, '不确定 500 后必须先读取目标目录确认实际结果')

  const unsafeError = new Error(
    'app_secret=secret-app-secret token=source-video-secret-token ' +
    'record=source-record-secret-id file=员工原视频.mp4 path=测试花园15-2-T01'
  )
  const safeError = safeErrorMessage(unsafeError)
  ;[
    'secret-app-secret',
    'source-video-secret-token',
    'source-record-secret-id',
    '员工原视频.mp4',
    '测试花园15-2-T01'
  ].forEach((secret) => {
    assert.ok(!safeError.includes(secret), `错误出口不得泄露凭据、token、记录ID、源文件名或房源路径：${secret}`)
  })

  console.log('feishu-material-copy-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
