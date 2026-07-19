import type { RecoveryPlannerInput } from '../resume-recovery-planner'

export interface SyntheticRecoveryFixture extends RecoveryPlannerInput {
  evidence: {
    jsonl: string
    placeholderName?: string
  }
}

const standardTarget = {
  id: 'standard-xx…0001',
  kind: 'standard' as const,
  projectsRoot: '/fixture/home-xx…0001/.claude/projects',
  configDir: '/fixture/home-xx…0001/.claude',
  available: true,
  trusted: true,
  existingFiles: []
}

function meta(
  sessionId: string,
  sourcePath: string
): RecoveryPlannerInput['libraryMeta'] {
  return {
    schemaVersion: 2,
    sessionId,
    sourceFilePaths: [sourcePath],
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:01:00.000Z',
    projectPath: '/fixture/project-xx…0001',
    origin: {
      deviceId: 'device-xx…0001',
      hostname: 'host-xx…0001',
      username: 'user-xx…0001',
      capturedAt: '2026-07-19T00:00:00.000Z'
    },
    sourceInstance: { kind: 'claude-default' }
  }
}

/**
 * Synthetic, visibly redacted representatives of the 253-session shapes.
 * They contain no copied transcript text, host identity, credential, or real path.
 */
export const RECOVERY_SYNTHETIC_FIXTURES = {
  normal: {
    sessionId: '10000000-0000-4000-8000-000000000001',
    libraryMeta: meta(
      '10000000-0000-4000-8000-000000000001',
      '/fixture/home-xx…0001/.claude/projects/-fixture-project-xx…0001/10000000-0000-4000-8000-000000000001.jsonl'
    ),
    backup: {
      path: '/fixture/library-xx…0001/session-xx…0001/backup.jsonl',
      state: 'ready' as const
    },
    targetInstances: [standardTarget],
    localDeviceId: 'device-xx…0001',
    evidence: {
      jsonl: '{"sessionId":"10000000-0000-4000-8000-000000000001","type":"user","message":{"content":"normal-xx…0001"}}\n'
    }
  },
  logicalPhysicalDoubleId: {
    sessionId: '20000000-0000-4000-8000-000000000002',
    libraryMeta: meta(
      '20000000-0000-4000-8000-000000000002',
      '/fixture/home-xx…0001/.claude/projects/-fixture-project-xx…0002/30000000-0000-4000-8000-000000000003.jsonl'
    ),
    backup: {
      path: '/fixture/library-xx…0002/session-xx…0002/backup.jsonl',
      state: 'ready' as const,
      physicalSessionId: '30000000-0000-4000-8000-000000000003'
    },
    targetInstances: [standardTarget],
    localDeviceId: 'device-xx…0001',
    evidence: {
      jsonl: [
        '{"sessionId":"20000000-0000-4000-8000-000000000002","type":"user","message":{"content":"logical-xx…0002"}}',
        '{"sessionId":"30000000-0000-4000-8000-000000000003","type":"assistant","message":{"content":"physical-xx…0003"}}'
      ].join('\n') + '\n'
    }
  },
  malformedLine: {
    sessionId: '40000000-0000-4000-8000-000000000004',
    libraryMeta: meta(
      '40000000-0000-4000-8000-000000000004',
      '/fixture/home-xx…0001/.claude/projects/-fixture-project-xx…0004/40000000-0000-4000-8000-000000000004.jsonl'
    ),
    backup: {
      path: '/fixture/library-xx…0004/session-xx…0004/backup.jsonl',
      state: 'invalid' as const,
      diagnostic: 'malformed-line-xx…0004'
    },
    targetInstances: [standardTarget],
    localDeviceId: 'device-xx…0001',
    evidence: {
      jsonl: '{"sessionId":"40000000-0000-4000-8000-000000000004","message":{"content":"broken-xx…0004"}\n'
    }
  },
  icloudPlaceholder: {
    sessionId: '50000000-0000-4000-8000-000000000005',
    libraryMeta: meta(
      '50000000-0000-4000-8000-000000000005',
      '/fixture/home-xx…0001/.claude/projects/-fixture-project-xx…0005/50000000-0000-4000-8000-000000000005.jsonl'
    ),
    backup: {
      path: '/fixture/library-xx…0005/session-xx…0005/backup.jsonl',
      state: 'icloud-placeholder' as const
    },
    targetInstances: [standardTarget],
    localDeviceId: 'device-xx…0001',
    evidence: {
      jsonl: '',
      placeholderName: '.backup.jsonl.icloud-xx…0005'
    }
  }
} satisfies Record<string, SyntheticRecoveryFixture>
