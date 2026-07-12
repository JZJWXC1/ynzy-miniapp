const fs = require('fs')
const path = require('path')
const config = require('./config')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function ensureDataFile() {
  const dir = path.dirname(config.dataFile)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(config.dataFile)) {
    fs.writeFileSync(config.dataFile, '{}', 'utf8')
  }
}

// \u89E3\u6790\u7F13\u5B58\uFF1A\u4EE5\u6587\u4EF6 mtimeMs+size \u4F5C\u4E3A\u7248\u672C\u952E\u3002\u5185\u90E8\u5199\u8DEF\u5F84\u547D\u4E2D\u65F6\u590D\u7528\u7F13\u5B58\u5BF9\u8C61\uFF0C
// \u8DF3\u8FC7 readFileSync + JSON.parse\uFF1B\u6587\u4EF6\u88AB\u5199\u6539\u540E stat \u53D8\u5316\uFF0C\u7F13\u5B58\u81EA\u52A8\u5931\u6548\u3002
// \u8FD9\u6837\u65E2\u6D88\u9664\u201C\u6BCF\u8BF7\u6C42\u5168\u91CF\u89E3\u6790\u201D\u4E0E\u5199\u63A5\u53E3\u201C\u540C\u8BF7\u6C42\u53CC\u91CD\u89E3\u6790\u201D\uFF0C\u53C8\u5929\u7136\u6B63\u786E\u5904\u7406\u5E76\u53D1\u5199\u2014\u2014
// \u957F await \u671F\u95F4\u82E5\u522B\u7684\u8BF7\u6C42\u5199\u76D8\uFF0Cmtime \u53D8\u5316\u4F1A\u5F3A\u5236\u4E0B\u4E00\u6B21 readDb \u91CD\u65B0\u89E3\u6790\u62FF\u5230\u6700\u65B0\u6570\u636E\u3002
let parseCache = null

function statKey() {
  try {
    const stat = fs.statSync(config.dataFile)
    // 纳入 inode：writeDb 用「写临时文件 + rename」替换，每次落盘都是新 inode，
    // 使缓存键不再被「同毫秒 + 同 size」的跨进程等长写入别名化（否则会误命中陈旧缓存丢写）。
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch (error) {
    return null
  }
}

function readCachedDb() {
  ensureDataFile()
  const key = statKey()
  if (parseCache && key && parseCache.key === key) {
    return parseCache.db
  }
  const content = fs.readFileSync(config.dataFile, 'utf8').replace(/^\uFEFF/, '')
  const db = content.trim() ? JSON.parse(content) : {}
  if (key) parseCache = { key, db }
  return db
}

function readDb() {
  return clone(readCachedDb())
}

// 默认紧凑序列化：两空格 pretty-print 会使 db.json 膨胀近 2 倍，放大每次整库重写的
// 磁盘写入量（足迹等高频只增留痕尤其明显）。需要人读时用 DB_JSON_PRETTY=1 恢复缩进。
function serializeDb(db) {
  return config.dbPrettyJson ? JSON.stringify(db, null, 2) : JSON.stringify(db)
}

// ---------- 跨进程写锁（P0-2 并发写保护） ----------
// 单主机同机多进程：服务器与运维脚本(backfill/geocode)可能同时写 db.json，各自「读 fresh→改→
// 原子 rename」之间若无互斥，后写会整块覆盖先写、丢数据（commitDelta 只在单进程内合并，不跨进程）。
// 用零依赖 O_EXCL 锁文件做 advisory 互斥：获取有界超时（拿不到就抛错，绝不无限等/死锁）；
// 陈旧锁（持锁进程崩溃未清理）按 mtime age 回收；进程内可重入（mutator 再调 updateDb 不自死锁）；
// 仅在 updateDb/writeDb 同步临界区短暂持锁（毫秒级），单进程内几乎无争用。锁参数从环境变量读，
// 便于测试与生产覆盖：DB_WRITE_LOCK(默认开,置 0/off 退回旧行为)、DB_LOCK_TIMEOUT_MS(默认 10000)、
// DB_LOCK_STALE_MS(默认 30000)。
let heldLockFd = null
let heldLockDepth = 0
let heldLockToken = null // 本进程锁的唯一标记，写进锁文件；release 只删「仍属于我」的锁
let activeTxDb = null // 当前持锁 updateDb 事务的 db 对象；嵌套 updateDb 复用它，由最外层统一落盘（防嵌套丢内层写）

function lockFilePath() {
  return `${config.dataFile}.lock`
}

function lockEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.DB_WRITE_LOCK || '').trim())
}

function lockNumberEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleepSync(ms) {
  // 零依赖同步睡眠：Atomics.wait 让出 CPU（Node 主线程允许），比忙等省电。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms))
  } catch (error) {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 退化忙等，极少触发 */ }
  }
}

// Windows 下 rename 覆盖已存在文件时可能瞬时抛 EPERM/EACCES/EBUSY（AV/索引器/刚释放的句柄）；
// 短暂重试即可，绝不因平台瞬时错误丢一次写盘。Linux 上 rename 原子、几乎不触发重试。
function renameWithRetry(from, to) {
  const maxTries = 30
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      const transient = error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY'
      if (!transient || i >= maxTries) throw error
      sleepSync(5)
    }
  }
}

// 尽力删除锁文件：Windows 下 unlink 也会瞬时 EPERM/EBUSY，重试消化；实在删不掉不抛错（
// 交给 liveness/自身 pid/陈旧回收兜底），避免释放路径抛错阻断上层。
function unlinkWithRetry(p) {
  for (let i = 0; ; i += 1) {
    try {
      fs.unlinkSync(p)
      return
    } catch (error) {
      if (error.code === 'ENOENT') return // 已不在
      const transient = error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY'
      if (!transient || i >= 30) return // 尽力而为
      sleepSync(5)
    }
  }
}

// 单主机 pid 存活探测：signal 0 只探测存在、不真杀。ESRCH=不存在；EPERM=存在但无权限（算存活）。
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// 判定锁是否陈旧（可安全回收）。以「持有者进程存活与否」为权威——存活的持有者哪怕临界区很慢也绝不回收，
// 避免误删活锁造成两个并发写者。只有读不出 pid（内容缺失/被别的工具建的锁）时才退回 age 兜底。
function isStaleLock(lp, staleMs) {
  try {
    const content = fs.readFileSync(lp, 'utf8')
    const pid = parseInt(String(content).split(':')[0], 10)
    if (Number.isInteger(pid) && pid > 0) {
      // 自己 pid 的锁但当前未持有（heldLockDepth 为 0 才会走到这）= 上次释放没删掉的孤儿 → 必回收，防自锁死。
      if (pid === process.pid) return true
      return !isProcessAlive(pid) // 别的持有者：已死→陈旧回收；存活→绝不回收（防误删活锁）
    }
  } catch (readError) { /* 读不到内容 → 退回 age */ }
  try {
    return Date.now() - fs.statSync(lp).mtimeMs > staleMs
  } catch (statError) {
    return false // 文件已不在，交给上层重试
  }
}

function acquireDbLock() {
  if (!lockEnabled()) return null // 紧急关闭开关：退回旧行为（无锁）
  if (heldLockDepth > 0) { heldLockDepth += 1; return heldLockFd } // 本进程重入
  const lp = lockFilePath()
  const timeoutMs = lockNumberEnv('DB_LOCK_TIMEOUT_MS', 10000)
  const staleMs = lockNumberEnv('DB_LOCK_STALE_MS', 30000)
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx') // O_CREAT|O_EXCL：原子创建，已存在则 EEXIST
      try { fs.writeSync(fd, token) } catch (writeError) { /* 写元信息失败不致命 */ }
      heldLockFd = fd
      heldLockDepth = 1
      heldLockToken = token
      return fd
    } catch (error) {
      // EEXIST=锁被占；Windows 并发/权限也可能给 EPERM/EACCES。不再靠 statSync 区分真假权限错误
      //（Windows 下不可靠、且有 race），改为统一走「回收陈旧锁 + 有界等待 + 每轮 sleep + 超时抛错」：
      // 即便是真权限错误（目录只读），也只会在 DB_LOCK_TIMEOUT_MS 后抛超时，绝不无限自旋冻死服务。
      if (error.code !== 'EEXIST' && error.code !== 'EPERM' && error.code !== 'EACCES') throw error
      try {
        if (isStaleLock(lp, staleMs)) unlinkWithRetry(lp) // 回收：持有者已死/自身孤儿/内容缺失且 age 陈旧
      } catch (staleError) { /* 忽略，走等待 */ }
      if (Date.now() >= deadline) {
        throw new Error(`获取 db 写锁超时(${timeoutMs}ms)：${lp}（持续超时请检查该目录写权限）`)
      }
      sleepSync(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }
}

