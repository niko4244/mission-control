import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  BLOCKED_ACTIONS,
  runReleaseGovernor,
} = require('../../../scripts/release-governor.cjs')
const {
  validateMissionControlResult,
} = require('../../../scripts/mission-control-result-schema.cjs')
const {
  getAuthorityView,
  loadPolicy,
  loadRegistry,
} = require('../../../scripts/mission-control-bot-system.cjs')

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-governor-'))
}

function writeRepoFile(root: string, relativePath: string, contents: string) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

function buildRegistry(bots: any[]) {
  return JSON.stringify({
    version: 1,
    label: 'test',
    observe_only: true,
    bots,
  }, null, 2)
}

function buildPolicy() {
  return JSON.stringify({
    version: 1,
    label: 'test',
    observe_only: true,
    required_core_bots: ['human-owner', 'release-governor'],
    approval_matrix: {},
    authority_rules: {
      levels: {
        '0': {
          label: 'human_owner',
          may_mutate: true,
          may_stage: true,
          may_commit: true,
          may_push: true,
          may_create_pr: true,
          may_merge: true,
          may_authorize: true,
          may_reject: true,
          may_request_corrections: true,
        },
        '3': {
          label: 'domain_governor',
          may_mutate: false,
          may_stage: false,
          may_commit: false,
          may_push: false,
          may_create_pr: false,
          may_merge: false,
          may_authorize: true,
          may_reject: true,
          may_request_corrections: true,
        },
      },
      human_only_actions: ['merge'],
    },
  }, null, 2)
}

function buildPackageJson() {
  return JSON.stringify({
    name: 'mission-control',
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
      build: 'next build',
    },
  }, null, 2)
}

function makeCommandRunner(overrides: Record<string, any> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) {
      return overrides[key]
    }

    if (key === 'git branch --show-current') {
      return { ok: true, status: 0, stdout: 'release-governor-v1\n', stderr: '', error: '' }
    }
    if (key === 'git status --short') {
      return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    }
    if (key === 'git --no-pager log --oneline -5') {
      return { ok: true, status: 0, stdout: 'abc1234 Test commit\n', stderr: '', error: '' }
    }
    if (key === 'git diff --name-only main...HEAD') {
      return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    }

    return { ok: false, status: 1, stdout: '', stderr: `Unhandled command: ${key}`, error: '' }
  }
}

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('release governor', () => {
  it('exported function returns canonical observe-only result', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildRegistry([
      {
        id: 'human-owner',
        status: 'implemented',
        implementation_type: 'human',
        authority_level: 0,
      },
      {
        id: 'release-governor',
        status: 'implemented',
        implementation_type: 'script',
        authority_level: 3,
      },
    ]))
    writeRepoFile(root, 'config/mission-control-policy.json', buildPolicy())
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = runReleaseGovernor({
      rootDir: root,
      commandRunner: makeCommandRunner(),
      now: new Date('2026-05-10T12:00:00.000Z'),
    })
    const validation = validateMissionControlResult(result)

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe('OBSERVE ONLY')
    expect(result.status).toBe('PASS')
    expect(result.summary.observe_only).toBe(true)
    expect(result.blocked_actions).toEqual(BLOCKED_ACTIONS)
    expect(validation.valid).toBe(true)
  })

  it('missing config produces FAIL', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = runReleaseGovernor({
      rootDir: root,
      commandRunner: makeCommandRunner(),
    })

    expect(result.status).toBe('FAIL')
    expect(result.blockers.join(' ')).toContain('Required file missing')
  })

  it('dirty working tree produces WARN', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildRegistry([
      { id: 'human-owner', status: 'implemented', implementation_type: 'human', authority_level: 0 },
      { id: 'release-governor', status: 'implemented', implementation_type: 'script', authority_level: 3 },
    ]))
    writeRepoFile(root, 'config/mission-control-policy.json', buildPolicy())
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = runReleaseGovernor({
      rootDir: root,
      commandRunner: makeCommandRunner({
        'git status --short': {
          ok: true,
          status: 0,
          stdout: ' M README.md\n',
          stderr: '',
          error: '',
        },
      }),
    })

    expect(result.status).toBe('WARN')
    expect(result.working_tree_clean).toBe(false)
    expect(result.warnings).toContain('Working tree has uncommitted changes')
  })

  it('execution-enabling option produces FAIL', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildRegistry([
      { id: 'human-owner', status: 'implemented', implementation_type: 'human', authority_level: 0 },
      { id: 'release-governor', status: 'implemented', implementation_type: 'script', authority_level: 3 },
    ]))
    writeRepoFile(root, 'config/mission-control-policy.json', buildPolicy())
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = runReleaseGovernor({
      rootDir: root,
      commandRunner: makeCommandRunner(),
      allowMerge: true,
    })

    expect(result.status).toBe('FAIL')
    expect(result.blockers.join(' ')).toContain('execution-enabling options')
  })

  it('release-sensitive changed files are detected', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildRegistry([
      { id: 'human-owner', status: 'implemented', implementation_type: 'human', authority_level: 0 },
      { id: 'release-governor', status: 'implemented', implementation_type: 'script', authority_level: 3 },
    ]))
    writeRepoFile(root, 'config/mission-control-policy.json', buildPolicy())
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = runReleaseGovernor({
      rootDir: root,
      commandRunner: makeCommandRunner({
        'git diff --name-only main...HEAD': {
          ok: true,
          status: 0,
          stdout: 'package.json\nscripts/release-governor.cjs\nREADME.md\n',
          stderr: '',
          error: '',
        },
      }),
    })

    expect(result.status).toBe('WARN')
    expect(result.release_sensitive_files).toEqual([
      'package.json',
      'scripts/release-governor.cjs',
    ])
  })

  it('blocked autonomous actions are present', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildRegistry([
      { id: 'human-owner', status: 'implemented', implementation_type: 'human', authority_level: 0 },
      { id: 'release-governor', status: 'implemented', implementation_type: 'script', authority_level: 3 },
    ]))
    writeRepoFile(root, 'config/mission-control-policy.json', buildPolicy())
    writeRepoFile(root, 'package.json', buildPackageJson())

    const result = runReleaseGovernor({
      rootDir: root,
      commandRunner: makeCommandRunner(),
    })

    expect(result.blocked_actions).toEqual(expect.arrayContaining([
      'autonomous merge',
      'autonomous deploy',
      'autonomous release',
    ]))
  })

  it('cli output is valid json', () => {
    const execution = spawnSync(process.execPath, ['scripts/release-governor.cjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toBe(AGENT)
    expect(Array.isArray(parsed.checks)).toBe(true)
  })

  it('release-governor authority stays observe-only in the bot system', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)
    const authority = getAuthorityView('release-governor', registry, policy)

    expect(authority.may_do).toEqual(expect.arrayContaining(['authorize', 'reject', 'request corrections']))
    expect(authority.may_not_do).toEqual(expect.arrayContaining(['mutate', 'push', 'merge']))
  })
})
