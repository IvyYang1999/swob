import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildCursorSessionSummary, buildCursorSessionDetail, buildCursorSessionSummaryFromBackup, findCursorSessionFiles } from './cursor-loader'

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
  })
})
