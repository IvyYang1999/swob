import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCursorSessionSummary,
  buildCursorSessionDetail,
  buildCursorSessionSummaryFromBackup,
  cursorProjectSlug,
  findCursorSessionFiles,
  findCursorSourceGenerations,
  loadCursorRawMessages,
  parseCursorFileWithStats
} from './cursor-loader'
import { buildResumeCommand } from './session-actions'
import { shellQuote } from './resume-terminal'

function writeTempJsonl(lines: object[], sessionId = 'abc-def-123'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cursor-test-'))
  const sessionDir = path.join(dir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })
  const fp = path.join(sessionDir, `${sessionId}.jsonl`)
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'))
  return fp
}

function writeBackupJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cursor-backup-test-'))
  const fp = path.join(dir, 'backup.jsonl')
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'))
  return fp
}

function makeCursorLines() {
  return [
    {
      role: 'user',
      message: { content: [{ type: 'text', text: '<user_query>\n阅读项目文件\n</user_query>' }] }
    },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '我来先阅读项目文档。' },
          { type: 'tool_use', name: 'Read', id: 'toolu_001', input: { path: '/test/README.md' } }
        ]
      }
    },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '项目文档内容如下...' }
        ]
      }
    },
    {
      role: 'user',
      message: { content: [{ type: 'text', text: '<user_query>\n帮我加个按钮\n</user_query>' }] }
    },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '好的，我来添加按钮。' },
          { type: 'tool_use', name: 'Write', id: 'toolu_002', input: { path: '/test/App.tsx', contents: '<button>Click</button>' } }
        ]
      }
    }
  ]
}

