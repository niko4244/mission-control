import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  PROTECTED_BRANCHES,
  DIVERGENCE_WARN_THRESHOLD,
  checkBranchHygiene,
  buildOutput,
  buildStatusOutput,
  isProtectedBranch,
  isBadlyNamedBranch,
  matchesBranchConvention,
  main,
} = require('../../../scripts/branch-hygiene-checker.cjs')

type CommandResult = { ok: boolean; status: number; stdout: string; stderr: string; error: string }

function makeCommandRunner(overrides: Record<string, CommandResult> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) return overrides[key]

    if (key === 'git branch --show-current') {
      return { ok: true, status: 0, stdout: 'feature-add-thing-v1\n', stderr: '', error: '' }
    }
    if (key === 'git status --short') {
      return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    }
    if (key === 'git log --oneline main...HEAD') {
      return { ok: true, status: 0, stdout: 'abc1234 Add feature\n', stderr: '', error: '' }
    }
    return { ok: false, status: 1, stdout: '', stderr: `Unhandled: ${key}`, error: '' }
  }
}

describe('branch-hygiene-checker', () => {
  it('exports AGENT and LABEL constants', () => {
    expect(AGENT).toBe('Branch Hygiene Checker v1')
    expect(LABEL).toBe('OBSERVE ONLY / BRANCH GATE')
  })

  it('status mode returns self-report without running checks', () => {
    const result = buildStatusOutput('/fake/root')
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
    expect(result.observe_only).toBe(true)
    expect(Array.isArray(result.protected_branches)).toBe(true)
    expect(result.divergence_warn_threshold).toBe(DIVERGENCE_WARN_THRESHOLD)
  })

  it('main with no args returns status mode', () => {
    const result = main([], { rootDir: '/fake/root' })
    expect(result.mode).toBe('status')
    expect(result.agent).toBe(AGENT)
  })

  it('not-on-protected-branch FAIL when on main', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'main\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'not-on-protected-branch')
    expect(check.status).toBe('FAIL')
    expect(result.overall_status).toBe('FAIL')
  })

  it('not-on-protected-branch FAIL when on master', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'master\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'not-on-protected-branch')
    expect(check.status).toBe('FAIL')
  })

  it('not-on-protected-branch FAIL when on develop', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'develop\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'not-on-protected-branch')
    expect(check.status).toBe('FAIL')
  })

  it('not-on-protected-branch FAIL when on release/ branch', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'release/1.0\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'not-on-protected-branch')
    expect(check.status).toBe('FAIL')
  })

  it('not-on-protected-branch PASS on a feature branch', () => {
    const result = checkBranchHygiene('/fake/root', makeCommandRunner())
    const check = result.checks.find((c: any) => c.name === 'not-on-protected-branch')
    expect(check.status).toBe('PASS')
  })

  it('working-tree-clean WARN (not FAIL) when tree is dirty', () => {
    const runner = makeCommandRunner({
      'git status --short': { ok: true, status: 0, stdout: ' M src/foo.ts\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'working-tree-clean')
    expect(check.status).toBe('WARN')
    // Dirty tree alone does not FAIL the overall result
    expect(result.overall_status).not.toBe('FAIL')
  })

  it('branch-name-convention WARN for numeric-only branch name', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: '12345\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'branch-name-convention')
    expect(check.status).toBe('WARN')
  })

  it('branch-name-convention WARN for single-word branch name', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'mybranch\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'branch-name-convention')
    expect(check.status).toBe('WARN')
  })

  it('branch-name-convention PASS for <type>-<description>-v<N> pattern', () => {
    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'feature-add-thing-v1\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'branch-name-convention')
    expect(check.status).toBe('PASS')
  })

  it('no-untracked-intended-files WARN when untracked .ts files exist', () => {
    const runner = makeCommandRunner({
      'git status --short': {
        ok: true, status: 0,
        stdout: '?? src/lib/new-file.ts\n',
        stderr: '', error: '',
      },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'no-untracked-intended-files')
    expect(check.status).toBe('WARN')
    expect(result.untracked_intended).toContain('src/lib/new-file.ts')
  })

  it('no-untracked-intended-files WARN when untracked .cjs files exist', () => {
    const runner = makeCommandRunner({
      'git status --short': {
        ok: true, status: 0,
        stdout: '?? scripts/my-bot.cjs\n',
        stderr: '', error: '',
      },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'no-untracked-intended-files')
    expect(check.status).toBe('WARN')
  })

  it('no-untracked-intended-files PASS when no untracked .ts/.cjs files', () => {
    const result = checkBranchHygiene('/fake/root', makeCommandRunner())
    const check = result.checks.find((c: any) => c.name === 'no-untracked-intended-files')
    expect(check.status).toBe('PASS')
  })

  it('branch-divergence WARN when more than DIVERGENCE_WARN_THRESHOLD commits ahead', () => {
    const manyCommits = Array.from({ length: 16 }, (_, i) => `abc${i} Commit ${i}`).join('\n')
    const runner = makeCommandRunner({
      'git log --oneline main...HEAD': { ok: true, status: 0, stdout: manyCommits + '\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'branch-divergence')
    expect(check.status).toBe('WARN')
    expect(result.ahead_count).toBeGreaterThan(DIVERGENCE_WARN_THRESHOLD)
  })

  it('branch-divergence PASS when within threshold', () => {
    const result = checkBranchHygiene('/fake/root', makeCommandRunner())
    const check = result.checks.find((c: any) => c.name === 'branch-divergence')
    expect(check.status).toBe('PASS')
  })

  it('isProtectedBranch returns true for all protected branch names', () => {
    for (const b of PROTECTED_BRANCHES) {
      expect(isProtectedBranch(b)).toBe(true)
    }
    expect(isProtectedBranch('release/1.2.3')).toBe(true)
  })

  it('isProtectedBranch returns false for feature branches', () => {
    expect(isProtectedBranch('feature-foo-v1')).toBe(false)
    expect(isProtectedBranch('fix/my-bug')).toBe(false)
  })

  it('isBadlyNamedBranch detects numeric-only and single-word branches', () => {
    expect(isBadlyNamedBranch('12345').bad).toBe(true)
    expect(isBadlyNamedBranch('mybranch').bad).toBe(true)
    expect(isBadlyNamedBranch('feature-x-v1').bad).toBe(false)
  })

  it('matchesBranchConvention validates correct patterns', () => {
    expect(matchesBranchConvention('feature-add-thing-v1')).toBe(true)
    expect(matchesBranchConvention('fix/my-bug')).toBe(true)
    expect(matchesBranchConvention('mybranch')).toBe(false)
    expect(matchesBranchConvention('12345')).toBe(false)
  })

  it('buildOutput includes all required fields', () => {
    const result = buildOutput('/fake/root', makeCommandRunner(), new Date('2026-05-10T00:00:00Z'))
    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(result.observe_only).toBe(true)
    expect(result.mode).toBe('check')
    expect(Array.isArray(result.checks)).toBe(true)
    expect(typeof result.summary).toBe('string')
    expect(typeof result.branch).toBe('string')
    expect(typeof result.working_tree_clean).toBe('boolean')
    expect(typeof result.ahead_count).toBe('number')
  })

  it('check mode returns all five check names', () => {
    const result = checkBranchHygiene('/fake/root', makeCommandRunner())
    const names = result.checks.map((c: any) => c.name)
    expect(names).toContain('not-on-protected-branch')
    expect(names).toContain('working-tree-clean')
    expect(names).toContain('branch-name-convention')
    expect(names).toContain('no-untracked-intended-files')
    expect(names).toContain('branch-divergence')
  })

  it('branch-divergence falls back to origin/main...HEAD', () => {
    const manyCommits = Array.from({ length: 3 }, (_, i) => `abc${i} Commit`).join('\n')
    const runner = makeCommandRunner({
      'git log --oneline main...HEAD': { ok: false, status: 128, stdout: '', stderr: 'unknown revision', error: '' },
      'git log --oneline origin/main...HEAD': { ok: true, status: 0, stdout: manyCommits + '\n', stderr: '', error: '' },
    })
    const result = checkBranchHygiene('/fake/root', runner)
    const check = result.checks.find((c: any) => c.name === 'branch-divergence')
    expect(check.status).toBe('PASS')
    expect(result.ahead_count).toBe(3)
  })

  it('cli output is valid JSON with agent and status', () => {
    const execution = spawnSync(process.execPath, ['scripts/branch-hygiene-checker.cjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(typeof parsed.status).toBe('string')
    expect(parsed.observe_only).toBe(true)
  })

  it('overall_status is PASS on a clean feature branch with no issues', () => {
    const result = checkBranchHygiene('/fake/root', makeCommandRunner())
    expect(result.overall_status).toBe('PASS')
    expect(result.fail_count).toBe(0)
  })
})
