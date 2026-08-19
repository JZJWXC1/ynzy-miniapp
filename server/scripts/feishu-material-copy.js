#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  buildMaterialCopyPlan,
  buildMaterialResumePlan,
  createFeishuDriveClient,
  executeMaterialCopyPlan,
  executeMaterialResumePlan,
  toSafePlanSummary
} = require('../src/feishu-material-copy')

const MAX_INPUT_BYTES = 5 * 1024 * 1024
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

function normalizeArg(value) {
  return String(value == null ? '' : value).trim()
}

function takeSingleOption(state, name, value) {
  if (state.seen.has(name)) throw new Error(`参数 ${name} 不得重复`)
  state.seen.add(name)
  if (!normalizeArg(value)) throw new Error(`参数 ${name} 缺少值`)
  return normalizeArg(value)
}

function parseCliArgs(argv = []) {
  const state = {
    input: '',
    apply: false,
    resume: false,
    resumeState: '',
    confirmPlanSha256: '',
    help: false,
    seen: new Set()
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = normalizeArg(argv[index])
    if (arg === '--help' || arg === '-h') {
      if (state.seen.has('help')) throw new Error('参数 --help 不得重复')
      state.seen.add('help')
      state.help = true
      continue
    }
    if (arg === '--apply') {
      if (state.seen.has('apply')) throw new Error('参数 --apply 不得重复')
      state.seen.add('apply')
      state.apply = true
      continue
    }
    if (arg === '--resume') {
      if (state.seen.has('resume')) throw new Error('参数 --resume 不得重复')
      state.seen.add('resume')
      state.resume = true
      continue
    }
    if (arg === '--input') {
      state.input = takeSingleOption(state, 'input', argv[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith('--input=')) {
      state.input = takeSingleOption(state, 'input', arg.slice('--input='.length))
      continue
    }
    if (arg === '--resume-state') {
      state.resumeState = takeSingleOption(state, 'resume-state', argv[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith('--resume-state=')) {
      state.resumeState = takeSingleOption(
        state,
        'resume-state',
        arg.slice('--resume-state='.length)
      )
      continue
    }
    if (arg === '--confirm-plan-sha256') {
      state.confirmPlanSha256 = takeSingleOption(state, 'confirm', argv[index + 1]).toLowerCase()
      index += 1
      continue
    }
    if (arg.startsWith('--confirm-plan-sha256=')) {
      state.confirmPlanSha256 = takeSingleOption(
        state,
        'confirm',
        arg.slice('--confirm-plan-sha256='.length)
      ).toLowerCase()
      continue
    }
    throw new Error(`未知参数：${arg || '空'}`)
  }
  if (state.help) {
    return {
      input: state.input,
      apply: state.apply,
      resume: state.resume,
      resumeState: state.resumeState,
      confirmPlanSha256: state.confirmPlanSha256,
      help: true
    }
  }
  if (!state.input) throw new Error('必须提供 --input <计划输入.json>')
  if (state.apply && !state.confirmPlanSha256) {
    throw new Error('--apply 必须同时提供 --confirm-plan-sha256 <SHA-256>')
  }
  if (!state.apply && state.confirmPlanSha256) {
    throw new Error('--confirm-plan-sha256 只能与 --apply 同时使用')
  }
  if (state.apply && !state.resumeState) {
    throw new Error('--apply 必须同时提供 --resume-state <私有状态文件>')
  }
  if (state.resume && !state.resumeState) {
    throw new Error('--resume 必须同时提供 --resume-state <私有状态文件>')
  }
  if (!state.apply && !state.resume && state.resumeState) {
    throw new Error('--resume-state 只能与 --apply 或 --resume 同时使用')
  }
  if (state.confirmPlanSha256 && !/^[a-f0-9]{64}$/.test(state.confirmPlanSha256)) {
    throw new Error('--confirm-plan-sha256 必须是 64 位十六进制 SHA-256')
  }
  return {
    input: state.input,
    apply: state.apply,
    resume: state.resume,
    resumeState: state.resumeState,
    confirmPlanSha256: state.confirmPlanSha256,
    help: false
  }
}

function usageText() {
  return [
    '飞书素材复制工具（默认只读预演）',
    '',
    '预演：',
    '  node scripts/feishu-material-copy.js --input <计划输入.json>',
    '',
    '确认计划输入、计数和 SHA-256 后真实复制：',
    '  node scripts/feishu-material-copy.js --input <计划输入.json> --resume-state <私有状态.json> --apply --confirm-plan-sha256 <SHA-256>',
    '',
    '中断后先重新预演续传，再确认新的 SHA-256 执行剩余项：',
    '  node scripts/feishu-material-copy.js --input <计划输入.json> --resume --resume-state <私有状态.json>',
    '  node scripts/feishu-material-copy.js --input <计划输入.json> --resume --resume-state <私有状态.json> --apply --confirm-plan-sha256 <新 SHA-256>',
    '',
    '安全边界：仅调用目录清单、创建子目录、复制文件；不实现移动或删除。'
  ].join('\n')
}

function parseJsonObject(raw, label) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw == null ? '' : raw)
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`${label}超过 ${MAX_INPUT_BYTES} 字节安全上限`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label}不是有效 JSON`)
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label}根节点必须是 JSON 对象`)
  }
  return parsed
}

