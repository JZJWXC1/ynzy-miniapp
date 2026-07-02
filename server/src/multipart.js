function requestContentType(req) {
  return String((req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '')
}

function multipartBoundary(contentType) {
  const matched = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  return matched ? String(matched[1] || matched[2] || '').trim() : ''
}

function headerLinesToObject(headerText) {
  return String(headerText || '').split(/\r?\n/).reduce((result, line) => {
    const index = line.indexOf(':')
    if (index === -1) return result
    const key = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    if (key) result[key] = value
    return result
  }, {})
}

function parseContentDisposition(value) {
  const result = {}
  String(value || '').replace(/;\s*([^=]+)=("([^"]*)"|[^;]*)/g, (all, key, raw, quoted) => {
    result[String(key || '').trim()] = quoted === undefined ? String(raw || '').replace(/^"|"$/g, '') : quoted
    return all
  })
  return result
}

function stripTrailingCrlf(buffer) {
  if (buffer.length >= 2 && buffer[buffer.length - 2] === 13 && buffer[buffer.length - 1] === 10) {
    return buffer.slice(0, -2)
  }
  return buffer
}

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += next.length
      if (size > maxBytes) {
        const error = new Error('上传文件过大')
        error.statusCode = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(next)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseMultipartBuffer(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const headerSeparator = Buffer.from('\r\n\r\n')
  const fields = {}
  const files = []
  let cursor = 0

  while (cursor < buffer.length) {
    const boundaryStart = buffer.indexOf(boundaryBuffer, cursor)
    if (boundaryStart === -1) break

    let partStart = boundaryStart + boundaryBuffer.length
    const isFinalBoundary = buffer[partStart] === 45 && buffer[partStart + 1] === 45
    if (isFinalBoundary) break
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2

    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart)
    if (nextBoundary === -1) break

    let part = buffer.slice(partStart, nextBoundary)
    part = stripTrailingCrlf(part)
    const headerEnd = part.indexOf(headerSeparator)
    if (headerEnd !== -1) {
      const headers = headerLinesToObject(part.slice(0, headerEnd).toString('utf8'))
      const body = part.slice(headerEnd + headerSeparator.length)
      const disposition = parseContentDisposition(headers['content-disposition'])
      const name = disposition.name || ''
      if (name && disposition.filename !== undefined) {
        files.push({
          name,
          filename: disposition.filename || '',
          contentType: headers['content-type'] || 'application/octet-stream',
          buffer: body,
          size: body.length
        })
      } else if (name) {
        fields[name] = body.toString('utf8')
      }
    }

    cursor = nextBoundary
  }

  return {
    fields,
    files,
    file: files[0] || null
  }
}

async function parseMultipartForm(req, options = {}) {
  const contentType = requestContentType(req)
  const boundary = multipartBoundary(contentType)
  if (!boundary) {
    const error = new Error('缺少 multipart boundary')
    error.statusCode = 400
    throw error
  }
  const maxBytes = options.maxBytes || 10 * 1024 * 1024
  const buffer = await readRequestBuffer(req, maxBytes)
  return parseMultipartBuffer(buffer, boundary)
}

module.exports = {
  parseMultipartForm,
  _internal: {
    multipartBoundary,
    parseMultipartBuffer,
    parseContentDisposition,
    readRequestBuffer
  }
}
