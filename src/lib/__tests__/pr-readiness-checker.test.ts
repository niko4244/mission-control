import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  PROTECTED_BRANCHES,
  DIFF_WARN_THRESHOLD,
  DIFF_FAIL_THRESHOLD,
  checkPRReadiness,
  buildOutput,
  buildStatusOutput,
  main,
} = require('../../../scripts/pr-readiness-checker.cjs')

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-readiness-'))
}

function writeRepoFile(root: string, relativePath: string, contents: string) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

function buildPackageJson(scripts: Record<string, string> = {}) {
  return JSON.stringify({
    name: 'mission-control',
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
      build: 'next build',
      ...scripts,
    },
  }, null, 2)
}

type CommandResult = { ok: boolean; status: number; stdout: string; stderr: string; error: string }

function makeCommandRunner(overrides: Record<string, CommandResult> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) return overrides[key]

    if (key === 'git branch --show-current') {
      return { ok: true, status: 0, stdout: 'feature-my-work-v1\n', stderr: '', error: '' }
    }
    if (key === 'git status --short') {
      return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    }
    if (key === 'git log --oneline main...HEAD') {
      return { ok: true, status: 0, stdout: 'abc1234 Add feature\n', stderr: '', error: '' }
    }
    if (key === 'git diff --name-only main...HEAD') {
      return { ok: true, status: 0, stdout: 'src/lib/foo.ts\n', stderr: '', error: '' }
    }
    return { ok: false, status: 1, stdout: '', stderr: `Unhandled: ${key}`, error: '' }
  }
}

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('pr-readiness-checker', () => {
  it('exports AGENT constant and LABEL', () => {
    expect(AGENT).toBe('PR Readiness Checker v1')
    expect(LABEL).toBe('OBSERVE ONLY / PR GATE')
  })

  it('status mode returns self-report without running git', () => {
    const result = buildStatusOutput('/fake/root')
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
    expect(result.observe_only).toBe(true)
    expect(Array.isArray(result.protected_branches)).toBe(true)
    expect(result.diff_warn_threshold).toBe(DIFF_WARN_THRESHOLD)
    expect(result.diff_fail_threshold).toBe(DIFF_FAIL_THRESHOLD)
  })

  it('main with no args returns status mode result', () => {
    const result = main([], { rootDir: '/fake/root' })
    expect(result.mode).toBe('status')
    expect(result.agent).toBe(AGENT)
  })

  it('PASS when branch is not main and tree is clean with commits', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = checkPRReadiness(root, makeCommandRunner())
    expect(result.ready).toBe(true)
    const branchCheck = result.checks.find((c: any) => c.name === 'branch-not-main')
    expect(branchCheck.status).toBe('PASS')
  })

  it('branch-not-main FAIL when on main branch', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'main\n', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const branchCheck = result.checks.find((c: any) => c.name === 'branch-not-main')
    expect(branchCheck.status).toBe('FAIL')
    expect(result.ready).toBe(false)
  })

  it('branch-not-main FAIL when on master branch', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())

    const runner = makeCommandRunner({
      'git branch --show-current': { ok: true, status: 0, stdout: 'master\n', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const branchCheck = result.checks.find((c: any) => c.name === 'branch-not-main')
    expect(branchCheck.status).toBe('FAIL')
  })

  it('working-tree-clean FAIL when status output is non-empty', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const runner = makeCommandRunner({
      'git status --short': { ok: true, status: 0, stdout: ' M src/lib/foo.ts\n', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const cleanCheck = result.checks.find((c: any) => c.name === 'working-tree-clean')
    expect(cleanCheck.status).toBe('FAIL')
    expect(result.ready).toBe(false)
  })

  it('has-commits-ahead FAIL when no commits ahead of main', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const runner = makeCommandRunner({
      'git log --oneline main...HEAD': { ok: true, status: 0, stdout: '', stderr: '', error: '' },
      'git log --oneline origin/main...HEAD': { ok: true, status: 0, stdout: '', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const commitCheck = result.checks.find((c: any) => c.name === 'has-commits-ahead')
    expect(commitCheck.status).toBe('FAIL')
    expect(result.commit_count).toBe(0)
  })

  it('config-files-present FAIL when config files are missing', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    // No config files written

    const result = checkPRReadiness(root, makeCommandRunner())
    const configCheck = result.checks.find((c: any) => c.name === 'config-files-present')
    expect(configCheck.status).toBe('FAIL')
    expect(result.ready).toBe(false)
  })

  it('validation-scripts-present FAIL when scripts are missing from package.json', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', JSON.stringify({ name: 'mc', scripts: {} }))

    const result = checkPRReadiness(root, makeCommandRunner())
    const scriptsCheck = result.checks.find((c: any) => c.name === 'validation-scripts-present')
    expect(scriptsCheck.status).toBe('FAIL')
  })

  it('diff-bounded WARN when changed files exceed warn threshold but not fail threshold', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/lib/file${i}.ts`).join('\n')
    const runner = makeCommandRunner({
      'git diff --name-only main...HEAD': { ok: true, status: 0, stdout: manyFiles + '\n', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const diffCheck = result.checks.find((c: any) => c.name === 'diff-bounded')
    expect(diffCheck.status).toBe('WARN')
    expect(result.changed_file_count).toBe(10)
  })

  it('diff-bounded FAIL when changed files exceed fail threshold', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const manyFiles = Array.from({ length: 21 }, (_, i) => `src/lib/file${i}.ts`).join('\n')
    const runner = makeCommandRunner({
      'git diff --name-only main...HEAD': { ok: true, status: 0, stdout: manyFiles + '\n', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const diffCheck = result.checks.find((c: any) => c.name === 'diff-bounded')
    expect(diffCheck.status).toBe('FAIL')
    expect(result.ready).toBe(false)
  })

  it('no-lockfile-drift WARN when both pnpm-lock.yaml and package.json are dirty', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const runner = makeCommandRunner({
      'git status --short': {
        ok: true, status: 0,
        stdout: ' M package.json\n M pnpm-lock.yaml\n',
        stderr: '', error: '',
      },
    })
    const result = checkPRReadiness(root, runner)
    const lockCheck = result.checks.find((c: any) => c.name === 'no-lockfile-drift')
    expect(lockCheck.status).toBe('WARN')
  })

  it('buildOutput returns correct shape with observe_only and requires_human_for', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = buildOutput(root, makeCommandRunner(), new Date('2026-05-10T00:00:00Z'))
    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(result.observe_only).toBe(true)
    expect(result.mode).toBe('check')
    expect(result.requires_human_for).toEqual(expect.arrayContaining(['push', 'create_pr', 'merge']))
    expect(typeof result.summary).toBe('string')
    expect(Array.isArray(result.checks)).toBe(true)
    expect(result.checks.length).toBeGreaterThanOrEqual(7)
  })

  it('result.checks has expected check names', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = checkPRReadiness(root, makeCommandRunner())
    const names = result.checks.map((c: any) => c.name)
    expect(names).toContain('branch-not-main')
    expect(names).toContain('working-tree-clean')
    expect(names).toContain('has-commits-ahead')
    expect(names).toContain('config-files-present')
    expect(names).toContain('validation-scripts-present')
    expect(names).toContain('no-lockfile-drift')
    expect(names).toContain('diff-bounded')
  })

  it('main with check mode returns mode=check', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = main(['check'], { rootDir: root, commandRunner: makeCommandRunner() })
    expect(result.mode).toBe('check')
    expect(result.agent).toBe(AGENT)
  })

  it('PROTECTED_BRANCHES includes main and master', () => {
    expect(PROTECTED_BRANCHES).toContain('main')
    expect(PROTECTED_BRANCHES).toContain('master')
  })

  it('has-commits-ahead falls back to origin/main...HEAD', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', '{}')
    writeRepoFile(root, 'config/mission-control-policy.json', '{}')
    writeRepoFile(root, 'package.json', buildPackageJson())

    const runner = makeCommandRunner({
      'git log --oneline main...HEAD': { ok: false, status: 128, stdout: '', stderr: 'unknown revision', error: '' },
      'git log --oneline origin/main...HEAD': { ok: true, status: 0, stdout: 'abc123 One commit\n', stderr: '', error: '' },
    })
    const result = checkPRReadiness(root, runner)
    const commitCheck = result.checks.find((c: any) => c.name === 'has-commits-ahead')
    expect(commitCheck.status).toBe('PASS')
    expect(result.commit_count).toBe(1)
  })

  it('cli output is valid JSON with required fields', () => {
    const execution = spawnSync(process.execPath, ['scripts/pr-readiness-checker.cjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(typeof parsed.status).toBe('string')
    expect(typeof parsed.observe_only).toBe('boolean')
  })
})