function parseManifest(raw) {
  return parseJsonObject(raw, '计划输入')
}

function parseResumeReceipt(raw) {
  return parseJsonObject(raw, '素材续传状态')
}

function pathIsInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function realpathSyncDefault(candidate) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(candidate)
    : fs.realpathSync(candidate)
}

function resolvePathThroughExistingAncestor(candidatePath, options = {}) {
  const existsSync = options.existsSync || fs.existsSync
  const realpathSync = options.realpathSync || realpathSyncDefault
  const absolutePath = path.resolve(candidatePath)
  if (existsSync(absolutePath)) {
    return path.resolve(realpathSync(absolutePath))
  }
  let cursor = path.dirname(absolutePath)
  const missingSegments = []
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      throw new Error('素材续传状态路径没有可核验的现有父目录')
    }
    missingSegments.unshift(path.basename(cursor))
    cursor = parent
  }
  const realAncestor = path.resolve(realpathSync(cursor))
  return path.resolve(realAncestor, ...missingSegments, path.basename(absolutePath))
}

function assertPrivateResumeStatePath(statePath, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT)
  const absoluteStatePath = path.resolve(statePath)
  const relative = path.relative(projectRoot, absoluteStatePath)
  const outsideProject = (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
  if (!outsideProject) {
    throw new Error('素材续传状态必须保存在项目目录之外的私有路径')
  }
  let realProjectRoot
  let realStatePath
  try {
    const realpathSync = options.realpathSync || realpathSyncDefault
    realProjectRoot = path.resolve(realpathSync(projectRoot))
    realStatePath = resolvePathThroughExistingAncestor(absoluteStatePath, options)
  } catch (error) {
    throw new Error('素材续传状态实际路径无法安全核验')
  }
  if (pathIsInside(realProjectRoot, realStatePath)) {
    throw new Error('素材续传状态实际路径必须位于项目目录之外')
  }
  return realStatePath
}

function assertPrivateInputPath(inputPath, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT)
  const absoluteInputPath = path.resolve(inputPath)
  const relative = path.relative(projectRoot, absoluteInputPath)
  const outsideProject = (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
  if (!outsideProject) {
    throw new Error('素材计划输入必须保存在项目目录之外的私有路径')
  }
  let realProjectRoot
  let realInputPath
  try {
    const realpathSync = options.realpathSync || realpathSyncDefault
    realProjectRoot = path.resolve(realpathSync(projectRoot))
    realInputPath = resolvePathThroughExistingAncestor(absoluteInputPath, options)
  } catch (error) {
    throw new Error('素材计划输入实际路径无法安全核验')
  }
  if (pathIsInside(realProjectRoot, realInputPath)) {
    throw new Error('素材计划输入实际路径必须位于项目目录之外')
  }
  return realInputPath
}

function pathIdentityKey(candidatePath) {
  const absolutePath = path.resolve(candidatePath)
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath
}

