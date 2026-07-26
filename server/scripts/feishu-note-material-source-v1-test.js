'use strict'

const assert = require('assert')
const {
  normalizeNoteMaterialLinkCell,
  parseNoteMaterialLink,
  resolveNoteMaterialVideos
} = require('../src/feishu-note-material-sync')

const ALLOWED_HOST = 'tenant.example.feishu.cn'

async function run() {
  assert.deepStrictEqual(
    normalizeNoteMaterialLinkCell({
      link: `https://${ALLOWED_HOST}/drive/folder/fldSourceFolder123?from=copy#section`,
      text: '员工可修改显示文字'
    }, { allowedHosts: [ALLOWED_HOST] }),
    {
      link: `https://${ALLOWED_HOST}/drive/folder/fldSourceFolder123`,
      text: '房源素材'
    },
    '超链接必须只保留严格飞书资源路径，显示文字不得成为素材身份'
  )

  assert.deepStrictEqual(
    parseNoteMaterialLink(`https://${ALLOWED_HOST}/file/boxSourceVideo123`, {
      allowedHosts: [ALLOWED_HOST]
    }),
    {
      kind: 'file',
      token: 'boxSourceVideo123',
      canonicalUrl: `https://${ALLOWED_HOST}/file/boxSourceVideo123`
    },
    '必须支持单个 Drive 文件链接'
  )

  assert.throws(
    () => parseNoteMaterialLink('https://evil.example/drive/folder/fldSourceFolder123', {
      allowedHosts: [ALLOWED_HOST]
    }),
    /域名|白名单/,
    '任意外域链接必须在任何 API 请求前失败'
  )
  assert.throws(
    () => parseNoteMaterialLink(`http://${ALLOWED_HOST}/drive/folder/fldSourceFolder123`, {
      allowedHosts: [ALLOWED_HOST]
    }),
    /HTTPS/,
    '房源笔记不得允许明文 HTTP'
  )
  assert.throws(
    () => parseNoteMaterialLink(`https://${ALLOWED_HOST}/share/short-token`, {
      allowedHosts: [ALLOWED_HOST]
    }),
    /资源路径/,
    '不得跟随无法离线确认目标的短链或分享跳转'
  )

  const folderItems = new Map([
    ['fldSourceFolder123', [
      { token: 'boxVideoA123456', name: 'A.mp4', type: 'file', modifiedTime: '10', size: 101 },
      { token: 'fldChildFolder123', name: '子目录', type: 'folder', modifiedTime: '11' },
      { token: 'boxIgnorePdf123', name: '说明.pdf', type: 'file', modifiedTime: '12', size: 12 }
    ]],
    ['fldChildFolder123', [
      { token: 'boxVideoB123456', name: 'B.mov', type: 'file', modifiedTime: '13', size: 202 }
    ]]
  ])
  let rawLinkFetchCount = 0
  const folderClient = {
    async listFolder(token) {
      return folderItems.get(token) || []
    },
    async getFile(token) {
      return { token, name: 'direct.mp4', type: 'file', modifiedTime: '20', size: 303 }
    },
    async listDocxBlocks() {
      return []
    },
    async resolveWikiNode() {
      throw new Error('unexpected wiki request')
    },
    async fetchRawLink() {
      rawLinkFetchCount += 1
      throw new Error('禁止调用')
    }
  }

  const folderResolved = await resolveNoteMaterialVideos({
    value: {
      link: `https://${ALLOWED_HOST}/drive/folder/fldSourceFolder123`,
      text: '素材目录'
    },
    allowedHosts: [ALLOWED_HOST],
    client: folderClient
  })
  assert.deepStrictEqual(
    folderResolved.assets.map((asset) => asset.sourceToken),
    ['boxVideoA123456', 'boxVideoB123456'],
    '文件夹及子目录中的全部视频必须按稳定顺序进入素材集合'
  )
  assert.strictEqual(folderResolved.counts.nonVideo, 1, '非视频文件必须明确计数，不得伪装成已同步素材')
  assert.strictEqual(rawLinkFetchCount, 0, '实现不得请求员工填写的原始 URL')
  await assert.rejects(
    () => resolveNoteMaterialVideos({
      value: `https://${ALLOWED_HOST}/drive/folder/fldSourceFolder123`,
      allowedHosts: [ALLOWED_HOST],
      client: folderClient,
      maxItems: 2
    }),
    /数量|上限/,
    '递归遍历计数必须永久累加，进入子目录时不得回退已检查项目数'
  )

  const beforeDigest = folderResolved.digest
  folderItems.get('fldChildFolder123').push({
    token: 'boxVideoC123456',
    name: 'C.webm',
    type: 'file',
    modifiedTime: '14',
    size: 404
  })
  const changedFolder = await resolveNoteMaterialVideos({
    value: `https://${ALLOWED_HOST}/drive/folder/fldSourceFolder123`,
    allowedHosts: [ALLOWED_HOST],
    client: folderClient
  })
  assert.strictEqual(changedFolder.assets.length, 3, '链接不变时也必须重新枚举文件夹内容')
  assert.notStrictEqual(changedFolder.digest, beforeDigest, '文件夹内容变化必须改变素材集合摘要')

  const docClient = {
    async listFolder() {
      throw new Error('unexpected folder request')
    },
    async getFile(token) {
      return { token, name: 'wiki-file.mp4', type: 'file', modifiedTime: '30', size: 505 }
    },
    async listDocxBlocks(token) {
      assert.strictEqual(token, 'docxResolvedToken123')
      return [
        {
          block_id: 'block-file-1',
          block_type: 23,
          file: { token: 'mediaDocVideo123', name: '文档视频.mp4' }
        },
        {
          block_id: 'block-image-1',
          block_type: 27,
          image: { token: 'mediaDocImage123' }
        }
      ]
    },
    async resolveWikiNode(token) {
      assert.strictEqual(token, 'wikiSourceNode123')
      return { objToken: 'docxResolvedToken123', objType: 'docx' }
    }
  }
  const wikiResolved = await resolveNoteMaterialVideos({
    value: `https://${ALLOWED_HOST}/wiki/wikiSourceNode123`,
    allowedHosts: [ALLOWED_HOST],
    client: docClient
  })
  assert.deepStrictEqual(
    wikiResolved.assets.map((asset) => asset.sourceToken),
    ['mediaDocVideo123'],
    'Wiki 指向 Docx 时必须遍历 File Block 取得视频素材'
  )
  assert.strictEqual(wikiResolved.counts.nonVideo, 1, 'Docx 图片块必须单独计数')

  const duplicateClient = {
    async listFolder() {
      return [
        { token: 'boxDuplicate123', name: 'one.mp4', type: 'file' },
        { token: 'boxDuplicate123', name: 'two.mp4', type: 'file' }
      ]
    }
  }
  const duplicateResolved = await resolveNoteMaterialVideos({
    value: `https://${ALLOWED_HOST}/drive/folder/fldDuplicateFolder123`,
    allowedHosts: [ALLOWED_HOST],
    client: duplicateClient
  })
  assert.strictEqual(duplicateResolved.assets.length, 1, '同一房源重复引用同一 token 只同步一次')
  assert.strictEqual(duplicateResolved.counts.duplicateReference, 1, '重复引用必须可对账')

  console.log('feishu-note-material-source-v1-test passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