function releaseDbLock(fd) {
  if (heldLockDepth > 1) { heldLockDepth -= 1; return } // 重入退出
  if (heldLockDepth === 0 && fd == null) return // 关闭开关下无锁
  const token = heldLockToken
  heldLockDepth = 0
  heldLockFd = null
  heldLockToken = null
  try { if (fd != null) fs.closeSync(fd) } catch (error) { /* 忽略 */ }
  // 只删「仍属于我」的锁：读回锁文件，token 匹配才删，避免误删别人重建的活锁（防连锁并发写）。
  // 读失败（Windows 瞬时）时默认当作是自己的（活着的持有者不会被 liveness 回收，锁必然仍是我的）照删，
  // 否则会遗留孤儿锁把自己/别人锁死。只有明确读到「别人的 token」才不删。
  if (token != null) {
    let mine = true
    try { mine = fs.readFileSync(lockFilePath(), 'utf8') === token } catch (readError) { mine = true }
    if (mine) unlinkWithRetry(lockFilePath())
  }
}

function writeDbUnlocked(db) {
  ensureDataFile()
  const tempFile = `${config.dataFile}.${process.pid}.tmp`
  fs.writeFileSync(tempFile, serializeDb(db), 'utf8')
  renameWithRetry(tempFile, config.dataFile)
  // \u521A\u5199\u5165\u7684\u5BF9\u8C61\u5373\u6700\u65B0\u72B6\u6001\uFF0C\u7ED1\u5B9A\u65B0 stat \u4F5C\u4E3A\u7F13\u5B58\uFF0C\u8BA9\u7D27\u968F\u5176\u540E\u7684 readDb \u76F4\u63A5\u547D\u4E2D\u3002
  const key = statKey()
  parseCache = key ? { key, db: clone(db) } : null
}

// 公开写入：外层包跨进程锁；updateDb 内部改用 writeDbUnlocked，避免重复加锁。
function writeDb(db) {
  // 在一个 updateDb 事务里再调 writeDb 会整库覆盖事务对象、静默丢事务写，语义危险，直接禁止并清晰报错。
  if (activeTxDb !== null) {
    throw new Error('writeDb 不可在 updateDb 事务内调用（会整库覆盖并静默丢事务写）；请在 mutator 内直接改传入的 db 对象')
  }
  ensureDataFile()
  const fd = acquireDbLock()
  try {
    writeDbUnlocked(db)
  } finally {
    releaseDbLock(fd)
  }
}

function updateDb(mutator) {
  // 嵌套 updateDb（本进程已在一个事务里）：复用同一事务 db 对象、不再单独读/写，由最外层统一落盘，
  // 使内外层改动都持久化，杜绝「嵌套静默丢内层写」。
  // 进入前对事务对象做深快照；内层 mutator 抛错则就地回滚到进入前状态再 rethrow——保持「mutator 抛错
  // = 该次改动回滚」语义，避免内层半截脏改动在外层 catch 后被一并提交（外层仍可 catch 并写自己的字段）。
  if (activeTxDb !== null) {
    const snapshot = clone(activeTxDb)
    try {
      return mutator(activeTxDb)
    } catch (error) {
      for (const key of Object.keys(activeTxDb)) delete activeTxDb[key] // 就地清空，保持同一对象引用
      Object.assign(activeTxDb, snapshot) // 恢复到进入前
      throw error
    }
  }
  ensureDataFile()
  const fd = acquireDbLock()
  try {
    // 持锁时强制从磁盘重读：即便 statKey 撞键（同 tick 等长的跨进程写），也绝不复用本进程陈旧缓存，
    // 确保读改写基于真实当前磁盘状态，杜绝「持锁仍丢写」。锁关闭(fd 为 null)时退回旧的缓存行为。
    if (fd != null) parseCache = null
    const db = readCachedDb()
    activeTxDb = db
    const result = mutator(db)
    writeDbUnlocked(db)
    return result
  } catch (error) {
    // mutator \u53EF\u80FD\u5DF2\u5C31\u5730\u6539\u52A8\u7F13\u5B58\u5BF9\u8C61\uFF0C\u4F46\u78C1\u76D8\u672A\u5199\u5165\uFF1B\u5931\u6548\u7F13\u5B58\uFF0C\u8BA9\u4E0B\u4E00\u6B21 readDb
    // \u4ECE\u78C1\u76D8\u91CD\u65B0\u89E3\u6790\u51FA\u672A\u88AB\u6C61\u67D3\u7684\u72B6\u6001\uFF0C\u4FDD\u6301\u201C\u629B\u5F02\u5E38\u5373\u56DE\u6EDA\u201D\u8BED\u4E49\u3002
    parseCache = null
    throw error
  } finally {
    activeTxDb = null // 无论成败清理事务对象，避免泄漏到后续调用
    releaseDbLock(fd)
  }
}

