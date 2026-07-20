import type { BackupFragmentShape, BackupValidationOptions } from '../backup-validator'

export const SYNTHETIC_LOGICAL_ID = '71000000-0000-4000-8000-000000000001'
export const SYNTHETIC_PHYSICAL_ID = '72000000-0000-4000-8000-000000000002'
export const SYNTHETIC_CONFLICT_ID = '73000000-0000-4000-8000-000000000003'

function message(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  content: string,
  type: 'user' | 'assistant' = 'assistant'
): string {
  return JSON.stringify({
    sessionId,
    uuid,
    parentUuid,
    isSidechain: false,
    type,
    timestamp: '2026-07-19T00:00:00.000Z',
    message: { role: type, content }
  })
}

const validHead = message(SYNTHETIC_LOGICAL_ID, 'fixture-head', null, 'synthetic head', 'user')
const validMiddle = message(SYNTHETIC_LOGICAL_ID, 'fixture-middle', 'fixture-head', 'synthetic middle')
const validTail = message(SYNTHETIC_LOGICAL_ID, 'fixture-tail', 'fixture-middle', 'synthetic tail')

export interface SyntheticDamageFixture {
  content: string
  expectedOk: boolean
  expectedShape?: BackupFragmentShape
  expectedParseableLines: number
}

/** Six redacted shapes corresponding one-for-one to the six inspected backups. */
export const SIX_REPORTED_BACKUP_SHAPES = {
  orphanTail: {
    content: [validHead, '"content":"orphan synthetic tail"}', validTail].join('\n') + '\n',
    expectedOk: false,
    expectedShape: 'orphan-tail',
    expectedParseableLines: 2
  },
  interleavedAssistantFragments: {
    content: [
      validHead,
      '"type":"assistant","message":{"content":"part-a"',
      '"type":"assistant","message":{"content":"part-b\\n"',
      '"type":"assistant","message":{"content":"part-c"}}',
      validTail
    ].join('\n') + '\n',
    expectedOk: false,
    expectedShape: 'interleaved-fragments',
    expectedParseableLines: 2
  },
  missingPrefix: {
    content: [validHead, '    "message":{"content":"tail only"}}', validTail].join('\n') + '\n',
    expectedOk: false,
    expectedShape: 'missing-prefix',
    expectedParseableLines: 2
  },
  separatedFragments: {
    content: [
      validHead,
      '"message":{"content":"first tail"}}',
      validMiddle,
      '"message":{"content":"second tail"}}',
      validTail
    ].join('\n') + '\n',
    expectedOk: false,
    expectedShape: 'separated-fragments',
    expectedParseableLines: 3
  },
  currentlyStrictValidShort: {
    content: [validHead, validTail].join('\n') + '\n',
    expectedOk: true,
    expectedParseableLines: 2
  },
  currentlyStrictValidLong: {
    content: [validHead, validMiddle, validTail].join('\n') + '\n',
    expectedOk: true,
    expectedParseableLines: 3
  }
} satisfies Record<string, SyntheticDamageFixture>

export const SINGLE_ID_OPTIONS: BackupValidationOptions = {
  expectedLogicalSessionId: SYNTHETIC_LOGICAL_ID,
  expectedPhysicalSessionId: SYNTHETIC_LOGICAL_ID
}

export const LEGAL_DOUBLE_ID_JSONL = [
  message(SYNTHETIC_LOGICAL_ID, 'logical-user', null, 'logical synthetic anchor', 'user'),
  message(SYNTHETIC_PHYSICAL_ID, 'physical-assistant', 'logical-user', 'physical synthetic anchor')
].join('\n') + '\n'

export const DOUBLE_ID_OPTIONS: BackupValidationOptions = {
  expectedLogicalSessionId: SYNTHETIC_LOGICAL_ID,
  expectedPhysicalSessionId: SYNTHETIC_PHYSICAL_ID
}

export const UNRELATED_DOUBLE_ID_JSONL = [
  message(SYNTHETIC_LOGICAL_ID, 'unrelated-logical', null, 'unrelated logical', 'user'),
  message(SYNTHETIC_PHYSICAL_ID, 'unrelated-physical', null, 'unrelated physical')
].join('\n') + '\n'

export const THIRD_CONFLICTING_ID_JSONL = [
  message(SYNTHETIC_LOGICAL_ID, 'conflict-logical', null, 'conflict logical', 'user'),
  message(SYNTHETIC_PHYSICAL_ID, 'conflict-physical', 'conflict-logical', 'conflict physical'),
  message(SYNTHETIC_CONFLICT_ID, 'conflict-third', 'conflict-physical', 'conflict third')
].join('\n') + '\n'

export const REPAIRABLE_RAW_LF_JSONL =
  message(SYNTHETIC_LOGICAL_ID, 'repair-user', null, 'repair user', 'user') + '\n' +
  '{"sessionId":"71000000-0000-4000-8000-000000000001","uuid":"repair-assistant",' +
  '"parentUuid":"repair-user","isSidechain":false,"type":"assistant",' +
  '"timestamp":"2026-07-19T00:00:01.000Z","message":{"role":"assistant",' +
  '"content":"synthetic first line\nsynthetic second line"}}\n'