describe('cursor-loader', () => {
  describe('findCursorSessionFiles', () => {
    it('扫描 ~/.cursor/projects/ 下的 agent-transcripts', () => {
      const files = findCursorSessionFiles()
      for (const f of files) {
        expect(f).toContain('agent-transcripts')
        expect(f).toMatch(/\.jsonl$/)
      }
    })

    it('分别发现 transcript/ACP JSONL 与 store.db resume 源', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cursor-generations-'))
      const transcript = path.join(home, '.cursor', 'projects', 'fixture', 'agent-transcripts', 'session-1', 'session-1.jsonl')
      const store = path.join(home, '.cursor', 'chats', 'workspace', 'session-1', 'store.db')
      fs.mkdirSync(path.dirname(transcript), { recursive: true })
      fs.mkdirSync(path.dirname(store), { recursive: true })
      fs.writeFileSync(transcript, '{}\n')
      fs.writeFileSync(store, '')
      try {
        expect(findCursorSourceGenerations(home)).toEqual({
          transcriptJsonl: [transcript],
          resumeStoreDb: [store]
        })
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    })
  })

  describe('buildCursorSessionSummary', () => {
    it('正确解析 Cursor session 为 SessionSummary', async () => {
      const fp = writeTempJsonl(makeCursorLines())
      const summary = await buildCursorSessionSummary(fp)

      expect(summary).not.toBeNull()
      expect(summary!.source).toBe('cursor')
      expect(summary!.id).toBe('cursor:abc-def-123')
      expect(summary!.sessionId).toBe('abc-def-123')
      expect(summary!.turnCount).toBe(2)
      expect(summary!.toolUsage['Read']).toBe(1)
      expect(summary!.toolUsage['Write']).toBe(1)
      expect(summary!.tokenAccounting?.provenance).toBe('unavailable')
      expect(summary!.activityDays).toEqual([])
      expect(summary!.tokenAccounting?.billingTotal).toBeNull()
      expect(summary!.tokenAccounting?.unavailableReason).toContain('do not expose authoritative token usage')
    })

    it('只把 transcript 自带时间计入 activity evidence，不把文件 mtime 当事件时间', async () => {
      const lines = makeCursorLines().map((line, index) => ({
        ...line,
        timestamp: index < 2 ? '2026-07-20T10:00:00Z' : '2026-07-21T10:00:00Z'
      }))
      const summary = await buildCursorSessionSummary(writeTempJsonl(lines))
      expect(summary?.activityDays).toEqual(['2026-07-20', '2026-07-21'])
    })

    it('【曾经的 bug】user_query XML 标签应被清理', async () => {
      const fp = writeTempJsonl(makeCursorLines())
      const summary = await buildCursorSessionSummary(fp)

      expect(summary!.firstUserMessage).not.toContain('<user_query>')
      expect(summary!.firstUserMessage).toBe('阅读项目文件')
    })

    it('空文件返回 null', async () => {
      const fp = writeTempJsonl([])
      const summary = await buildCursorSessionSummary(fp)
      expect(summary).toBeNull()
    })

    it('【曾经的 bug】cursor backup summary 应使用 override sessionId 而不是目录名', async () => {
      const fp = writeBackupJsonl(makeCursorLines())
      const summary = await buildCursorSessionSummaryFromBackup(fp, 'cursor-override-session')

      expect(summary).not.toBeNull()
      expect(summary!.sessionId).toBe('cursor-override-session')
      expect(summary!.id).toBe('cursor:cursor-override-session')
    })
  })

  describe('buildCursorSessionDetail', () => {
    it('生成包含消息列表的 detail', async () => {
      const fp = writeTempJsonl(makeCursorLines())
      const detail = await buildCursorSessionDetail(fp)

      expect(detail).not.toBeNull()
      expect(detail!.source).toBe('cursor')
      expect(detail!.messages.length).toBeGreaterThan(0)

      const userMsgs = detail!.messages.filter((m) => m.type === 'user' && !m.isSystemGenerated)
      expect(userMsgs.length).toBe(2)

      const assistantMsgs = detail!.messages.filter((m) => m.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(3)
    })

    it('工具调用被正确提取', async () => {
      const fp = writeTempJsonl(makeCursorLines())
      const detail = await buildCursorSessionDetail(fp)

      const toolCallMsgs = detail!.messages.filter((m) => m.toolCalls.length > 0)
      expect(toolCallMsgs.length).toBeGreaterThanOrEqual(2)
      expect(toolCallMsgs[0].toolCalls[0].name).toBe('Read')
    })

    it('纯文本 user message 正确解析', async () => {
      const lines = [
        { role: 'user', message: { content: [{ type: 'text', text: '普通消息不带 XML 包装' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: '收到。' }] } }
      ]
      const fp = writeTempJsonl(lines)
      const summary = await buildCursorSessionSummary(fp)

      expect(summary!.firstUserMessage).toBe('普通消息不带 XML 包装')
    })

    it('【曾经的 bug】[Image] 前缀应被清理', async () => {
      const lines = [
        { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n[Image]\n帮我看看这个截图\n</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: '好的。' }] } }
      ]
      const fp = writeTempJsonl(lines)
      const detail = await buildCursorSessionDetail(fp)

      const userMsg = detail!.messages.find((m) => m.type === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg!.textContent).not.toContain('<user_query>')
      expect(userMsg!.textContent).not.toMatch(/^\[Image\]/)
      expect(userMsg!.textContent).toContain('帮我看看这个截图')
    })

    it('【曾经的 bug】detail 中 <user_query> 也被清理', async () => {
      const fp = writeTempJsonl(makeCursorLines())
      const detail = await buildCursorSessionDetail(fp)

      const userMsgs = detail!.messages.filter((m) => m.type === 'user')
      for (const m of userMsgs) {
        expect(m.textContent).not.toContain('<user_query>')
      }
    })

    it('保留 ACP reasoning 与 base64 image，usage 仍明确 unavailable', async () => {
      const fp = writeTempJsonl([
        { role: 'user', message: { content: [{ type: 'text', text: 'inspect' }] } },
        { role: 'assistant', message: { content: [
          { type: 'reasoning', text: 'reason first' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
          { type: 'text', text: 'done' }
        ] } }
      ])
      const detail = await buildCursorSessionDetail(fp)
      const assistant = detail?.messages.find((message) => message.type === 'assistant')

      expect(JSON.stringify(assistant?.raw)).toContain('reason first')
      expect(assistant?.images).toEqual(['data:image/png;base64,YWJj'])
      expect(detail?.tokenAccounting?.provenance).toBe('unavailable')
    })
  })
})

