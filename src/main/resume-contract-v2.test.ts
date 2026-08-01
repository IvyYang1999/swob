import { describe, expect, it } from 'vitest'
import type { ResumeContract } from '../shared/provider-schema-v2.generated'
import { verifyResumeContractV2 } from './resume-contract-v2'

const contract: ResumeContract = {
  mode: 'native-cli',
  supportedSurfaces: ['terminal'],
  supportsSubagent: false,
  idTransform: null,
  preflight: ['binary', 'version', 'help-capability', 'source-exists'],
  commandTemplate: 'claude --resume {sessionId}',
  expectedSideEffects: ['append-source'],
  postcondition: 'anchor-match'
}

describe('ResumeContract v2', () => {
  it('命令启动成功但源文件不对或尾锚点不匹配时仍判失败', () => {
    expect(verifyResumeContractV2(contract, {
      launched: true,
      expectedSourceRefId: 'source:one',
      observedSourceRefId: 'source:two',
      sourceExists: true,
      expectedAnchors: { user: 'latest user', assistant: 'latest assistant' },
      observedDefaultMessages: [
        { role: 'user', text: 'stale user' },
        { role: 'assistant', text: 'stale assistant' }
      ],
      observedAllMessages: []
    })).toMatchObject({ ok: false, status: 'source-mismatch' })

    expect(verifyResumeContractV2(contract, {
      launched: true,
      expectedSourceRefId: 'source:one',
      observedSourceRefId: 'source:one',
      sourceExists: true,
      expectedAnchors: { user: 'latest user', assistant: 'latest assistant' },
      observedDefaultMessages: [
        { role: 'user', text: 'stale user' },
        { role: 'assistant', text: 'stale assistant' }
      ],
      observedAllMessages: []
    })).toMatchObject({ ok: false, status: 'anchor-mismatch', l3: { mismatchKind: 'stale' } })
  })

  it('同时验证 source id 与既有 L3 尾锚点，不削弱 anchor/hash 审计', () => {
    expect(verifyResumeContractV2(contract, {
      launched: true,
      expectedSourceRefId: 'source:one',
      observedSourceRefId: 'source:one',
      sourceExists: true,
      expectedAnchors: { user: 'latest user', assistant: 'latest assistant' },
      observedDefaultMessages: [
        { role: 'user', text: 'latest user' },
        { role: 'assistant', text: 'latest assistant' }
      ],
      observedAllMessages: [],
      integrity: { sourceHash: 'a'.repeat(64), targetHash: 'a'.repeat(64), matches: true }
    })).toMatchObject({ ok: true, status: 'verified', l3: { status: 'match' } })
  })
})
