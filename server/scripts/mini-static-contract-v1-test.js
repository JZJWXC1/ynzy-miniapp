const assert = require('assert')
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', '..')
const appJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'))
const registeredPages = new Set(appJson.pages || [])
const staticPageTargetPattern = /\/pages\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g
const eventHandlerPattern = /\b(?:bind|catch)(?::?[a-zA-Z][\w-]*)\s*=\s*"([^"]+)"/g

global.wx = {}
global.getApp = () => ({ globalData: {} })
global.getCurrentPages = () => []

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function assertFile(filePath, message) {
  assert.ok(fs.existsSync(filePath), `${message}：${path.relative(repoRoot, filePath)}`)
}

function loadDefinition(filePath, registrationName) {
  let definition = null
  const previous = global[registrationName]
  global[registrationName] = (value) => {
    definition = value
  }
  try {
    delete require.cache[require.resolve(filePath)]
    require(filePath)
  } finally {
    if (previous === undefined) delete global[registrationName]
    else global[registrationName] = previous
  }
  assert.ok(definition, `${path.relative(repoRoot, filePath)} 未调用 ${registrationName}`)
  return definition
}

function eventHandlers(wxml) {
  const handlers = []
  let matched
  while ((matched = eventHandlerPattern.exec(wxml)) !== null) {
    const name = String(matched[1] || '').trim()
    if (name && !name.includes('{{')) handlers.push(name)
  }
  return Array.from(new Set(handlers))
}

function assertHandlers(wxmlPath, methodNames) {
  eventHandlers(read(wxmlPath)).forEach((handler) => {
    assert.ok(methodNames.has(handler), `${path.relative(repoRoot, wxmlPath)} 绑定了缺失处理器 ${handler}`)
  })
}

function localComponentBase(componentPath) {
  const relative = String(componentPath || '').replace(/^\//, '')
  return path.join(repoRoot, relative)
}

const scannedSources = []

for (const pageName of registeredPages) {
  const basePath = path.join(repoRoot, pageName)
  const jsPath = `${basePath}.js`
  const wxmlPath = `${basePath}.wxml`
  const jsonPath = `${basePath}.json`
  const wxssPath = `${basePath}.wxss`
  ;[
    [jsPath, '注册页面缺少 JS'],
    [wxmlPath, '注册页面缺少 WXML'],
    [jsonPath, '注册页面缺少 JSON'],
    [wxssPath, '注册页面缺少 WXSS']
  ].forEach(([filePath, message]) => assertFile(filePath, message))

  const definition = loadDefinition(jsPath, 'Page')
  const methods = new Set(Object.keys(definition).filter((key) => typeof definition[key] === 'function'))
  assertHandlers(wxmlPath, methods)

  const pageConfig = JSON.parse(read(jsonPath))
  Object.values(pageConfig.usingComponents || {}).forEach((componentPath) => {
    if (!String(componentPath).startsWith('/')) return
    const componentBase = localComponentBase(componentPath)
    ;['.js', '.json', '.wxml', '.wxss'].forEach((extension) => {
      assertFile(`${componentBase}${extension}`, '页面引用的本地组件文件缺失')
    })
  })

  scannedSources.push(jsPath, wxmlPath)
}

const componentBases = [
  path.join(repoRoot, 'components', 'navigation-bar', 'navigation-bar'),
  path.join(repoRoot, 'components', 'listing-filter', 'listing-filter'),
  path.join(repoRoot, 'components', 'favorite-toggle', 'favorite-toggle'),
  path.join(repoRoot, 'custom-tab-bar', 'index')
]

componentBases.forEach((basePath) => {
  const jsPath = `${basePath}.js`
  const wxmlPath = `${basePath}.wxml`
  const definition = loadDefinition(jsPath, 'Component')
  const methods = new Set(Object.keys(definition.methods || {}).filter((key) => typeof definition.methods[key] === 'function'))
  assertHandlers(wxmlPath, methods)
  scannedSources.push(jsPath, wxmlPath)
})

const tabPages = ((appJson.tabBar && appJson.tabBar.list) || []).map((item) => item.pagePath)
tabPages.forEach((pageName) => {
  assert.ok(registeredPages.has(pageName), `Tab 页面未注册：${pageName}`)
})

scannedSources.forEach((filePath) => {
  const source = read(filePath)
  const targets = source.match(staticPageTargetPattern) || []
  targets.forEach((target) => {
    const pageName = target.replace(/^\//, '')
    assert.ok(registeredPages.has(pageName), `${path.relative(repoRoot, filePath)} 跳转到未注册页面 ${target}`)
  })
})

const clientSources = (appJson.pages || [])
  .map((pageName) => read(path.join(repoRoot, `${pageName}.js`)))
  .join('\n')
assert.ok(!/\.innerHTML\s*=/.test(clientSources), '小程序页面不得使用裸 innerHTML')

console.log(`mini-static-contract-v1-test passed: ${registeredPages.size} pages, ${scannedSources.length} sources`)