// 在与 updateDb 相同的跨进程互斥锁内读取最新磁盘状态，但不写盘。用于权限/会话的临界点复验：
// 既能与停用、退出等写事务线性化，又不会为了纯鉴权刷新文件时间或制造无意义整库写入。
function inspectDb(inspector) {
  if (typeof inspector !== 'function') throw new Error('inspectDb 需要只读回调')
  const inspectSnapshot = (sourceDb) => {
    const result = inspector(clone(sourceDb))
    if (result && typeof result.then === 'function') {
      // 锁是同步互斥，不能跨 await 持有；显式拒绝异步 inspector，避免调用者误以为 Promise
      // 整段仍处于临界区。副本保证已启动的异步代码也无法污染真实数据库。
      Promise.resolve(result).catch(() => {})
      throw new Error('inspectDb 只支持同步只读回调')
    }
    return result
  }
  // 只把深拷贝交给回调：调用者即使误改参数，或把返回引用带出锁后继续修改，也不能污染
  // 活动事务对象、解析缓存或磁盘状态。事务内仍以当前事务快照为基线，保持可见性一致。
  if (activeTxDb !== null) return inspectSnapshot(activeTxDb)
  ensureDataFile()
  const fd = acquireDbLock()
  try {
    if (fd != null) parseCache = null
    return inspectSnapshot(readCachedDb())
  } finally {
    releaseDbLock(fd)
  }
}

// 是否为「带 id 的对象数组」。空数组也算（视作该类数组的空集），使 base/mutated 在空↔非空之间
// 过渡时仍走元素级合并——否则空基线会退化成整键覆盖，把并发写整块抹掉。
function isIdObjectArray(value) {
  return Array.isArray(value) && value.every(
    (item) => item && typeof item === 'object' && !Array.isArray(item) &&
      Object.prototype.hasOwnProperty.call(item, 'id')
  )
}