async function writeReceiptAtomically({
  statePath,
  receipt,
  writeFile,
  renameFile,
  removeFile
}) {
  const nonce = crypto.randomUUID()
  const temporaryPath = `${statePath}.tmp-${nonce}`
  try {
    await Promise.resolve(writeFile(
      temporaryPath,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    ))
    await Promise.resolve(renameFile(temporaryPath, statePath))
  } catch (error) {
    try {
      await Promise.resolve(removeFile(temporaryPath))
    } catch (cleanupError) {
      // 临时文件清理失败不能覆盖原子持久化的主错误。
    }
    throw new Error('素材续传状态原子持久化失败')
  }
}

async function writeReceiptExclusively({
  statePath,
  receipt,
  writeFile
}) {
  try {
    await Promise.resolve(writeFile(
      statePath,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    ))
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new Error('素材续传状态已存在；普通 apply 不得覆盖，请使用 --resume')
    }
    throw new Error('素材续传状态独占创建失败，未执行任何 Drive 写动作')
  }
}

async function acquireApplyLock({
  statePath,
  writeFile
}) {
  const lockPath = `${statePath}.lock`
  const ownerBytes = `${JSON.stringify({
    version: 1,
    owner: crypto.randomUUID()
  })}\n`
  try {
    await Promise.resolve(writeFile(
      lockPath,
      ownerBytes,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    ))
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new Error('素材复制任务正在执行；拒绝并发 apply')
    }
    throw new Error('素材复制任务无法建立独占执行锁，未执行任何 Drive 写动作')
  }
  return { lockPath, ownerBytes }
}

async function releaseOwnedApplyLock({
  lock,
  readFile,
  removeFile
}) {
  if (!lock) return false
  let currentBytes
  try {
    currentBytes = await Promise.resolve(readFile(lock.lockPath))
  } catch (error) {
    return false
  }
  const currentText = Buffer.isBuffer(currentBytes)
    ? currentBytes.toString('utf8')
    : String(currentBytes)
  if (currentText !== lock.ownerBytes) return false
  try {
    await Promise.resolve(removeFile(lock.lockPath))
    return true
  } catch (error) {
    return false
  }
}

function safeAppliedSummary(result) {
  return {
    mode: 'apply',
    applied: result.applied === true,
    planSha256: normalizeArg(result.planSha256),
    counts: {
      planned: Number(result.planned || 0),
      copied: Number(result.copied || 0),
      readBackVerified: Number(result.readBackVerified || 0),
      activeCopied: Number(result.activeCopied || 0),
      pendingCopied: Number(result.pendingCopied || 0)
    }
  }
}

function safeErrorMessage(error) {
  const message = normalizeArg(error && error.message ? error.message : error)
  if (!message) return '未知错误'
  const apiFailure = message.match(/飞书素材接口失败（HTTP\s+(\d+)，code=([0-9a-z-]+)）/i)
  if (apiFailure) return `飞书素材接口失败（HTTP ${apiFailure[1]}，code=${apiFailure[2]}）`
  if (/计划输入已变化|SHA-256|confirm/i.test(message)) return '计划确认失败或计划输入已变化'
  if (/目标冲突|阻断/.test(message)) return '目标目录存在冲突，未执行复制'
  if (/回读校验失败/.test(message)) return '飞书异步复制回读校验失败'
  if (/凭据|鉴权|tenant_access_token/.test(message)) return '飞书应用凭据或授权不可用'
  if (/参数|JSON|根节点|计划输入/.test(message)) return '命令行参数或计划输入格式非法'
  if (/超时/.test(message)) return '飞书素材接口超时'
  return '素材复制失败（详细信息已脱敏）'
}

