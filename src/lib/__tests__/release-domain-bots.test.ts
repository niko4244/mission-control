import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

// ---- Module imports ----
const ciSentinel = require('../../../scripts/ci-sentinel.cjs')
const mergeSteward = require('../../../scripts/merge-steward.cjs')
const testCoverageAuditor = require('../../../scripts/test-coverage-auditor.cjs')
const botRegistryInspector = require('../../../scripts/bot-registry-inspector.cjs')

// ---- Helpers ----

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-domain-bots-'))
}

function writeRepoFile(root: string, relativePath: string, contents: string) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

function buildPackageJson(extraScripts: Record<string, string> = {}) {
  return JSON.stringify({
    name: 'test-repo',
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
      build: 'next build',
      ...extraScripts,
    },
  }, null, 2)
}

function buildMinimalRegistry(extra: any[] = []) {
  return JSON.stringify({
    version: 1,
    label: 'test',
    observe_only: true,
    bots: [
      {
        id: 'human-owner',
        name: 'Human Owner',
        status: 'implemented',
        implementation_type: 'human',
        authority_level: 0,
        reports_to: null,
        supervises: ['chief-arbiter'],
        may_mutate: true,
        may_stage: true,
        may_commit: true,
        may_push: true,
        may_create_pr: true,
        may_merge: true,
        may_authorize: true,
        may_reject: true,
        may_request_corrections: true,
        human_approval_required_for: [],
        allowed_domains: ['all'],
        blocked_domains: [],
      },
      {
        id: 'chief-arbiter',
        name: 'Chief Arbiter',
        status: 'implemented',
        implementation_type: 'script',
        implementation_script: 'scripts/chief-arbiter.cjs',
        authority_level: 1,
        reports_to: 'human-owner',
        supervises: [],
        may_mutate: false,
        may_stage: false,
        may_commit: false,
        may_push: false,
        may_create_pr: false,
        may_merge: false,
        may_authorize: true,
        may_reject: true,
        may_request_corrections: true,
        human_approval_required_for: ['push', 'merge'],
        allowed_domains: ['all'],
        blocked_domains: [],
      },
      ...extra,
    ],
  }, null, 2)
}

function buildMinimalPolicy() {
  return JSON.stringify({
    version: 1,
    label: 'test',
    observe_only: true,
    required_core_bots: ['human-owner'],
    risk_classes: [],
    hard_blocks: [],
    protected_domains: [],
    routing_profiles: [],
    approval_matrix: {},
    required_validation: [],
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
        '1': {
          label: 'chief_arbiter',
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
        '4': {
          label: 'verifier',
          may_mutate: false,
          may_stage: false,
          may_commit: false,
          may_push: false,
          may_create_pr: false,
          may_merge: false,
          may_authorize: false,
          may_reject: false,
          may_request_corrections: true,
        },
        '5': {
          label: 'executor',
          may_mutate: true,
          may_stage: true,
          may_commit: true,
          may_push: false,
          may_create_pr: false,
          may_merge: false,
          may_authorize: false,
          may_reject: false,
          may_request_corrections: false,
        },
        '7': {
          label: 'observer',
          may_mutate: false,
          may_stage: false,
          may_commit: false,
          may_push: false,
          may_create_pr: false,
          may_merge: false,
          may_authorize: false,
          may_reject: false,
          may_request_corrections: true,
        },
      },
      human_only_actions: ['merge'],
    },
  }, null, 2)
}