// \u5E26 id \u7684\u5BF9\u8C61\u6570\u7EC4\u4E09\u65B9\u6309\u5143\u7D20\u5408\u5E76\uFF1Abase=\u540C\u6B65\u524D\u57FA\u7EBF\uFF0Cmutated=\u540C\u6B65\u79C1\u6709\u526F\u672C\uFF0Cfresh=\u843D\u76D8\u65F6\u6700\u65B0\u5E93\u3002
// \u4EE5 fresh\uFF08\u542B await \u7A97\u53E3\u5185\u5E76\u53D1\u5199\uFF09\u4E3A\u5E95\uFF0C\u53EA\u5957\u7528 sync \u771F\u6B63\u6539\u52A8/\u65B0\u589E/\u5220\u9664\u7684\u5143\u7D20\uFF1A
// - sync \u6539\u4E86\u67D0 id\uFF08mutated \u8BE5\u5143\u7D20 !== base\uFF09\u2192 \u7528 sync \u7248\u672C\uFF1B
// - sync \u6CA1\u78B0\u67D0 id\uFF08mutated===base\uFF09\u2192 \u4FDD\u7559 fresh \u7248\u672C\uFF08\u4FDD\u4F4F\u5E76\u53D1\u5BF9\u8BE5\u5143\u7D20\u7684\u6539\u52A8\uFF09\uFF1B
// - sync \u5220\u4E86\u67D0 id\uFF08base \u6709\u3001mutated \u65E0\uFF09\u2192 \u4ECE\u7ED3\u679C\u5254\u9664\uFF1B
// - sync \u65B0\u589E\u67D0 id\uFF08mutated \u6709\u3001base \u65E0\uFF09\u2192 \u524D\u63D2\uFF08\u8D34\u5408 footprints/\u65E5\u5FD7 unshift \u7684\u201C\u65B0\u7684\u5728\u524D\u201D\uFF09\uFF1B
// - fresh \u5E76\u53D1\u65B0\u589E\uFF08base/mutated \u90FD\u65E0\uFF09\u2192 \u4FDD\u7559\u3002
// \u4E09\u65B9\u6309\u5B57\u6BB5\u5408\u5E76\uFF1Abase=\u5171\u540C\u7956\u5148\uFF0Cmutated=sync \u79C1\u6709\u526F\u672C\uFF0Cfresh=\u843D\u76D8\u65F6\u542B\u5E76\u53D1\u5199\u7684\u5F53\u524D\u503C\u3002
// \u4EE5 fresh \u4E3A\u5E95\uFF0C\u53EA\u628A sync \u76F8\u5BF9 base \u771F\u6B63\u6539\u52A8\u8FC7\u7684\u5B57\u6BB5\u8986\u76D6\u4E0A\u53BB\uFF08sync \u5220\u9664\u7684\u5B57\u6BB5\u5219\u5220\u6389\uFF09\uFF0C\u4ECE\u800C
// \u4FDD\u7559 fresh \u5BF9 sync \u672A\u78B0\u5B57\u6BB5\u7684\u5E76\u53D1\u6539\u52A8\u3002\u7528\u4E8E\u300C\u540C\u4E00\u5143\u7D20\u88AB sync \u4E0E\u5E76\u53D1\u5199\u540C\u65F6\u6539\u52A8\uFF08\u4E0D\u540C\u5B57\u6BB5\uFF09\u300D\uFF1A
// \u5426\u5219\u300Csync \u52A8\u8FC7\u8BE5\u5143\u7D20\u5C31\u6574\u4EFD\u80DC\u51FA\u300D\u4F1A\u9759\u9ED8\u56DE\u6EDA\u5E76\u53D1\u5199\uFF08\u5982 sync \u5237 syncedAt \u7684\u540C\u65F6\u5E76\u53D1\u786E\u8BA4\u4E86\u6210\u4EA4\uFF09\u3002
const TERMINAL_STATUS_FIELDS = new Set(['status', 'lifecycleStatus', 'expiredAt', 'expiredBy', 'expiredPool', 'expiredReason', 'expiredStaleDays'])

function isTerminalDealState(value) {
  return /成交|签单|sold/i.test(String(value || ''))
}

function freshTerminalStatusWins(key, mutated, fresh) {
  if (!TERMINAL_STATUS_FIELDS.has(key)) return false
  const safeMutated = mutated || {}
  const safeFresh = fresh || {}
  const freshStatus = key === 'status' ? safeFresh[key] : safeFresh.status
  const syncStatus = key === 'status' ? safeMutated[key] : safeMutated.status
  const freshLifecycle = key === 'lifecycleStatus' ? safeFresh[key] : safeFresh.lifecycleStatus
  const syncLifecycle = key === 'lifecycleStatus' ? safeMutated[key] : safeMutated.lifecycleStatus
  const freshTerminal = isTerminalDealState(freshStatus) || isTerminalDealState(freshLifecycle)
  const syncTerminal = isTerminalDealState(syncStatus) || isTerminalDealState(syncLifecycle)
  return freshTerminal && !syncTerminal
}

function mergeChangedFields(base, mutated, fresh) {
  const safeBase = base || {}
  const safeMutated = mutated || {}
  const result = { ...fresh }
  const keys = new Set([...Object.keys(safeBase), ...Object.keys(safeMutated)])
  for (const key of keys) {
    const inMutated = Object.prototype.hasOwnProperty.call(safeMutated, key)
    const before = JSON.stringify(safeBase[key])
    const after = inMutated ? JSON.stringify(safeMutated[key]) : undefined
    if (before === after) continue // sync \u672A\u6539\u8BE5\u5B57\u6BB5 \u2192 \u4FDD\u7559 fresh \u7684\u503C\uFF08\u53EF\u80FD\u542B\u5E76\u53D1\u5199\uFF09
    if (freshTerminalStatusWins(key, safeMutated, fresh)) continue // 并发成交/签单终态优先于同步下架等非终态
    if (!inMutated) { delete result[key]; continue } // sync \u5220\u4E86\u8BE5\u5B57\u6BB5
    result[key] = safeMutated[key] // sync \u6539\u4E86\u8BE5\u5B57\u6BB5 \u2192 \u53D6 sync \u503C\uFF08\u540C\u5B57\u6BB5\u51B2\u7A81\u4EE5 sync \u4E3A\u51C6\uFF09
  }
  return result
}