async function runCli(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2)
  const env = options.env || process.env
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath))
  const writeFile = options.writeFile || ((filePath, content, fileOptions) => (
    fs.writeFileSync(filePath, content, fileOptions)
  ))
  const renameFile = options.renameFile || ((fromPath, toPath) => fs.renameSync(fromPath, toPath))
  const removeFile = options.removeFile || ((filePath) => fs.rmSync(filePath, { force: true }))
  const existsSync = options.existsSync || fs.existsSync
  const writeLine = options.writeLine || ((line) => process.stdout.write(`${line}\n`))
  const createDrive = options.createDrive || ((clientOptions) => createFeishuDriveClient(clientOptions))
  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    writeLine(usageText())
    return { help: true, dryRun: true }
  }

  const inputPath = path.resolve(parsed.input)
  const resumeStatePath = parsed.resumeState ? path.resolve(parsed.resumeState) : ''
  const realInputPath = assertPrivateInputPath(inputPath)
  if (resumeStatePath) {
    const realResumeStatePath = assertPrivateResumeStatePath(resumeStatePath)
    if (
      pathIdentityKey(resumeStatePath) === pathIdentityKey(inputPath) ||
      pathIdentityKey(realResumeStatePath) === pathIdentityKey(realInputPath)
    ) {
      throw new Error('续传状态文件不得覆盖计划输入文件')
    }
  }
  if (parsed.apply && !parsed.resume && existsSync(resumeStatePath)) {
    throw new Error('素材续传状态已存在；普通 apply 不得覆盖，请使用 --resume')
  }

  const applyLock = parsed.apply
    ? await acquireApplyLock({
      statePath: resumeStatePath,
      writeFile
    })
    : null
  try {
    const manifest = parseManifest(readFile(inputPath))
    const drive = createDrive({
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      timeoutMs: env.FEISHU_MATERIAL_COPY_TIMEOUT_MS
    })
    const plan = parsed.resume
      ? await buildMaterialResumePlan({
        drive,
        manifest,
        resumeReceipt: parseResumeReceipt(readFile(resumeStatePath))
      })
      : await buildMaterialCopyPlan({ drive, manifest })
    const safePlan = {
      ...toSafePlanSummary(plan),
      mode: parsed.resume ? 'resume-dry-run' : 'dry-run',
      ...(parsed.resume
        ? {
          resumeCounts: {
            previouslyCompleted: Number(plan.completedCount || 0),
            remaining: Array.isArray(plan.operations) ? plan.operations.length : 0,
            totalPlanned: Number(plan.totalPlanned || 0)
          }
        }
        : {})
    }
    writeLine(JSON.stringify(safePlan))
    if (!parsed.apply) {
      return parsed.resume
        ? executeMaterialResumePlan({ drive, plan })
        : executeMaterialCopyPlan({ drive, plan })
    }

    let receiptInitialized = parsed.resume
    const persistReceipt = async (receipt) => {
      if (!receiptInitialized) {
        throw new Error('素材续传状态尚未完成独占创建，拒绝 Drive 写动作')
      }
      return writeReceiptAtomically({
        statePath: resumeStatePath,
        receipt,
        writeFile,
        renameFile,
        removeFile
      })
    }
    const initializeReceipt = async (receipt) => {
      await writeReceiptExclusively({
        statePath: resumeStatePath,
        receipt,
        writeFile
      })
      receiptInitialized = true
    }
    const onBeforeWrite = parsed.resume ? persistReceipt : initializeReceipt
    const result = parsed.resume
      ? await executeMaterialResumePlan({
        drive,
        plan,
        apply: true,
        confirmPlanSha256: parsed.confirmPlanSha256,
        onBeforeWrite,
        onIntent: persistReceipt,
        onProgress: persistReceipt
      })
      : await executeMaterialCopyPlan({
        drive,
        plan,
        apply: true,
        confirmPlanSha256: parsed.confirmPlanSha256,
        onBeforeWrite,
        onIntent: persistReceipt,
        onProgress: persistReceipt
      })
    writeLine(JSON.stringify(safeAppliedSummary(result)))
    return result
  } finally {
    await releaseOwnedApplyLock({
      lock: applyLock,
      readFile,
      removeFile
    })
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`飞书素材复制工具失败：${safeErrorMessage(error)}\n`)
    if (error && error.partialResult) {
      process.stderr.write(`${JSON.stringify({
        mode: 'apply-failed',
        counts: safeAppliedSummary(error.partialResult).counts
      })}\n`)
    }
    process.exitCode = 1
  })
}

module.exports = {
  MAX_INPUT_BYTES,
  assertPrivateInputPath,
  assertPrivateResumeStatePath,
  parseCliArgs,
  parseManifest,
  parseResumeReceipt,
  runCli,
  safeAppliedSummary,
  safeErrorMessage,
  usageText,
  writeReceiptExclusively,
  writeReceiptAtomically
}
