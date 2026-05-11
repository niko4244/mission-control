import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  SCOPE_MINIMAL_MAX,
  SCOPE_BOUNDED_MAX,
  SCOPE_BROAD_MAX,
  ESCALATE_WARN_THRESHOLD,
  ESCALATE_THRESHOLD,
  classifyDiffScope,
  buildOutput,
  buildStatusOutput,
  isReleaseSensitive,
  categorizeFile,
  scopeRating,
  main,
} = require('../../../scripts/diff-scope-classifier.cjs')

type CommandResult = { ok: boolean; status: number; stdout: string; stderr: string; error: string }

function makeCommandRunner(overrides: Record<string, CommandResult> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) return overrides[key]

    if (key === 'git diff --name-only main...HEAD') {
      return { ok: true, status: 0, stdout: 'src/lib/foo.ts\nsrc/lib/bar.ts\n', stderr: '', error: '' }
    }
    return { ok: false, status: 1, stdout: '', stderr: `Unhandled: ${key}`, error: '' }
  }
}

function makeFilesRunner(files: string[]) {
  return makeCommandRunner({
    'git diff --name-only main...HEAD': {
      ok: true, status: 0,
      stdout: files.join('\n') + '\n',
      stderr: '', error: '',
    },
  })
}

describe('diff-scope-classifier', () => {
  it('exports AGENT and LABEL constants', () => {
    expect(AGENT).toBe('Diff Scope Classifier v1')
    expect(LABEL).toBe('OBSERVE ONLY / DIFF ANALYSIS')
  })

  it('exports correct threshold constants', () => {
    expect(SCOPE_MINIMAL_MAX).toBe(3)
    expect(SCOPE_BOUNDED_MAX).toBe(8)
    expect(SCOPE_BROAD_MAX).toBe(20)
    expect(ESCALATE_WARN_THRESHOLD).toBe(8)
    expect(ESCALATE_THRESHOLD).toBe(20)
  })

  it('status mode returns self-report without git calls', () => {
    const result = buildStatusOutput('/fake/root')
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
    expect(result.observe_only).toBe(true)
    expect(result.thresholds.warn_threshold).toBe(ESCALATE_WARN_THRESHOLD)
    expect(result.thresholds.escalate_threshold).toBe(ESCALATE_THRESHOLD)
  })

  it('main with no args returns status mode', () => {
    const result = main([], { rootDir: '/fake/root' })
    expect(result.mode).toBe('status')
    expect(result.agent).toBe(AGENT)
  })

  it('scopeRating returns minimal for 1-3 files', () => {
    expect(scopeRating(1)).toBe('minimal')
    expect(scopeRating(2)).toBe('minimal')
    expect(scopeRating(3)).toBe('minimal')
  })

  it('scopeRating returns bounded for 4-8 files', () => {
    expect(scopeRating(4)).toBe('bounded')
    expect(scopeRating(8)).toBe('bounded')
  })

  it('scopeRating returns broad for 9-20 files', () => {
    expect(scopeRating(9)).toBe('broad')
    expect(scopeRating(20)).toBe('broad')
  })

  it('scopeRating returns excessive for >20 files', () => {
    expect(scopeRating(21)).toBe('excessive')
    expect(scopeRating(100)).toBe('excessive')
  })

  it('3 files → no escalation, minimal scope', () => {
    const files = ['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts']
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.file_count).toBe(3)
    expect(result.scope_rating).toBe('minimal')
    expect(result.escalate).toBe(false)
    expect(result.warn_only).toBe(false)
  })

  it('9 files → warn_only but no escalation', () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/lib/file${i}.ts`)
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.file_count).toBe(9)
    expect(result.scope_rating).toBe('broad')
    expect(result.escalate).toBe(false)
    expect(result.warn_only).toBe(true)
    expect(result.escalation_reason).toBeTruthy()
  })

  it('21 files → escalate=true and scope_rating=excessive', () => {
    const files = Array.from({ length: 21 }, (_, i) => `src/lib/file${i}.ts`)
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.file_count).toBe(21)
    expect(result.scope_rating).toBe('excessive')
    expect(result.escalate).toBe(true)
    expect(result.escalation_reason).toBeTruthy()
  })

  it('isReleaseSensitive matches package.json', () => {
    expect(isReleaseSensitive('package.json')).toBe(true)
  })

  it('isReleaseSensitive matches pnpm-lock.yaml', () => {
    expect(isReleaseSensitive('pnpm-lock.yaml')).toBe(true)
  })

  it('isReleaseSensitive matches next.config.* files', () => {
    expect(isReleaseSensitive('next.config.js')).toBe(true)
    expect(isReleaseSensitive('next.config.ts')).toBe(true)
    expect(isReleaseSensitive('next.config.mjs')).toBe(true)
  })

  it('isReleaseSensitive matches src/app/api/** files', () => {
    expect(isReleaseSensitive('src/app/api/agents/route.ts')).toBe(true)
    expect(isReleaseSensitive('src/app/api/tasks/[id]/route.ts')).toBe(true)
  })

  it('isReleaseSensitive matches src/lib/security/** files', () => {
    expect(isReleaseSensitive('src/lib/security/scan.ts')).toBe(true)
  })

  it('isReleaseSensitive matches scripts/** files', () => {
    expect(isReleaseSensitive('scripts/release-governor.cjs')).toBe(true)
  })

  it('isReleaseSensitive matches config/*.json files', () => {
    expect(isReleaseSensitive('config/mission-control-policy.json')).toBe(true)
    expect(isReleaseSensitive('config/mission-control-bot-registry.json')).toBe(true)
  })

  it('isReleaseSensitive matches .github/** files', () => {
    expect(isReleaseSensitive('.github/workflows/ci.yml')).toBe(true)
  })

  it('isReleaseSensitive returns false for normal source files', () => {
    expect(isReleaseSensitive('src/lib/utils.ts')).toBe(false)
    expect(isReleaseSensitive('src/components/Dashboard.tsx')).toBe(false)
    expect(isReleaseSensitive('README.md')).toBe(false)
  })

  it('categorizeFile routes src/app/api paths to routes', () => {
    expect(categorizeFile('src/app/api/agents/route.ts')).toBe('routes')
  })

  it('categorizeFile routes test files to tests', () => {
    expect(categorizeFile('src/lib/__tests__/foo.test.ts')).toBe('tests')
    expect(categorizeFile('src/lib/foo.spec.ts')).toBe('tests')
  })

  it('categorizeFile routes .cjs files to scripts', () => {
    expect(categorizeFile('scripts/release-governor.cjs')).toBe('scripts')
  })

  it('categorizeFile routes config files to config', () => {
    expect(categorizeFile('config/policy.json')).toBe('config')
    expect(categorizeFile('package.json')).toBe('config')
    expect(categorizeFile('.github/workflows/ci.yml')).toBe('config')
  })

  it('classifyDiffScope returns by_category breakdown', () => {
    const files = [
      'src/app/api/tasks/route.ts',
      'src/lib/__tests__/foo.test.ts',
      'scripts/my-bot.cjs',
      'config/policy.json',
    ]
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.by_category.routes.length).toBe(1)
    expect(result.by_category.tests.length).toBe(1)
    expect(result.by_category.scripts.length).toBe(1)
    expect(result.by_category.config.length).toBe(1)
  })

  it('release_sensitive correctly identifies sensitive files in diff', () => {
    const files = [
      'src/lib/utils.ts',
      'package.json',
      'scripts/release-governor.cjs',
      'README.md',
    ]
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.release_sensitive).toContain('package.json')
    expect(result.release_sensitive).toContain('scripts/release-governor.cjs')
    expect(result.release_sensitive).not.toContain('src/lib/utils.ts')
    expect(result.release_sensitive).not.toContain('README.md')
  })

  it('buildOutput returns FAIL status for excessive scope', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/lib/file${i}.ts`)
    const result = buildOutput('/fake/root', makeFilesRunner(files), new Date())
    expect(result.status).toBe('FAIL')
    expect(result.escalate).toBe(true)
  })

  it('buildOutput returns WARN status for broad scope with release-sensitive files', () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/lib/file${i}.ts`)
    const result = buildOutput('/fake/root', makeFilesRunner(files), new Date())
    expect(result.status).toBe('WARN')
  })

  it('buildOutput returns PASS status for minimal clean scope', () => {
    const files = ['src/lib/foo.ts', 'src/lib/bar.ts']
    const result = buildOutput('/fake/root', makeFilesRunner(files), new Date())
    expect(result.status).toBe('PASS')
    expect(result.escalate).toBe(false)
  })

  it('buildOutput includes all required fields', () => {
    const result = buildOutput('/fake/root', makeCommandRunner(), new Date('2026-05-10T00:00:00Z'))
    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(result.observe_only).toBe(true)
    expect(result.mode).toBe('classify')
    expect(Array.isArray(result.changed_files)).toBe(true)
    expect(typeof result.file_count).toBe('number')
    expect(typeof result.scope_rating).toBe('string')
    expect(typeof result.escalate).toBe('boolean')
    expect(typeof result.recommendation).toBe('string')
    expect(result.by_category).toHaveProperty('routes')
    expect(result.by_category).toHaveProperty('tests')
    expect(result.by_category).toHaveProperty('scripts')
    expect(result.by_category).toHaveProperty('config')
    expect(result.by_category).toHaveProperty('components')
    expect(result.by_category).toHaveProperty('unknown')
    expect(typeof result.summary).toBe('string')
  })

  it('falls back to origin/main...HEAD when main...HEAD fails', () => {
    const runner = makeCommandRunner({
      'git diff --name-only main...HEAD': { ok: false, status: 128, stdout: '', stderr: 'unknown revision', error: '' },
      'git diff --name-only origin/main...HEAD': { ok: true, status: 0, stdout: 'src/lib/a.ts\n', stderr: '', error: '' },
    })
    const result = classifyDiffScope('/fake/root', runner)
    expect(result.diff_base).toBe('origin/main...HEAD')
    expect(result.changed_files).toContain('src/lib/a.ts')
  })

  it('diff_available=false when both diff commands fail', () => {
    const runner = makeCommandRunner({
      'git diff --name-only main...HEAD': { ok: false, status: 128, stdout: '', stderr: 'err', error: '' },
      'git diff --name-only origin/main...HEAD': { ok: false, status: 128, stdout: '', stderr: 'err', error: '' },
    })
    const result = classifyDiffScope('/fake/root', runner)
    expect(result.diff_available).toBe(false)
    expect(result.file_count).toBe(0)
  })

  it('main with classify mode returns mode=classify', () => {
    const result = main(['classify'], {
      rootDir: '/fake/root',
      commandRunner: makeCommandRunner(),
    })
    expect(result.mode).toBe('classify')
    expect(result.agent).toBe(AGENT)
  })

  it('cli output is valid JSON with required fields', () => {
    const execution = spawnSync(process.execPath, ['scripts/diff-scope-classifier.cjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(typeof parsed.status).toBe('string')
    expect(parsed.observe_only).toBe(true)
  })

  it('8 files exactly → bounded scope, no escalation, no warn_only', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/lib/file${i}.ts`)
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.scope_rating).toBe('bounded')
    expect(result.escalate).toBe(false)
    expect(result.warn_only).toBe(false)
  })

  it('20 files exactly → broad scope, warn_only, no full escalation', () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/lib/file${i}.ts`)
    const result = classifyDiffScope('/fake/root', makeFilesRunner(files))
    expect(result.scope_rating).toBe('broad')
    expect(result.escalate).toBe(false)
    expect(result.warn_only).toBe(true)
  })
})
