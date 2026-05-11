import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  REQUIRES_HUMAN_FOR,
  BLOCKED_ACTIONS,
  buildRecommendedCommands,
  runStatusMode,
  runPrepareMode,
  runVerifyMode,
  validatePrepareInputs,
} = require('../../../scripts/release-manager.cjs')

function makeCommandRunner(overrides: Record<string, any> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) {
      return overrides[key]
    }

    if (key === 'git branch --show-current') {
      return { ok: true, status: 0, stdout: 'release-manager-v1\n', stderr: '', error: '' }
    }
    if (key === 'git status --short') {
      return { ok: true, status: 0, stdout: ' M src/lib/utils.ts\n', stderr: '', error: '' }
    }
    if (key === 'git diff --stat') {
      return { ok: true, status: 0, stdout: '1 file changed, 10 insertions(+)', stderr: '', error: '' }
    }
    if (key === 'git --no-pager log --oneline -5') {
      return { ok: true, status: 0, stdout: 'abc1234 Test commit\n', stderr: '', error: '' }
    }

    return { ok: false, status: 1, stdout: '', stderr: `Unhandled command: ${key}`, error: '' }
  }
}

function makeCleanCommandRunner() {
  return makeCommandRunner({
    'git status --short': { ok: true, status: 0, stdout: '', stderr: '', error: '' },
  })
}

