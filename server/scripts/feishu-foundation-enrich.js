'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  configuredFoundationEnrichment
} = require('../src/feishu-sync')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const MAX_MAPPING_BYTES = 2 * 1024 * 1024

function usageText() {
  return [
    '用法：',
    '  node scripts/feishu-foundation-enrich.js --mapping <仓库外私有JSON>',
    '  node scripts/feishu-foundation-enrich.js --mapping <仓库外私有JSON> --apply --confirm-sha256 <dry-run摘要>',
    '',
    '映射每行只允许：sourceRecordId、yuxiaoerListingId、yuxiaoerRoomId、listingOwner、ownerDepartment。',
    '默认只预演；正式补全使用 dry-run 的计划摘要确认，先追加状态流水，再更新小程序专用当前主档。',
    '该入口不读取或写入员工源表。'
  ].join('\n')
}

function parseCliArgs(argv = []) {
  const result = {
    mappingPath: '',
    apply: false,
    confirmSha256: ''
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--mapping') {
      if (result.mappingPath || !argv[index + 1]) throw new Error('--mapping 必须且只能提供一次')
      result.mappingPath = argv[++index]
    } else if (token === '--apply') {
      if (result.apply) throw new Error('--apply 不得重复')
      result.apply = true
    } else if (token === '--confirm-sha256') {
      if (result.confirmSha256 || !argv[index + 1]) throw new Error('--confirm-sha256 必须且只能提供一次')
      result.confirmSha256 = String(argv[++index]).trim().toLowerCase()
    } else if (token === '--help' || token === '-h') {
      result.help = true
    } else {
      throw new Error('未知参数')
    }
  }
  if (result.help) return result
  if (!result.mappingPath) throw new Error('缺少 --mapping')
  if (!path.isAbsolute(result.mappingPath)) throw new Error('身份责任映射必须使用仓库外绝对路径')
  if (result.apply && !/^[0-9a-f]{64}$/.test(result.confirmSha256)) {
    throw new Error('正式补全必须提供 dry-run 输出的 64 位 --confirm-sha256')
  }
  if (!result.apply && result.confirmSha256) {
    throw new Error('dry-run 不接受 --confirm-sha256')
  }
  return result
}

function pathIsInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function assertPrivateMappingPath(mappingPath) {
  let projectRootReal
  let mappingReal
  try {
    projectRootReal = fs.realpathSync.native
      ? fs.realpathSync.native(PROJECT_ROOT)
      : fs.realpathSync(PROJECT_ROOT)
    mappingReal = fs.realpathSync.native
      ? fs.realpathSync.native(mappingPath)
      : fs.realpathSync(mappingPath)
  } catch (_) {
    throw new Error('身份责任映射无法安全核验')
  }
  if (pathIsInside(path.resolve(projectRootReal), path.resolve(mappingReal))) {
    throw new Error('身份责任映射必须保存在项目目录之外')
  }
  let stat
  try {
    stat = fs.statSync(mappingReal)
  } catch (_) {
    throw new Error('身份责任映射无法安全核验')
  }
  if (!stat.isFile()) throw new Error('身份责任映射必须是普通文件')
  if (stat.size <= 0 || stat.size > MAX_MAPPING_BYTES) {
    throw new Error(`身份责任映射大小必须在 1 至 ${MAX_MAPPING_BYTES} 字节之间`)
  }
  return mappingReal
}

function mappingSha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function safeSummary(result, sha256) {
  const planSha256 = String(result && result.planSha256 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(planSha256)) {
    throw new Error('身份责任补全没有返回合法计划摘要')
  }
  return {
    mode: result.dryRun ? 'dry-run' : 'apply',
    mappingSha256: sha256,
    planSha256,
    mappingCount: result.mappingCount,
    updateCount: result.updateCount,
    historyAppendCount: result.historyAppendCount,
    unchangedCount: result.unchangedCount,
    skippedCurrentCount: result.skippedCurrentCount,
    remainingUpdateCount: result.remainingUpdateCount == null ? null : result.remainingUpdateCount,
    noop: result.noop
  }
}

function safeErrorMessage(error) {
  const message = String(error && error.message ? error.message : error || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  if (/未知参数|--mapping|--apply|--confirm-sha256|dry-run 不接受/.test(message)) {
    return '命令参数不合法'
  }
  if (/必须保存在项目目录之外|无法安全核验|必须是普通文件|映射大小/.test(message)) {
    return '私有映射文件不安全或不可用'
  }
  if (/不是合法 UTF-8 JSON|顶层必须是数组/.test(message)) {
    return '私有映射文件格式无效'
  }
  if (
    /私有映射|sourceRecordId|真实身份|寓小二|identityAliases|lifecycleVersion|当前主档/.test(message) &&
    !/计划摘要|配置|资源|写后回读/.test(message)
  ) {
    return '私有映射内容未通过安全校验'
  }
  if (/计划摘要|目标快照|计划已变化|摘要不匹配/.test(message)) {
    return '目标数据或补全计划已变化'
  }
  if (/配置|资源边界|目标资源|字段契约|Base.*分离/.test(message)) {
    return '飞书补全配置未通过安全校验'
  }
  return '飞书补全执行失败'
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseCliArgs(argv)
  const writeLine = dependencies.writeLine || ((value) => process.stdout.write(`${value}\n`))
  if (parsed.help) {
    writeLine(usageText())
    return { help: true }
  }
  const mappingPath = assertPrivateMappingPath(parsed.mappingPath)
  const raw = fs.readFileSync(mappingPath)
  const sha256 = mappingSha256(raw)
  let privateMappings
  try {
    privateMappings = JSON.parse(raw.toString('utf8'))
  } catch (_) {
    throw new Error('身份责任映射不是合法 UTF-8 JSON')
  }
  if (!Array.isArray(privateMappings)) throw new Error('身份责任映射顶层必须是数组')
  const execute = dependencies.execute || configuredFoundationEnrichment
  const result = await execute({
    privateMappings,
    mappingSha256: sha256,
    confirmPlanSha256: parsed.apply ? parsed.confirmSha256 : '',
    dryRun: !parsed.apply
  })
  const summary = safeSummary(result, sha256)
  writeLine(JSON.stringify(summary))
  return summary
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`飞书身份责任补全失败：${safeErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  MAX_MAPPING_BYTES,
  assertPrivateMappingPath,
  mappingSha256,
  parseCliArgs,
  runCli,
  safeErrorMessage,
  safeSummary,
  usageText
}
