import { describe, test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import curator from '../../../scripts/systems-curator.cjs'

type AuditReport = {
  status: 'OK' | 'WARN' | 'FAIL'
  risk_level: number
  label: string
  repo: {
    branch: string
    is_clean: boolean
    status_entries: string[]
    untracked_files: string[]
    latest_commits: string[]
  }
  mission_control: {
    docs_present: string[]
    docs_missing: string[]
  }
  warnings: string[]
}

type ExecFileSyncLike = (command: string, args: string[], options: { cwd: string; encoding: string }) => string

const repoRoot = path.resolve(__dirname, '../../..')
const scriptPath = path.resolve(repoRoot, 'scripts/systems-curator.cjs')
const typedCurator = curator as {
  EXPECTED_DOCS: string[]
  runAudit: (options?: { rootDir?: string; execFileSync?: ExecFileSyncLike }) => AuditReport
}

describe('systems-curator', () => {
  test('CLI returns valid JSON with observe-only metadata', () => {
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')

    const parsed = JSON.parse(result.stdout) as AuditReport
    expect(['OK', 'WARN', 'FAIL']).toContain(parsed.status)
    expect(parsed.risk_level).toBe(0)
    expect(parsed.label).toBe('OBSERVE ONLY')
    expect(Array.isArray(parsed.repo.latest_commits)).toBe(true)
  })

  test('required docs list is checked against the repo', () => {
    const report = typedCurator.runAudit({ rootDir: repoRoot })

    expect(report.mission_control.docs_missing).toEqual([])
    expect(report.mission_control.docs_present).toEqual(
      expect.arrayContaining(typedCurator.EXPECTED_DOCS),
    )
  })

  test('dirty repo detection is represented without changing the real repo', () => {
    const mockExec: ExecFileSyncLike = (_command, args) => {
      if (args.includes('status')) {
        return '?? scratch.txt\n M src/lib/example.ts\n'
      }

      if (args.includes('branch')) {
        return 'systems-curator-v1\n'
      }

      if (args.includes('log')) {
        return 'abc1234 Example commit\n'
      }

      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    }

    const report = typedCurator.runAudit({
      rootDir: repoRoot,
      execFileSync: mockExec,
    })

    expect(report.status).toBe('WARN')
    expect(report.repo.is_clean).toBe(false)
    expect(report.repo.untracked_files).toEqual(['scratch.txt'])
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Working tree is not clean'),
        expect.stringContaining('Known untracked files detected: scratch.txt.'),
      ]),
    )
  })
})