describe('release manager', () => {
  it('status mode returns correct agent and label', () => {
    const result = runStatusMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(result.mode).toBe('status')
    expect(typeof result.status).toBe('string')
  })

  it('status mode always includes requires_human_for with push, create_pr, merge', () => {
    const result = runStatusMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    expect(result.requires_human_for).toEqual(expect.arrayContaining(['push', 'create_pr', 'merge']))
  })

  it('status mode reports governor availability', () => {
    const result = runStatusMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    expect(typeof result.governor_available).toBe('boolean')
    // In the actual repo the governor script exists
    expect(result.governor_available).toBe(true)
  })

  it('prepare mode generates recommended_commands with git add and commit', () => {
    const result = runPrepareMode(
      ROOT,
      'release-manager-v1',
      'feat: add release manager v1',
      { commandRunner: makeCommandRunner() },
    )

    expect(result.mode).toBe('prepare')
    expect(Array.isArray(result.recommended_commands)).toBe(true)
    expect(result.recommended_commands.length).toBeGreaterThan(0)

    const hasAddCommand = result.recommended_commands.some(
      (cmd: string) => cmd.startsWith('git add'),
    )
    const hasCommitCommand = result.recommended_commands.some(
      (cmd: string) => cmd.startsWith('git commit'),
    )
    expect(hasAddCommand).toBe(true)
    expect(hasCommitCommand).toBe(true)
  })

  it('prepare mode includes commit message in git commit command', () => {
    const msg = 'feat: add release manager v1'
    const result = runPrepareMode(ROOT, 'release-manager-v1', msg, {
      commandRunner: makeCommandRunner(),
    })

    const commitCmd = result.recommended_commands.find((cmd: string) =>
      cmd.startsWith('git commit'),
    )
    expect(commitCmd).toContain(msg)
  })

  it('prepare mode with branch=main returns FAIL', () => {
    const result = runPrepareMode(
      ROOT,
      'main',
      'feat: some change',
      { commandRunner: makeCommandRunner() },
    )

    expect(result.status).toBe('FAIL')
    expect(result.blockers.join(' ')).toMatch(/main/)
  })

  it('prepare mode with branch=master returns FAIL', () => {
    const result = runPrepareMode(
      ROOT,
      'master',
      'feat: some change',
      { commandRunner: makeCommandRunner() },
    )

    expect(result.status).toBe('FAIL')
    expect(result.blockers.join(' ')).toMatch(/master/)
  })

  it('prepare mode with missing branch returns FAIL', () => {
    const result = runPrepareMode(ROOT, '', 'feat: some change', {
      commandRunner: makeCommandRunner(),
    })

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('prepare mode with missing commit message returns FAIL', () => {
    const result = runPrepareMode(ROOT, 'my-branch', '', {
      commandRunner: makeCommandRunner(),
    })

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('prepare mode always includes requires_human_for', () => {
    const result = runPrepareMode(
      ROOT,
      'release-manager-v1',
      'feat: add release manager v1',
      { commandRunner: makeCommandRunner() },
    )

    expect(result.requires_human_for).toEqual(
      expect.arrayContaining(['push', 'create_pr', 'merge']),
    )
  })

  it('prepare mode includes validation_steps', () => {
    const result = runPrepareMode(
      ROOT,
      'release-manager-v1',
      'feat: add release manager v1',
      { commandRunner: makeCommandRunner() },
    )

    expect(Array.isArray(result.validation_steps)).toBe(true)
    expect(result.validation_steps.length).toBeGreaterThan(0)
  })

  it('prepare mode includes rollback_notes', () => {
    const result = runPrepareMode(
      ROOT,
      'release-manager-v1',
      'feat: add release manager v1',
      { commandRunner: makeCommandRunner() },
    )

    expect(Array.isArray(result.rollback_notes)).toBe(true)
    expect(result.rollback_notes.length).toBeGreaterThan(0)
  })

  it('verify mode returns git state fields', () => {
    const result = runVerifyMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    expect(result.mode).toBe('verify')
    expect(typeof result.working_tree_clean).toBe('boolean')
    expect(typeof result.branch).toBe('string')
    expect(Array.isArray(result.recent_commits)).toBe(true)
  })

  it('verify mode returns release_ready field', () => {
    const result = runVerifyMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    expect(typeof result.release_ready).toBe('boolean')
    // Clean tree should be release-ready
    expect(result.release_ready).toBe(true)
  })

  it('verify mode with dirty tree is not release ready', () => {
    const result = runVerifyMode(ROOT, {
      commandRunner: makeCommandRunner({
        'git status --short': {
          ok: true, status: 0, stdout: ' M src/app/page.tsx\n', stderr: '', error: '',
        },
      }),
    })

    expect(result.working_tree_clean).toBe(false)
    expect(result.release_ready).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('push, create_pr, merge are always in requires_human_for in all modes', () => {
    const statusResult = runStatusMode(ROOT, { commandRunner: makeCleanCommandRunner() })
    const prepareResult = runPrepareMode(ROOT, 'my-branch', 'feat: foo', {
      commandRunner: makeCommandRunner(),
    })
    const verifyResult = runVerifyMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    for (const result of [statusResult, prepareResult, verifyResult]) {
      expect(result.requires_human_for).toEqual(
        expect.arrayContaining(['push', 'create_pr', 'merge']),
      )
    }
  })

  it('REQUIRES_HUMAN_FOR constant always contains push, create_pr, merge', () => {
    expect(REQUIRES_HUMAN_FOR).toEqual(expect.arrayContaining(['push', 'create_pr', 'merge']))
  })

  it('BLOCKED_ACTIONS includes push and merge variants', () => {
    expect(BLOCKED_ACTIONS).toEqual(
      expect.arrayContaining(['push', 'merge', 'create_pr']),
    )
  })

  it('output shape includes required fields', () => {
    const result = runStatusMode(ROOT, { commandRunner: makeCleanCommandRunner() })

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(typeof result.mode).toBe('string')
    expect(typeof result.status).toBe('string')
    expect(Array.isArray(result.requires_human_for)).toBe(true)
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(Array.isArray(result.blockers)).toBe(true)
    expect(typeof result.metadata).toBe('object')
    expect(typeof result.summary).toBe('string')
  })

  it('validatePrepareInputs rejects main branch', () => {
    const errors = validatePrepareInputs('main', 'some message')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toMatch(/main/)
  })

  it('validatePrepareInputs accepts valid branch and message', () => {
    const errors = validatePrepareInputs('release-manager-v1', 'feat: add release manager')
    expect(errors).toEqual([])
  })

  it('buildRecommendedCommands includes git add and git commit', () => {
    const commands = buildRecommendedCommands('my-branch', 'feat: something', null)
    const hasAdd = commands.some((cmd: string) => cmd.startsWith('git add'))
    const hasCommit = commands.some((cmd: string) => cmd.startsWith('git commit'))
    expect(hasAdd).toBe(true)
    expect(hasCommit).toBe(true)
  })

  it('CLI returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/release-manager.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(Array.isArray(parsed.requires_human_for)).toBe(true)
    expect(parsed.requires_human_for).toEqual(
      expect.arrayContaining(['push', 'create_pr', 'merge']),
    )
  })

  it('CLI prepare mode with main branch exits 0 but returns FAIL status', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/release-manager.cjs', 'prepare', '--branch', 'main', '--commit-message', 'test'],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.status).toBe('FAIL')
    expect(parsed.requires_human_for).toEqual(
      expect.arrayContaining(['push', 'create_pr', 'merge']),
    )
  })

  it('CLI verify mode returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/release-manager.cjs', 'verify'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('verify')
    expect(typeof parsed.working_tree_clean).toBe('boolean')
    expect(parsed.requires_human_for).toEqual(
      expect.arrayContaining(['push', 'create_pr', 'merge']),
    )
  })
})