function mergeById(base, mutated, fresh) {
  const baseById = new Map(base.map((item) => [item.id, item]))
  const mutatedById = new Map(mutated.map((item) => [item.id, item]))
  const kept = []
  const seen = new Set()
  for (const item of fresh) {
    if (!item || item.id == null) { kept.push(item); continue } // \u5F02\u5E38\u5143\u7D20\u539F\u6837\u4FDD\u7559
    seen.add(item.id)
    const inBase = baseById.has(item.id)
    const inMutated = mutatedById.has(item.id)
    if (inBase && !inMutated) continue // sync \u5220\u9664\u4E86\u8BE5\u5143\u7D20
    if (inMutated && JSON.stringify(baseById.get(item.id)) !== JSON.stringify(mutatedById.get(item.id))) {
      // sync \u6539\u52A8\u4E86\u8BE5 id\u3002fresh\uFF08await \u7A97\u53E3\u5185\u5E76\u53D1\u5199\uFF09\u53EF\u80FD\u4E5F\u6539\u4E86\u540C\u4E00\u5143\u7D20\u7684\u5176\u5B83\u5B57\u6BB5\uFF1B\u76F4\u63A5\u53D6 sync
      // \u6574\u4EFD\u526F\u672C\u4F1A\u9759\u9ED8\u56DE\u6EDA\u8FD9\u4E9B\u5E76\u53D1\u5199\u3002\u82E5 fresh \u76F8\u5BF9 base \u672A\u53D8\uFF0C\u65E0\u5E76\u53D1\u5199\u53EF\u4FDD\uFF0C\u76F4\u63A5\u53D6 sync \u7248\u672C\uFF1B
      // \u5426\u5219\u6309\u5B57\u6BB5\u4E09\u65B9\u5408\u5E76\uFF0C\u53EA\u8986\u76D6 sync \u771F\u6B63\u6539\u8FC7\u7684\u5B57\u6BB5\u3001\u4FDD\u7559\u5E76\u53D1\u6539\u52A8\u7684\u5B57\u6BB5\u3002
      const baseItem = baseById.get(item.id)
      const mutatedItem = mutatedById.get(item.id)
      if (JSON.stringify(baseItem) === JSON.stringify(item)) {
        kept.push(mutatedItem)
      } else {
        kept.push(mergeChangedFields(baseItem, mutatedItem, item))
      }
    } else {
      kept.push(item) // sync \u672A\u6539\uFF08\u6216 fresh \u5E76\u53D1\u65B0\u589E\uFF09\u2192 \u4FDD\u7559 fresh
    }
  }
  // additions 补入 fresh 里没有、但同步需要落地的元素：
  // - sync 纯新增（base 无该 id）；
  // - sync 改动过、但该 id 已不在 fresh（被并发删除或被 slice 挤出）——不补回就丢了同步改动。
  // sync 未改且已不在 fresh = 并发删除且同步没碰 → 尊重并发删除，不补。
  const additions = mutated.filter((item) => {
    if (item == null || item.id == null || seen.has(item.id)) return false
    if (!baseById.has(item.id)) return true // sync 纯新增
    return JSON.stringify(baseById.get(item.id)) !== JSON.stringify(item) // sync 改动过 → 补回，防丢同步数据
  })
  return additions.concat(kept)
}

