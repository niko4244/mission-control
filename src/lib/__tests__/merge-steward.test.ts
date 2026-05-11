import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  buildStatusMode,
  buildChecklistMode,
  main,
} = require('../../../scripts/merge-steward.cjs')

function makeCommandRunner(overrides: Record<string, any> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) return overrides[key]
    if (key === 'git status --short') return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    if (key === 'git log --oneline main...HEAD') return { ok: true, status: 0, stdout: 'abc123 test\n', stderr: '', error: '' }
    if (key === 'git diff --name-only --diff-filter=U') return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    if (key === 'gh --version') return { ok: false, status: 1, stdout: '', stderr: '', error: '' }
    return { ok: false, status: 1, stdout: '', stderr: `unhandled: ${key}`, error: '' }
  }
}

describe('merge steward', () => {
  it('exports AGENT correctly', () => {
    expect(AGENT).toBe('Merge Steward v1')
  })

  it('buildStatusMode returns correct shape', () => {
    const result = buildStatusMode(ROOT)
    expect(result.agent).toBe(AGENT)
    expect(result.mode).toBe('status')
    expect(result.observe_only).toBe(true)
    expect(result.merge_authorized).toBe(false)
  })

  it('buildChecklistMode returns checklist array and merge_ready field', () => {
    const result = buildChecklistMode(ROOT, { commandRunner: makeCommandRunner() })
    expect(Array.isArray(result.metadata.checklist)).toBe(true)
    expect(typeof result.metadata.merge_ready).toBe('boolean')
  })

  it('merge_authorized is always false in all outputs', () => {
    const status = buildStatusMode(ROOT)
    const checklist = buildChecklistMode(ROOT, { commandRunner: makeCommandRunner() })
    expect(status.merge_authorized).toBe(false)
    expect(checklist.merge_authorized).toBe(false)
    expect(checklist.metadata.merge_authorized).toBe(false)
  })

  it('CLI status returns valid JSON with correct agent and mode', () => {
    const execution = spawnSync(process.execPath, ['scripts/merge-steward.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
  })
})
