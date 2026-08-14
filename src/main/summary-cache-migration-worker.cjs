const fs = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')
const Database = require('better-sqlite3')
const { parser } = require('stream-json')
const { pick } = require('stream-json/filters/Pick')
const { compactPerFileJson } = require('./summary-cache-compact.cjs')

const COMPATIBLE_VERSIONS = new Set([25, 26, 27])

function sourceCompatible(version, source) {
  if (version <= 26 && (source === 'opencode' || source === 'zcode')) return false
  if (version === 25 && source === 'codex') return false
  return true
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function legacyVersion(legacyPath) {
  const descriptor = fs.openSync(legacyPath, 'r')
  try {
    const bytes = Buffer.allocUnsafe(1024 * 1024)
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0)
    return Number(/"version"\s*:\s*(\d+)/.exec(bytes.subarray(0, length).toString('utf8'))?.[1] || 0)
  } finally {
    fs.closeSync(descriptor)
  }
}

function createJsonTokenWriter() {
  const chunks = []
  const containers = []
  let stringOpen = false
  const beforeValue = () => {
    const parent = containers[containers.length - 1]
    if (!parent) return
    if (parent.type === 'array') {
      if (!parent.first) chunks.push(',')
      parent.first = false
    } else if (parent.expectingValue) {
      parent.expectingValue = false
    } else {
      throw new Error('summary-cache-migration-object-value-without-key')
    }
  }
  return {
    write(token) {
      if (token.name === 'startObject' || token.name === 'startArray') {
        beforeValue()
        const object = token.name === 'startObject'
        chunks.push(object ? '{' : '[')
        containers.push({ type: object ? 'object' : 'array', first: true, expectingValue: false })
      } else if (token.name === 'endObject' || token.name === 'endArray') {
        const expectedType = token.name === 'endObject' ? 'object' : 'array'
        const container = containers.pop()
        if (!container || container.type !== expectedType || container.expectingValue) {
          throw new Error('summary-cache-migration-container-mismatch')
        }
        chunks.push(expectedType === 'object' ? '}' : ']')
      } else if (token.name === 'keyValue') {
        const parent = containers[containers.length - 1]
        if (!parent || parent.type !== 'object' || parent.expectingValue) {
          throw new Error('summary-cache-migration-key-outside-object')
        }
        if (!parent.first) chunks.push(',')
        parent.first = false
        parent.expectingValue = true
        chunks.push(JSON.stringify(token.value), ':')
      } else if (token.name === 'startString') {
        beforeValue()
        if (stringOpen) throw new Error('summary-cache-migration-nested-string')
        stringOpen = true
        chunks.push('"')
      } else if (token.name === 'stringChunk') {
        if (!stringOpen) throw new Error('summary-cache-migration-string-chunk-outside-string')
        // The parser has already decoded JSON escapes. Re-escape each bounded
        // chunk without asking V8 to retain a packed copy of the full string.
        chunks.push(JSON.stringify(token.value).slice(1, -1))
      } else if (token.name === 'endString') {
        if (!stringOpen) throw new Error('summary-cache-migration-string-end-without-start')
        stringOpen = false
        chunks.push('"')
      } else {
        beforeValue()
        if (token.name === 'numberValue') {
          if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token.value)) {
            throw new Error('summary-cache-migration-invalid-number')
          }
          chunks.push(token.value)
        } else if (token.name === 'trueValue') chunks.push('true')
        else if (token.name === 'falseValue') chunks.push('false')
        else if (token.name === 'nullValue') chunks.push('null')
        else throw new Error(`summary-cache-migration-unsupported-token-${token.name}`)
      }
    },
    complete() { return containers.length === 0 && !stringOpen },
    value() {
      if (containers.length !== 0 || stringOpen) {
        throw new Error('summary-cache-migration-incomplete-value')
      }
      return chunks.join('')
    }
  }
}