describe('parseCursorFile 只按 \\n 分行（F1a）', () => {
  const RAW_LS = Buffer.from([0xe2, 0x80, 0xa8]) // U+2028
  const RAW_PS = Buffer.from([0xe2, 0x80, 0xa9]) // U+2029

  // 键序照本文件 makeCursorLines：{role, message: {content}}。值全部是合成的。
  // 依次是：user（含 U+2028）、assistant（含 U+2029）、一条真坏行、一条没写完的尾行（无结尾 \n）。
  function writeLineSeparatorTranscript(sessionId = 'f1a-cursor-session'): string {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n第一行 第二行\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: '段一 段二' }] } }
    ]
    const broken = '{"role":"user","message":{"content":'
    const tail = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '写到一半的回复' }] } }).slice(0, 50)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-cursor-'))
    const sessionDir = path.join(dir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    const fp = path.join(sessionDir, `${sessionId}.jsonl`)
    fs.writeFileSync(fp, [...lines.map((line) => JSON.stringify(line)), broken, tail].join('\n'))
    return fp
  }

  it('含原样 U+2028 / U+2029 的 user、assistant 记录不再丢', async () => {
    const fp = writeLineSeparatorTranscript()
    const bytes = fs.readFileSync(fp)
    expect(bytes.includes(RAW_LS)).toBe(true)
    expect(bytes.includes(RAW_PS)).toBe(true)

    const detail = await buildCursorSessionDetail(fp)
    expect(detail!.messages.filter((m) => m.type === 'user').map((m) => m.textContent)).toEqual(['第一行 第二行'])
    expect(detail!.messages.filter((m) => m.type === 'assistant').map((m) => m.textContent)).toEqual(['段一 段二'])
  })

  it('读流出错（文件不存在）时照旧抛出，由调用方兜底', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-cursor-missing-'))
    await expect(buildCursorSessionSummary(path.join(dir, 'missing', 'missing.jsonl')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('parseCursorFileWithStats 按记录计数：2 条记录读全，坏行与截断尾行各计一条丢失', async () => {
    const fp = writeLineSeparatorTranscript()
    const { lines, ...stats } = await parseCursorFileWithStats(fp)
    expect(lines.map((line) => line.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(lines[0].message)).toContain('第一行 第二行')
    expect(JSON.stringify(lines[1].message)).toContain('段一 段二')
    expect(stats).toEqual({
      nonBlankLines: 4,
      recordsRead: 2,
      badLines: 2,
      recordsLost: 2,
      partialTail: true,
      truncated: false
    })
  })

  it('parseCursorFileWithStats：读流出错时照旧抛出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-cursor-missing-'))
    await expect(parseCursorFileWithStats(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Cursor 工作目录：转录线索 + chats/<md5(工作区)> 目录名确认（F1c-2）', () => {
  // 合成 HOME：.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl，以及
  // .cursor/chats/<md5(工作区)>/<id>/store.db（空文件，产品代码只看目录在不在）。
  // 键序照真实转录（只看键名核对过）：{role, message: {content: [{type, text} | {type, name, input}]}}；
  // 真实的 tool_use 没有 id。值全部是合成的。
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1c2-cursor-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const md5 = (value: string): string => crypto.createHash('md5').update(value).digest('hex')
  const legacyGuess = (slug: string): string => '/' + slug.replace(/-/g, '/')

  function makeDir(...segments: string[]): string {
    const dir = path.join(root, ...segments)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  function writeTranscript(home: string, slug: string, sessionId: string, lines: object[]): string {
    const fp = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
    return fp
  }

  function writeChatStore(home: string, workspace: string, sessionId: string): string {
    const store = path.join(home, '.cursor', 'chats', md5(workspace), sessionId, 'store.db')
    fs.mkdirSync(path.dirname(store), { recursive: true })
    fs.writeFileSync(store, '')
    return store
  }

  /** user_query 点名工作区里的文件；assistant 读文件、在子目录里跑命令。 */
  function linesMentioning(workspace: string): object[] {
    return [
      { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n先看 ${workspace}/docs/说明.md，再改\n</user_query>` }] } },
      { role: 'assistant', message: { content: [
        { type: 'text', text: '先读入口文件。' },
        { type: 'tool_use', name: 'Read', input: { path: path.join(workspace, 'src', 'app.ts') } }
      ] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Shell', input: { command: 'npm test', description: '跑测试', working_directory: path.join(workspace, 'src') } }
      ] } }
    ]
  }

  /** 只有相对路径，没有任何绝对路径线索。 */
  function linesWithoutClues(): object[] {
    return [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n加个按钮\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'src/App.tsx' } }] } }
    ]
  }

  it('cursorProjectSlug：连续的非字母数字合成一个 -，首尾去掉（纯中文目录名不占位）', () => {
    expect(cursorProjectSlug('/Users/me/my-app')).toBe('Users-me-my-app')
    expect(cursorProjectSlug('/Users/me/.cursor/a b/c_d')).toBe('Users-me-cursor-a-b-c-d')
    expect(cursorProjectSlug('/Users/me/笔记/notes-app/草稿')).toBe('Users-me-notes-app')
  })

  it('reported：正文里的绝对路径逐级取祖先，md5 命中本会话的 chats 目录；带连字符的项目名不再被拆开', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', 'my-app-v2')
    const sessionId = 'f1c2-reported'
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, linesMentioning(workspace))
    const store = writeChatStore(home, workspace, sessionId)

    const summary = await buildCursorSessionSummary(fp)
    expect(summary).toMatchObject({ cwds: [workspace], resumeCwd: workspace, cwdProvenance: 'reported' })
    expect(summary!.resumeCwd).not.toBe(legacyGuess(cursorProjectSlug(workspace)))

    // 每条消息的 cwd、detail、恢复命令都用同一个路径
    const raw = await loadCursorRawMessages(fp)
    expect(new Set(raw.map((message) => message.cwd))).toEqual(new Set([workspace]))
    const detail = await buildCursorSessionDetail(fp)
    expect(detail!.messages.every((message) => message.raw.cwd === workspace)).toBe(true)
    expect(buildResumeCommand(sessionId, undefined, summary!.resumeCwd, 'cursor'))
      .toBe(`cd ${shellQuote(workspace)} && cursor agent --resume ${shellQuote(sessionId)}`)

    // store.db 只看存在性：旁边没有多出 -wal / -shm
    expect(fs.readdirSync(path.dirname(store))).toEqual(['store.db'])
  })

  it('reported：正文还提到别的项目、那个项目也有 chats 目录时，只认装着本会话的那个', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', 'site-builder')
    const other = makeDir('work', 'other-tool')
    const sessionId = 'f1c2-decoy'
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n照 ${other}/README.md 的写法来\n</user_query>` }] } },
      ...linesMentioning(workspace).slice(1)
    ]
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, lines)
    writeChatStore(home, workspace, sessionId)
    writeChatStore(home, other, 'f1c2-another-session')

    expect(await buildCursorSessionSummary(fp)).toMatchObject({ resumeCwd: workspace, cwdProvenance: 'reported' })
  })

  it('别的项目的 md5 虽在 chats 目录名里，但那个目录下没有本会话：不能拿它当本会话的工作区', async () => {
    const home = makeDir('home')
    const workspace = path.join(root, 'work', 'gone-app')
    const other = makeDir('work', 'other-tool')
    const sessionId = 'f1c2-foreign-hash'
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n照 ${other}/README.md 的写法来\n</user_query>` }] } },
      ...linesWithoutClues().slice(1)
    ]
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, lines)
    writeChatStore(home, workspace, sessionId)
    writeChatStore(home, other, 'f1c2-another-session')

    const legacy = legacyGuess(cursorProjectSlug(workspace))
    expect(await buildCursorSessionSummary(fp)).toMatchObject({ resumeCwd: legacy, cwdProvenance: 'estimated' })
  })

  it('reported：正文只提到别的项目时，按 slug 逐级走真实目录（可穿过纯中文目录）找候选，再用 md5 确认', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', '项目', 'data-pipeline', 'svc-a')
    const sameSlug = makeDir('work', 'data', 'pipeline-svc-a')
    const other = makeDir('work', 'other-tool')
    expect(cursorProjectSlug(sameSlug)).toBe(cursorProjectSlug(workspace))
    const sessionId = 'f1c2-walk'
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n参考 ${other}/README.md\n</user_query>` }] } },
      ...linesWithoutClues().slice(1)
    ]
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, lines)
    writeChatStore(home, workspace, sessionId)
    writeChatStore(home, other, 'f1c2-another-session')

    expect(await buildCursorSessionSummary(fp)).toMatchObject({ cwds: [workspace], resumeCwd: workspace, cwdProvenance: 'reported' })
  })

  it('reported：工作区末级是纯中文目录（slug 里被去掉）也能按 slug 走到并确认', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', 'notes-app', '草稿')
    makeDir('work', 'notes-app', 'src')
    const sessionId = 'f1c2-trailing-cjk'
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, linesWithoutClues())
    writeChatStore(home, workspace, sessionId)

    expect(await buildCursorSessionSummary(fp)).toMatchObject({ resumeCwd: workspace, cwdProvenance: 'reported' })
  })

  it('同一会话挂在两个工作区的 chats 下：优先仍存在、且与转录目录名相符的那个', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', 'main-app')
    const alsoOpened = makeDir('work', 'side-app')
    const sessionId = 'f1c2-two-workspaces'
    const lines = [...linesMentioning(alsoOpened), ...linesMentioning(workspace).slice(1)]
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, lines)
    writeChatStore(home, workspace, sessionId)
    writeChatStore(home, alsoOpened, sessionId)

    expect(await buildCursorSessionSummary(fp)).toMatchObject({ resumeCwd: workspace, cwdProvenance: 'reported' })
  })

  it('reported：chats 确认的工作区后来被删了，仍给出原路径；目录不在，恢复命令不 cd', async () => {
    const home = makeDir('home')
    const workspace = path.join(root, 'work', 'deleted-app')
    const sessionId = 'f1c2-deleted'
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, linesMentioning(workspace))
    writeChatStore(home, workspace, sessionId)

    const summary = await buildCursorSessionSummary(fp)
    expect(summary).toMatchObject({ resumeCwd: workspace, cwdProvenance: 'reported' })
    expect(fs.existsSync(workspace)).toBe(false)
    expect(buildResumeCommand(sessionId, undefined, summary!.resumeCwd, 'cursor'))
      .toBe(`cursor agent --resume ${shellQuote(sessionId)}`)
  })

  it('derived：chats 里没有本会话（别的会话有），正文线索里恰好一个真实目录与 slug 相符', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', 'no-chats-app')
    const sessionId = 'f1c2-derived'
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, linesMentioning(workspace))
    writeChatStore(home, workspace, 'f1c2-another-session')

    expect(await buildCursorSessionSummary(fp)).toMatchObject({ cwds: [workspace], resumeCwd: workspace, cwdProvenance: 'derived' })
  })

  it('候选不唯一：两个真实目录 slug 相同、正文都提到、又没有 chats 可确认 → estimated', async () => {
    const home = makeDir('home')
    const first = makeDir('work', 'twin-pkg', 'core')
    const second = makeDir('work', 'twin', 'pkg-core')
    expect(cursorProjectSlug(second)).toBe(cursorProjectSlug(first))
    const sessionId = 'f1c2-ambiguous'
    const lines = [...linesMentioning(first), ...linesMentioning(second).slice(1)]
    const fp = writeTranscript(home, cursorProjectSlug(first), sessionId, lines)

    const legacy = legacyGuess(cursorProjectSlug(first))
    expect(await buildCursorSessionSummary(fp)).toMatchObject({ cwds: [legacy], resumeCwd: legacy, cwdProvenance: 'estimated' })
  })

  it('estimated：chats 里有本会话，但所有候选的 md5 都对不上 → 候选被否定，退回旧启发式', async () => {
    const home = makeDir('home')
    const workspace = makeDir('work', 'renamed-app')
    const sessionId = 'f1c2-contradicted'
    const fp = writeTranscript(home, cursorProjectSlug(workspace), sessionId, linesMentioning(workspace))
    writeChatStore(home, '/Users/someone/old-name-app', sessionId)

    const legacy = legacyGuess(cursorProjectSlug(workspace))
    expect(await buildCursorSessionSummary(fp)).toMatchObject({ cwds: [legacy], resumeCwd: legacy, cwdProvenance: 'estimated' })
  })

  it('estimated：没有线索也没有 chats → 旧启发式原样保留，并如实标 estimated', async () => {
    const home = makeDir('home')
    const sessionId = 'f1c2-estimated'
    const fp = writeTranscript(home, 'Users-someone-code-web-app', sessionId, linesWithoutClues())

    const summary = await buildCursorSessionSummary(fp)
    expect(summary).toMatchObject({
      cwds: ['/Users/someone/code/web/app'],
      resumeCwd: '/Users/someone/code/web/app',
      cwdProvenance: 'estimated'
    })
    const raw = await loadCursorRawMessages(fp)
    expect(new Set(raw.map((message) => message.cwd))).toEqual(new Set(['/Users/someone/code/web/app']))
  })

  it('HOME 路径里本身有 projects 段：slug 取 .cursor/projects 下那一级，chats 也从转录路径推出', async () => {
    const home = makeDir('projects', 'someone')
    const workspace = makeDir('work', 'home-in-projects')
    const confirmedId = 'f1c2-projects-home'
    const confirmed = writeTranscript(home, cursorProjectSlug(workspace), confirmedId, linesMentioning(workspace))
    writeChatStore(home, workspace, confirmedId)
    expect(await buildCursorSessionSummary(confirmed)).toMatchObject({ resumeCwd: workspace, cwdProvenance: 'reported' })

    // 旧实现取第一个 projects 段，会把 slug 读成 someone，推出 /someone
    const guessedId = 'f1c2-projects-home-guess'
    const guessed = writeTranscript(home, 'Users-someone-code-web-app', guessedId, linesWithoutClues())
    expect(await buildCursorSessionSummary(guessed)).toMatchObject({
      resumeCwd: '/Users/someone/code/web/app',
      cwdProvenance: 'estimated'
    })
  })

  it('Library 备份（路径里没有 .cursor/projects/…/agent-transcripts 结构）不猜工作目录', async () => {
    const workspace = makeDir('work', 'backup-app')
    const backup = path.join(root, 'projects', 'Library', 'backup.jsonl')
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.writeFileSync(backup, linesMentioning(workspace).map((line) => JSON.stringify(line)).join('\n'))

    const summary = await buildCursorSessionSummaryFromBackup(backup, 'f1c2-backup')
    expect(summary!.cwds).toEqual([])
    expect(summary!.resumeCwd).toBeUndefined()
    expect(summary!.cwdProvenance).toBeUndefined()
  })
})
