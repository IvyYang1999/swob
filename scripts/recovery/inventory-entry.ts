import * as fs from 'node:fs'
import {
  buildDuplicateRecoveryReport,
  renderDuplicateRecoveryMarkdown,
  verifyDuplicateRecoveryPlan,
  type DuplicateRecoveryReport
} from '../../src/main/duplicate-recovery-planner'

interface Arguments {
  library?: string
  quarantineRoot?: string
  format: 'json' | 'markdown'
  hashSources: boolean
  verifyPlan?: string
  help: boolean
}

const HELP = `Usage:
  node scripts/recovery/inventory.mjs --library <path> [--dry-run]
      [--quarantine-root <outside-path>] [--hash-sources]
      [--format json|markdown]

  node scripts/recovery/inventory.mjs --library <path>
      --verify-plan <previous-report.json> [--quarantine-root <outside-path>]

Safety contract:
  - --library is mandatory; there is no implicit real Library.
  - dry-run is the only mode. There is no apply/move/delete command.
  - reports go to stdout; redirect them to an external, protected path if needed.
  - --hash-sources is opt-in and reads only source paths declared by manifests.
`

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { format: 'json', hashSources: false, help: false }
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`missing-value:${flag}`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--dry-run') continue
    else if (arg === '--hash-sources') result.hashSources = true
    else if (arg === '--library') result.library = valueAfter(index++, arg)
    else if (arg === '--quarantine-root') result.quarantineRoot = valueAfter(index++, arg)
    else if (arg === '--verify-plan') result.verifyPlan = valueAfter(index++, arg)
    else if (arg === '--format') {
      const format = valueAfter(index++, arg)
      if (format !== 'json' && format !== 'markdown') throw new Error('format-must-be-json-or-markdown')
      result.format = format
    } else if (arg === '--apply' || arg === 'apply') {
      throw new Error('read-only-tool-has-no-apply-mode')
    } else {
      throw new Error(`unknown-argument:${arg}`)
    }
  }
  return result
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (!args.library) throw new Error('explicit-library-root-required')
  if (args.verifyPlan) {
    const previous = JSON.parse(fs.readFileSync(args.verifyPlan, 'utf-8')) as Partial<DuplicateRecoveryReport>
    if (previous.schemaVersion !== 1 ||
      typeof previous.snapshotFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(previous.snapshotFingerprint) ||
      !['enabled', 'disabled'].includes(String(previous.sourceHashing))) {
      throw new Error('invalid-previous-plan')
    }
    const status = await verifyDuplicateRecoveryPlan(args.library, previous, {
      quarantineRoot: args.quarantineRoot
    })
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return
  }
  const report = await buildDuplicateRecoveryReport(args.library, {
    quarantineRoot: args.quarantineRoot,
    hashSources: args.hashSources
  })
  process.stdout.write(args.format === 'markdown'
    ? renderDuplicateRecoveryMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