async function migrate() {
  const { legacyPath, databasePath, cacheVersion } = workerData
  if (fs.existsSync(databasePath)) {
    const database = new Database(databasePath)
    try {
      const version = Number(database.pragma('user_version', { simple: true }))
      if (version !== 28 || cacheVersion !== 29) return false
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = NORMAL')
      database.transaction(() => {
        const columns = new Set(database.prepare('PRAGMA table_info(summary_cache_entries)').all()
          .map((column) => column.name))
        if (!columns.has('compact_json')) {
          database.exec('ALTER TABLE summary_cache_entries ADD COLUMN compact_json TEXT')
        }
        const update = database.prepare(
          'UPDATE summary_cache_entries SET compact_json = ? WHERE file_path = ?'
        )
        const selectBatch = database.prepare(`
          SELECT file_path, per_file_json FROM summary_cache_entries
          WHERE file_path > ? ORDER BY file_path LIMIT 25
        `)
        let after = ''
        while (true) {
          const rows = selectBatch.all(after)
          if (rows.length === 0) break
          for (const row of rows) {
            update.run(compactPerFileJson(JSON.parse(row.per_file_json)), row.file_path)
          }
          after = rows[rows.length - 1].file_path
        }
        database.pragma(`user_version = ${cacheVersion}`)
      })()
      return true
    } finally {
      database.close()
    }
  }
  if (!fs.existsSync(legacyPath)) return false
  const version = legacyVersion(legacyPath)
  if (!COMPATIBLE_VERSIONS.has(version)) return false
  const directory = require('node:path').dirname(databasePath)
  const temporaryPath = `${databasePath}.migration.${process.pid}.tmp`
  let database = null
  try {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(`${temporaryPath}${suffix}`, { force: true })
    }
    database = new Database(temporaryPath)
    database.pragma('journal_mode = DELETE')
    database.pragma('synchronous = FULL')
    database.exec(`
      CREATE TABLE summary_cache_entries (
        file_path TEXT PRIMARY KEY,
        sig TEXT NOT NULL,
        per_file_json TEXT NOT NULL,
        compact_json TEXT NOT NULL
      );
      BEGIN IMMEDIATE;
    `)
    const insert = database.prepare(`
      INSERT INTO summary_cache_entries(file_path, sig, per_file_json, compact_json)
      VALUES (?, ?, ?, ?)
    `)
    const sourceStream = fs.createReadStream(legacyPath)
    const jsonParser = parser({
        packKeys: true,
        streamKeys: false,
        packStrings: false,
        streamStrings: true,
        packNumbers: true,
        streamNumbers: false
      })
    const entryPicker = pick({ filter: 'entries' })
    // Node's pipe() does not forward upstream errors. Destroy the iterable
    // destination explicitly so malformed/truncated JSON rejects the worker
    // instead of leaving it waiting forever for a token that can never arrive.
    sourceStream.on('error', (error) => entryPicker.destroy(error))
    jsonParser.on('error', (error) => entryPicker.destroy(error))
    const pipeline = sourceStream.pipe(jsonParser).pipe(entryPicker)
    let depth = 0
    let filePath = ''
    let entryField = ''
    let perFileField = ''
    let sig = ''
    let source
    let writer = null
    let capturedString = null
    let capturedChunks = []
    for await (const token of pipeline) {
      const starting = token.name === 'startObject' || token.name === 'startArray'
      const ending = token.name === 'endObject' || token.name === 'endArray'

      if (token.name === 'keyValue') {
        if (depth === 1) filePath = token.value
        else if (depth === 2) entryField = token.value
        else if (writer && depth === 3) perFileField = token.value
      }
      if (token.name === 'startString') {
        if (depth === 2 && entryField === 'sig') capturedString = 'sig'
        else if (writer && depth === 3 && perFileField === 'source') capturedString = 'source'
        else capturedString = null
        capturedChunks = []
      } else if (token.name === 'stringChunk' && capturedString) {
        capturedChunks.push(token.value)
      } else if (token.name === 'endString' && capturedString) {
        const value = capturedChunks.join('')
        if (capturedString === 'sig') sig = value
        else source = value
        capturedString = null
        capturedChunks = []
      }

      if (starting && depth === 2 && entryField === 'perFile') {
        writer = createJsonTokenWriter()
        source = undefined
        perFileField = ''
      }
      if (writer) writer.write(token)
      if (starting) depth++
      if (ending) depth--

      if (writer && writer.complete()) {
        if (filePath && sig && sourceCompatible(version, source)) {
          const perFileJson = writer.value()
          insert.run(
            filePath,
            sig,
            perFileJson,
            compactPerFileJson(JSON.parse(perFileJson))
          )
        }
        writer = null
      }
      if (ending && depth === 1) {
        filePath = ''
        entryField = ''
        sig = ''
        source = undefined
      }
    }
    database.pragma(`user_version = ${cacheVersion}`)
    database.exec('COMMIT')
    database.close()
    database = null
    fs.renameSync(temporaryPath, databasePath)
    fsyncDirectory(directory)
    fs.unlinkSync(legacyPath)
    fsyncDirectory(directory)
    return true
  } catch (error) {
    try { database?.exec('ROLLBACK') } catch { /* no active transaction */ }
    throw error
  } finally {
    try { database?.close() } catch { /* ignore cleanup failure */ }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.rmSync(`${temporaryPath}${suffix}`, { force: true }) } catch { /* preserve final DB */ }
    }
  }
}

migrate().then(
  (migrated) => parentPort.postMessage({ migrated }),
  (error) => parentPort.postMessage({
    migrated: false,
    error: error instanceof Error ? error.message : String(error)
  })
).finally(() => parentPort.close())