// \u589E\u91CF\u5408\u5E76\u56DE\u5199\uFF1A\u7528\u4E8E\u98DE\u4E66\u540C\u6B65\u8FD9\u7C7B\u300Cclone \u79C1\u6709\u526F\u672C \u2192 \u957F await \u2192 \u843D\u76D8\u300D\u7684\u8DEF\u5F84\u3002base \u662F\u540C\u6B65\u5F00\u59CB\u524D\u7684
// \u4E0D\u53EF\u53D8\u57FA\u7EBF\u5FEB\u7167\uFF0Cmutated \u662F\u540C\u6B65\u8DD1\u5B8C\u7684\u79C1\u6709\u526F\u672C\u3002\u76F4\u63A5 writeDb(mutated) \u4F1A\u7528\u540C\u6B65\u5F00\u59CB\u65F6\u7684\u6574\u5E93\u5FEB\u7167
// \u8986\u76D6\u78C1\u76D8\uFF0C\u62B9\u6389 await \u7A97\u53E3\u5185\u5E76\u53D1 updateDb \u843D\u76D8\u7684\u5199\u5165\u3002\u6539\u4E3A\u5728 updateDb \u91CC\u91CD\u8BFB\u6700\u65B0\u5E93\uFF0C\u53EA\u628A mutated
// \u76F8\u5BF9 base \u771F\u6B63\u6539\u52A8\u8FC7\u7684\u90E8\u5206\u5AC1\u63A5\u8FC7\u53BB\uFF1A\u9876\u5C42\u952E\u82E5\u662F\u5E26 id \u7684\u5BF9\u8C61\u6570\u7EC4\uFF08listings/footprints/\u65E5\u5FD7\u7B49\uFF09\uFF0C
// \u6309\u5143\u7D20\u7EA7\u4E09\u65B9\u5408\u5E76\uFF0C\u53EA\u8986\u76D6 sync \u52A8\u8FC7\u7684\u5143\u7D20\u3001\u4FDD\u7559 fresh \u91CC sync \u6CA1\u78B0\u7684\u5143\u7D20\uFF08\u5E76\u53D1\u5199\uFF09\uFF1B\u5176\u4F59\u952E\u505A\u6574\u952E
// \u589E\u91CF\uFF08sync \u6539\u8FC7\u5219\u8986\u76D6\u3001\u672A\u6539\u5219\u4FDD\u7559\u5E76\u53D1\u5199\uFF09\u3002\u8FD9\u6837\u540C\u6B65\u5BF9\u81EA\u5DF1\u623F\u6E90\u7684\u6539\u52A8\u7167\u5E38\u843D\u5730\uFF0C\u800C\u7A97\u53E3\u5185\u5E76\u53D1\u7684\u6210\u4EA4
// \u786E\u8BA4/\u8DB3\u8FF9/\u7F16\u8F91\u4E0D\u518D\u56E0\u201C\u540C\u6B65\u78B0\u4E86\u540C\u4E00\u4E2A\u9876\u5C42\u6570\u7EC4\u201D\u88AB\u6574\u5757\u56DE\u6EDA\u3002sync \u6570\u636E\u6C38\u4E0D\u4E22\u5931\uFF08\u5B83\u52A8\u8FC7\u7684\u5143\u7D20\u603B\u662F\u80DC\u51FA\uFF09\u3002
function commitDelta(base, mutated) {
  const safeBase = base || {}
  const safeMutated = mutated || {}
  return updateDb((freshDb) => {
    const keys = new Set([...Object.keys(safeBase), ...Object.keys(safeMutated)])
    for (const key of keys) {
      const hasNext = Object.prototype.hasOwnProperty.call(safeMutated, key)
      const before = JSON.stringify(safeBase[key])
      const after = hasNext ? JSON.stringify(safeMutated[key]) : undefined
      if (before === after) continue // \u540C\u6B65\u672A\u6539\u8BE5\u952E\uFF0C\u4FDD\u7559 freshDb \u4E2D\u7684\u5E76\u53D1\u5199
      if (!hasNext) { delete freshDb[key]; continue } // \u540C\u6B65\u5220\u9664\u4E86\u8BE5\u9876\u5C42\u952E
      // \u7F3A\u5931\u7684 base \u89C6\u4F5C\u7A7A\u96C6\uFF0C\u4F7F\u300C\u9996\u6B21\u540C\u6B65\uFF08base \u65E0\u6B64\u952E/\u4E3A\u7A7A\uFF09+ \u5E76\u53D1\u5199\u300D\u4E5F\u8D70\u5143\u7D20\u7EA7\u5408\u5E76\u3001\u4E0D\u6574\u5757\u8986\u76D6\u3002
      const baseArr = safeBase[key] === undefined ? [] : safeBase[key]
      if (isIdObjectArray(baseArr) && isIdObjectArray(safeMutated[key])) {
        const freshArr = Array.isArray(freshDb[key]) ? freshDb[key] : []
        freshDb[key] = mergeById(baseArr, safeMutated[key], freshArr)
      } else {
        freshDb[key] = safeMutated[key] // \u975E id \u5BF9\u8C61\u6570\u7EC4\uFF1A\u6574\u952E\u8986\u76D6\uFF08\u4E0E\u65E7\u884C\u4E3A\u4E00\u81F4\uFF09
      }
    }
    return freshDb
  })
}

module.exports = {
  clone,
  readDb,
  writeDb,
  updateDb,
  inspectDb,
  commitDelta
}