function makeCommandRunnerNoGh(overrides: Record<string, any> = {}) {
  return (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`
    if (overrides[key]) return overrides[key]
    if (command === 'gh') {
      return { ok: false, status: 1, stdout: '', stderr: 'gh not found', error: '' }
    }
    if (key === 'git branch --show-current') {
      return { ok: true, status: 0, stdout: 'test-branch\n', stderr: '', error: '' }
    }
    if (key === 'git status --short') {
      return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
    }
    if (key === 'git log --oneline main...HEAD') {
      return { ok: true, status: 0, stdout: 'abc1234 Test commit\n', stderr: '', error: '' }
    }
    if (key === 'git diff --name-only --diff-filter=U') {
      return { ok: true, status: 0, stdout: '', stderr: '', error: '' }
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

// ============================================================
// CI SENTINEL TESTS
// ============================================================

describe('ci-sentinel', () => {
  it('exports AGENT with correct name', () => {
    expect(ciSentinel.AGENT).toBe('CI Sentinel v1')
  })

  it('exports LABEL as OBSERVE ONLY / CI HEALTH VERIFIER', () => {
    expect(ciSentinel.LABEL).toBe('OBSERVE ONLY / CI HEALTH VERIFIER')
  })

  it('exports buildStatusMode, buildCheckMode, buildOutput, main, checkValidationScripts, checkGhAvailable', () => {
    expect(typeof ciSentinel.buildStatusMode).toBe('function')
    expect(typeof ciSentinel.buildCheckMode).toBe('function')
    expect(typeof ciSentinel.buildOutput).toBe('function')
    expect(typeof ciSentinel.main).toBe('function')
    expect(typeof ciSentinel.checkValidationScripts).toBe('function')
    expect(typeof ciSentinel.checkGhAvailable).toBe('function')
  })

  it('status CLI returns valid JSON', () => {
    const result = spawnSync(process.execPath, ['scripts/ci-sentinel.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.agent).toBe('CI Sentinel v1')
    expect(parsed.mode).toBe('status')
  })

  it('status mode returns validation_scripts_available', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    const result = ciSentinel.buildStatusMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.metadata.validation_scripts_available).toBeDefined()
    expect(result.metadata.validation_scripts_available.typecheck).toBe(true)
    expect(result.metadata.validation_scripts_available.lint).toBe(true)
    expect(result.metadata.validation_scripts_available.test).toBe(true)
    expect(result.metadata.validation_scripts_available.build).toBe(true)
  })

  it('check mode returns validation_scripts_available', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    const result = ciSentinel.buildCheckMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.metadata.validation_scripts_available).toBeDefined()
  })

  it('check mode always includes requires_human_for push/create_pr/merge', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    const result = ciSentinel.buildCheckMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.requires_human_for).toContain('push')
    expect(result.requires_human_for).toContain('create_pr')
    expect(result.requires_human_for).toContain('merge')
  })

  it('status mode always includes requires_human_for push/create_pr/merge', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    const result = ciSentinel.buildStatusMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.requires_human_for).toContain('push')
    expect(result.requires_human_for).toContain('create_pr')
    expect(result.requires_human_for).toContain('merge')
  })

  it('observe_only is always true', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    const statusResult = ciSentinel.buildStatusMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    const checkResult = ciSentinel.buildCheckMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(statusResult.observe_only).toBe(true)
    expect(checkResult.observe_only).toBe(true)
  })

  it('missing validation scripts reported as unavailable', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', JSON.stringify({ name: 'test', scripts: {} }, null, 2))
    const result = ciSentinel.buildStatusMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.metadata.validation_scripts_available.typecheck).toBe(false)
    expect(result.status).toBe('WARN')
  })

  it('checkValidationScripts returns correct shape', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    const available = ciSentinel.checkValidationScripts(root)
    expect(available).toHaveProperty('typecheck')
    expect(available).toHaveProperty('lint')
    expect(available).toHaveProperty('test')
    expect(available).toHaveProperty('build')
  })
})

// ============================================================
// MERGE STEWARD TESTS
// ============================================================

describe('merge-steward', () => {
  it('exports AGENT with correct name', () => {
    expect(mergeSteward.AGENT).toBe('Merge Steward v1')
  })

  it('exports LABEL as OBSERVE ONLY / MERGE READINESS CHECKER', () => {
    expect(mergeSteward.LABEL).toBe('OBSERVE ONLY / MERGE READINESS CHECKER')
  })

  it('exports buildStatusMode, buildChecklistMode, buildOutput, main', () => {
    expect(typeof mergeSteward.buildStatusMode).toBe('function')
    expect(typeof mergeSteward.buildChecklistMode).toBe('function')
    expect(typeof mergeSteward.buildOutput).toBe('function')
    expect(typeof mergeSteward.main).toBe('function')
  })

  it('status CLI returns valid JSON', () => {
    const result = spawnSync(process.execPath, ['scripts/merge-steward.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.agent).toBe('Merge Steward v1')
    expect(parsed.mode).toBe('status')
  })

  it('checklist mode returns merge_ready field', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildMinimalRegistry())
    writeRepoFile(root, 'config/mission-control-policy.json', buildMinimalPolicy())
    const result = mergeSteward.buildChecklistMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.metadata).toHaveProperty('merge_ready')
  })

  it('merge_authorized is always false in checklist mode', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildMinimalRegistry())
    writeRepoFile(root, 'config/mission-control-policy.json', buildMinimalPolicy())
    const result = mergeSteward.buildChecklistMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(result.merge_authorized).toBe(false)
    expect(result.metadata.merge_authorized).toBe(false)
  })

  it('merge_authorized is always false in status mode', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const result = mergeSteward.buildStatusMode(root, {})
    expect(result.merge_authorized).toBe(false)
  })

  it('human_required always contains merge', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const statusResult = mergeSteward.buildStatusMode(root, {})
    expect(statusResult.human_required).toContain('merge')
  })

  it('checklist mode returns checklist array', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildMinimalRegistry())
    writeRepoFile(root, 'config/mission-control-policy.json', buildMinimalPolicy())
    const result = mergeSteward.buildChecklistMode(root, {
      commandRunner: makeCommandRunnerNoGh(),
    })
    expect(Array.isArray(result.metadata.checklist)).toBe(true)
    expect(result.metadata.checklist.length).toBeGreaterThan(0)
  })

  it('dirty working tree produces working-tree-clean fail in checklist', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'package.json', buildPackageJson())
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildMinimalRegistry())
    writeRepoFile(root, 'config/mission-control-policy.json', buildMinimalPolicy())
    const dirtyRunner = makeCommandRunnerNoGh({
      'git status --short': { ok: true, status: 0, stdout: ' M README.md\n', stderr: '', error: '' },
    })
    const result = mergeSteward.buildChecklistMode(root, { commandRunner: dirtyRunner })
    const item = result.metadata.checklist.find((c: any) => c.name === 'working-tree-clean')
    expect(item).toBeDefined()
    expect(item.status).toBe('fail')
  })
})

// ============================================================
// TEST COVERAGE AUDITOR TESTS
// ============================================================

describe('test-coverage-auditor', () => {
  it('exports AGENT with correct name', () => {
    expect(testCoverageAuditor.AGENT).toBe('Test Coverage Auditor v1')
  })

  it('exports LABEL as OBSERVE ONLY / COVERAGE VERIFIER', () => {
    expect(testCoverageAuditor.LABEL).toBe('OBSERVE ONLY / COVERAGE VERIFIER')
  })

  it('exports buildStatusMode, buildAuditMode, buildOutput, main, auditScripts, auditRoutes', () => {
    expect(typeof testCoverageAuditor.buildStatusMode).toBe('function')
    expect(typeof testCoverageAuditor.buildAuditMode).toBe('function')
    expect(typeof testCoverageAuditor.buildOutput).toBe('function')
    expect(typeof testCoverageAuditor.main).toBe('function')
    expect(typeof testCoverageAuditor.auditScripts).toBe('function')
    expect(typeof testCoverageAuditor.auditRoutes).toBe('function')
  })

  it('status CLI returns valid JSON', () => {
    const result = spawnSync(process.execPath, ['scripts/test-coverage-auditor.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.agent).toBe('Test Coverage Auditor v1')
    expect(parsed.mode).toBe('status')
  })

  it('audit mode returns coverage_score as integer 0-100', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'scripts/test-governor.cjs', '// governance script\n')
    const result = testCoverageAuditor.buildAuditMode(root, { scope: 'scripts' })
    expect(typeof result.metadata.coverage_score).toBe('number')
    expect(result.metadata.coverage_score).toBeGreaterThanOrEqual(0)
    expect(result.metadata.coverage_score).toBeLessThanOrEqual(100)
  })

  it('audit mode returns scripts_audited, scripts_with_tests', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'scripts/test-governor.cjs', '// governance script\n')
    const result = testCoverageAuditor.buildAuditMode(root, { scope: 'scripts' })
    expect(result.metadata).toHaveProperty('scripts_audited')
    expect(result.metadata).toHaveProperty('scripts_with_tests')
    expect(result.metadata).toHaveProperty('scripts_without_tests')
  })

  it('detects scripts without tests', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'scripts/my-governor.cjs', '// governance script\n')
    writeRepoFile(root, 'scripts/my-arbiter.cjs', '// governance script\n')
    const result = testCoverageAuditor.buildAuditMode(root, { scope: 'scripts' })
    expect(result.metadata.scripts_without_tests.length).toBeGreaterThan(0)
    const scriptNames = result.metadata.scripts_without_tests.map((s: any) => s.script)
    expect(scriptNames.some((s: string) => s.includes('governor'))).toBe(true)
  })

  it('detects script as having test when matching test file exists', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'scripts/my-governor.cjs', '// governance script\n')
    writeRepoFile(root, 'src/lib/__tests__/my-governor.test.ts', '// test\n')
    const result = testCoverageAuditor.buildAuditMode(root, { scope: 'scripts' })
    expect(result.metadata.scripts_without_tests.every((s: any) => !s.script.includes('my-governor'))).toBe(true)
  })

  it('waiver_required is true when High/Critical script lacks tests', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'scripts/my-arbiter.cjs', '// arbiter = critical\n')
    const result = testCoverageAuditor.buildAuditMode(root, { scope: 'scripts' })
    expect(result.metadata.waiver_required).toBe(true)
  })

  it('scope routes returns routes_audited', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const result = testCoverageAuditor.buildAuditMode(root, { scope: 'routes' })
    expect(result.metadata).toHaveProperty('routes_audited')
  })

  it('observe_only is always true', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const result = testCoverageAuditor.buildAuditMode(root, {})
    expect(result.observe_only).toBe(true)
  })
})

// ============================================================
// BOT REGISTRY INSPECTOR TESTS
// ============================================================

describe('bot-registry-inspector', () => {
  it('exports AGENT with correct name', () => {
    expect(botRegistryInspector.AGENT).toBe('Bot Registry Inspector v1')
  })

  it('exports LABEL as OBSERVE ONLY / REGISTRY CONSISTENCY AUDITOR', () => {
    expect(botRegistryInspector.LABEL).toBe('OBSERVE ONLY / REGISTRY CONSISTENCY AUDITOR')
  })

  it('exports buildStatusMode, buildInspectMode, buildOutput, main, inspectRegistry', () => {
    expect(typeof botRegistryInspector.buildStatusMode).toBe('function')
    expect(typeof botRegistryInspector.buildInspectMode).toBe('function')
    expect(typeof botRegistryInspector.buildOutput).toBe('function')
    expect(typeof botRegistryInspector.main).toBe('function')
    expect(typeof botRegistryInspector.inspectRegistry).toBe('function')
  })

  it('status CLI returns valid JSON', () => {
    const result = spawnSync(process.execPath, ['scripts/bot-registry-inspector.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.agent).toBe('Bot Registry Inspector v1')
    expect(parsed.mode).toBe('status')
  })

  it('inspect mode returns consistent field', () => {
    const result = botRegistryInspector.buildInspectMode(ROOT, {})
    expect(result.metadata).toHaveProperty('consistent')
    expect(typeof result.metadata.consistent).toBe('boolean')
  })

  it('inspect mode returns violations array', () => {
    const result = botRegistryInspector.buildInspectMode(ROOT, {})
    expect(Array.isArray(result.metadata.violations)).toBe(true)
  })

  it('inspect mode returns stats object', () => {
    const result = botRegistryInspector.buildInspectMode(ROOT, {})
    expect(typeof result.metadata.stats).toBe('object')
    expect(result.metadata.stats).toHaveProperty('total_bots')
  })

  it('inspect mode detects scripts missing from registry', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'config/mission-control-bot-registry.json', buildMinimalRegistry())
    writeRepoFile(root, 'config/mission-control-policy.json', buildMinimalPolicy())
    writeRepoFile(root, 'scripts/mission-control-bot-system.cjs', fs.readFileSync(
      path.join(ROOT, 'scripts/mission-control-bot-system.cjs'), 'utf8',
    ))
    writeRepoFile(root, 'scripts/orphan-governor.cjs', '// unregistered governance script\n')
    const inspectResult = botRegistryInspector.inspectRegistry(root, {})
    const warningTexts = inspectResult.warnings.join(' ')
    expect(warningTexts).toContain('orphan-governor')
  })

  it('inspect detects implemented bot with missing script file', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const reg = JSON.parse(buildMinimalRegistry([{
      id: 'ghost-sentinel',
      name: 'Ghost Sentinel',
      status: 'implemented',
      implementation_type: 'script',
      implementation_script: 'scripts/ghost-sentinel.cjs',
      authority_level: 4,
      reports_to: 'chief-arbiter',
      supervises: [],
      may_mutate: false,
      may_stage: false,
      may_commit: false,
      may_push: false,
      may_create_pr: false,
      may_merge: false,
      may_authorize: false,
      may_reject: false,
      may_request_corrections: true,
      human_approval_required_for: [],
      allowed_domains: ['ci'],
      blocked_domains: [],
    }]))
    writeRepoFile(root, 'config/mission-control-bot-registry.json', JSON.stringify(reg, null, 2))
    writeRepoFile(root, 'config/mission-control-policy.json', buildMinimalPolicy())
    writeRepoFile(root, 'scripts/mission-control-bot-system.cjs', fs.readFileSync(
      path.join(ROOT, 'scripts/mission-control-bot-system.cjs'), 'utf8',
    ))
    const inspectResult = botRegistryInspector.inspectRegistry(root, {})
    expect(inspectResult.consistent).toBe(false)
    const violationTexts = inspectResult.violations.join(' ')
    expect(violationTexts).toContain('ghost-sentinel')
  })

  it('observe_only is always true', () => {
    const result = botRegistryInspector.buildStatusMode(ROOT, {})
    expect(result.observe_only).toBe(true)
  })
})

// ============================================================
// REGISTRY AND PACKAGE.JSON INTEGRATION TESTS
// ============================================================

describe('registry and package.json integration', () => {
  it('registry has ci-sentinel as implemented', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mission-control-bot-registry.json'), 'utf8'))
    const bot = registry.bots.find((b: any) => b.id === 'ci-sentinel')
    expect(bot).toBeDefined()
    expect(bot.status).toBe('implemented')
    expect(bot.implementation_script).toBe('scripts/ci-sentinel.cjs')
  })

  it('registry has merge-steward as implemented', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mission-control-bot-registry.json'), 'utf8'))
    const bot = registry.bots.find((b: any) => b.id === 'merge-steward')
    expect(bot).toBeDefined()
    expect(bot.status).toBe('implemented')
    expect(bot.implementation_script).toBe('scripts/merge-steward.cjs')
  })

  it('registry has test-coverage-auditor as implemented', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mission-control-bot-registry.json'), 'utf8'))
    const bot = registry.bots.find((b: any) => b.id === 'test-coverage-auditor')
    expect(bot).toBeDefined()
    expect(bot.status).toBe('implemented')
    expect(bot.implementation_script).toBe('scripts/test-coverage-auditor.cjs')
  })

  it('registry has bot-registry-inspector as implemented', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mission-control-bot-registry.json'), 'utf8'))
    const bot = registry.bots.find((b: any) => b.id === 'bot-registry-inspector')
    expect(bot).toBeDefined()
    expect(bot.status).toBe('implemented')
    expect(bot.implementation_script).toBe('scripts/bot-registry-inspector.cjs')
  })

  it('package.json has govern:ci-sentinel alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['govern:ci-sentinel']).toBe('node scripts/ci-sentinel.cjs')
  })

  it('package.json has govern:merge-steward alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['govern:merge-steward']).toBe('node scripts/merge-steward.cjs')
  })

  it('package.json has audit:coverage alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['audit:coverage']).toBe('node scripts/test-coverage-auditor.cjs')
  })

  it('package.json has inspect:registry alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['inspect:registry']).toBe('node scripts/bot-registry-inspector.cjs')
  })
})
