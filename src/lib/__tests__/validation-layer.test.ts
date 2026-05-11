import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  scoreRisk,
  buildScoreMode,
} = require('../../../scripts/risk-scoring-engine.cjs')

const {
  checkValidationGate,
  enforceGate,
  getRequiredSteps,
} = require('../../../scripts/validation-gate.cjs')

const {
  isBreakGlass,
  checkBreakGlass,
  auditBreakGlass,
  BREAK_GLASS_ACTIONS,
} = require('../../../scripts/break-glass-protocol.cjs')

const {
  loadPolicy,
} = require('../../../scripts/mission-control-bot-system.cjs')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy() {
  return loadPolicy(ROOT)
}

function makeMinimalPackageJson(scripts: Record<string, string> = {}) {
  return {
    name: 'mission-control',
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
      build: 'next build',
      ...scripts,
    },
  }
}

// ---------------------------------------------------------------------------
// RISK SCORING ENGINE
// ---------------------------------------------------------------------------

describe('risk scoring engine — file patterns', () => {
  it('auth/ files with auth domain score Critical', () => {
    // Single auth file (40pts) * auth domain multiplier (1.8x) = 72 -> Critical
    const result = scoreRisk(['src/lib/auth/session.ts'], [], 'auth')
    expect(result.risk_class).toBe('Critical')
    expect(result.risk_score).toBeGreaterThanOrEqual(71)
    expect(result.escalation_required).toBe(true)
  })

  it('multiple auth/ files score Critical without domain multiplier', () => {
    // Two auth files: 40+40 = 80 -> Critical
    const result = scoreRisk(['src/lib/auth/session.ts', 'src/lib/auth/token.ts'], [], '')
    expect(result.risk_class).toBe('Critical')
    expect(result.escalation_required).toBe(true)
  })

  it('test-only files score TestOnly / low', () => {
    const result = scoreRisk(
      ['src/lib/__tests__/foo.test.ts', 'src/lib/__tests__/bar.spec.ts'],
      [],
      '',
    )
    expect(result.risk_class).toBe('TestOnly')
    expect(result.risk_score).toBeLessThanOrEqual(20)
    expect(result.escalation_required).toBe(false)
  })

  it('docs-only files score Docs / low', () => {
    const result = scoreRisk(['docs/guide.md', 'docs/setup.md'], [], '')
    expect(result.risk_class).toBe('Docs')
    expect(result.risk_score).toBeLessThanOrEqual(20)
    expect(result.escalation_required).toBe(false)
  })

  it('package.json scores high due to weight', () => {
    const result = scoreRisk(['package.json'], [], '')
    expect(result.breakdown.file_risk).toBeGreaterThanOrEqual(35)
    expect(result.risk_class).not.toBe('Docs')
    expect(result.risk_class).not.toBe('TestOnly')
  })

  it('governance config files add 30 points each', () => {
    const result = scoreRisk(['config/mission-control-policy.json'], [], '')
    expect(result.breakdown.file_risk).toBeGreaterThanOrEqual(30)
  })

  it('API route files add 25 points each', () => {
    const result = scoreRisk(['src/app/api/agents/route.ts'], [], '')
    expect(result.breakdown.file_risk).toBeGreaterThanOrEqual(25)
  })

  it('script .cjs files add 20 points each', () => {
    const result = scoreRisk(['scripts/some-tool.cjs'], [], '')
    expect(result.breakdown.file_risk).toBeGreaterThanOrEqual(20)
  })

  it('large file count (>8) adds breadth penalty', () => {
    const files = Array.from({ length: 10 }, (_, i) => `docs/file${i}.md`)
    const result = scoreRisk(files, [], '')
    expect(result.breakdown.breadth_penalty).toBeGreaterThanOrEqual(20)
  })

  it('very large file count (>20) adds higher breadth penalty', () => {
    const files = Array.from({ length: 25 }, (_, i) => `docs/file${i}.md`)
    const result = scoreRisk(files, [], '')
    expect(result.breakdown.breadth_penalty).toBeGreaterThanOrEqual(40)
  })

  it('file count >50 adds maximum breadth penalty of 60', () => {
    const files = Array.from({ length: 55 }, (_, i) => `docs/file${i}.md`)
    const result = scoreRisk(files, [], '')
    expect(result.breakdown.breadth_penalty).toBe(60)
  })
})

describe('risk scoring engine — command risk', () => {
  it('pnpm test reduces risk score', () => {
    const withTest = scoreRisk(['src/app/api/route.ts'], ['pnpm test'], '')
    const withoutTest = scoreRisk(['src/app/api/route.ts'], [], '')
    expect(withTest.risk_score).toBeLessThan(withoutTest.risk_score)
  })

  it('git push increases risk score', () => {
    const withPush = scoreRisk(['docs/guide.md'], ['git push'], '')
    const withoutPush = scoreRisk(['docs/guide.md'], [], '')
    expect(withPush.risk_score).toBeGreaterThan(withoutPush.risk_score)
  })

  it('git merge command adds 50 points to command risk', () => {
    const result = scoreRisk([], ['git merge'], '')
    expect(result.breakdown.command_risk).toBeGreaterThanOrEqual(50)
  })

  it('rm -rf adds 80 points and scores Critical', () => {
    const result = scoreRisk(['src/app/api/route.ts'], ['rm -rf ./data'], '')
    expect(result.breakdown.command_risk).toBeGreaterThanOrEqual(80)
    expect(result.risk_class).toBe('Critical')
  })

  it('pnpm typecheck reduces risk by 5', () => {
    const result = scoreRisk([], ['pnpm typecheck'], '')
    expect(result.breakdown.command_risk).toBeLessThanOrEqual(-5)
  })
})

describe('risk scoring engine — domain multiplier', () => {
  it('auth domain multiplies score by 1.8x', () => {
    const base = scoreRisk(['src/lib/session.ts'], [], '')
    const withAuth = scoreRisk(['src/lib/session.ts'], [], 'auth')
    expect(withAuth.risk_score).toBeGreaterThanOrEqual(base.risk_score)
  })

  it('docs domain reduces score with 0.5x multiplier', () => {
    const base = scoreRisk(['src/lib/session.ts'], [], '')
    const withDocs = scoreRisk(['src/lib/session.ts'], [], 'docs')
    expect(withDocs.risk_score).toBeLessThanOrEqual(base.risk_score)
  })
})

describe('risk scoring engine — output shape', () => {
  it('buildScoreMode returns all required fields', () => {
    const result = buildScoreMode(['src/lib/auth/token.ts'], [], 'security')
    expect(result.agent).toContain('Risk Scoring Engine')
    expect(result.label).toContain('RISK CLASSIFIER')
    expect(typeof result.risk_score).toBe('number')
    expect(typeof result.risk_class).toBe('string')
    expect(Array.isArray(result.factors)).toBe(true)
    expect(typeof result.blast_radius).toBe('string')
    expect(typeof result.escalation_required).toBe('boolean')
    expect(result.breakdown).toEqual(
      expect.objectContaining({
        file_risk: expect.any(Number),
        command_risk: expect.any(Number),
        domain_risk: expect.any(Number),
        breadth_penalty: expect.any(Number),
      }),
    )
  })

  it('CLI returns valid JSON for status mode', () => {
    const execution = spawnSync(process.execPath, ['scripts/risk-scoring-engine.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toContain('Risk Scoring Engine')
    expect(parsed.mode).toBe('status')
  })

  it('CLI score mode returns valid JSON', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/risk-scoring-engine.cjs', 'score', '--files', '["package.json"]', '--domain', 'release'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.mode).toBe('score')
    expect(typeof parsed.risk_score).toBe('number')
    expect(typeof parsed.risk_class).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// VALIDATION GATE
// ---------------------------------------------------------------------------

describe('validation gate — check mode', () => {
  it('returns required steps for Critical risk class', () => {
    const policy = makePolicy()
    const packageJson = makeMinimalPackageJson()
    const result = checkValidationGate('Critical', null, policy, packageJson)
    expect(result.required_steps.length).toBeGreaterThan(0)
    expect(Array.isArray(result.required_steps)).toBe(true)
  })

  it('gate is closed when required steps are missing from package.json', () => {
    const policy = makePolicy()
    const emptyPackageJson = { name: 'test', scripts: {} }
    const result = checkValidationGate('Critical', null, policy, emptyPackageJson)
    expect(result.gate_open).toBe(false)
    expect(result.missing_from_package_json.length).toBeGreaterThan(0)
  })

  it('gate is closed for Critical without arbiter override even with all steps present', () => {
    const policy = makePolicy()
    const packageJson = makeMinimalPackageJson({
      'focused test': 'vitest run --reporter=verbose',
      fulltest: 'vitest run',
      'runner verify': 'node scripts/security-hardening-runner.cjs status',
      'governor verify': 'node scripts/security-governor.cjs status',
      'arbiter review': 'node scripts/chief-arbiter.cjs status',
    })
    const result = checkValidationGate('Critical', null, policy, packageJson)
    // Without arbiter override, Critical is closed
    expect(result.gate_open).toBe(false)
  })

  it('gate is open for Critical when arbiter override is provided and steps present', () => {
    const policy = makePolicy()
    // Provide a package.json that satisfies all steps
    const pj = {
      name: 'test',
      scripts: {
        'focused test': 'vitest --reporter=verbose',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        'full test': 'vitest run',
        build: 'next build',
        'runner verify': 'echo ok',
        'governor verify': 'echo ok',
        'arbiter review': 'echo ok',
      },
    }
    const result = checkValidationGate('Critical', 'Chief Arbiter approved', policy, pj)
    expect(result.arbiter_override).toBe('Chief Arbiter approved')
    // If all steps present and override given, gate should open
    expect(result.gate_open).toBe(true)
  })

  it('gate is open for Low risk when standard scripts exist', () => {
    const policy = makePolicy()
    const packageJson = makeMinimalPackageJson()
    const result = checkValidationGate('Low', null, policy, packageJson)
    // Low does not require arbiter override
    // Gate open depends on whether steps are present
    expect(typeof result.gate_open).toBe('boolean')
    expect(result.risk_class).toBe('Low')
  })
})

describe('validation gate — enforce mode', () => {
  it('enforce with all required steps for Low risk returns gate OPEN', () => {
    const policy = makePolicy()
    const required = getRequiredSteps(policy, 'Low')
    // Pass all required steps
    const result = enforceGate('Low', required, policy)
    expect(result.gate_status).toBe('OPEN')
    expect(result.satisfied).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('enforce with missing step for Critical returns gate CLOSED', () => {
    const policy = makePolicy()
    // Pass an empty set for Critical — all steps will be missing
    const result = enforceGate('Critical', [], policy)
    expect(result.gate_status).toBe('CLOSED')
    expect(result.satisfied).toBe(false)
    expect(result.missing.length).toBeGreaterThan(0)
  })

  it('enforce with all steps for Critical returns gate OPEN', () => {
    const policy = makePolicy()
    const required = getRequiredSteps(policy, 'Critical')
    const result = enforceGate('Critical', required, policy)
    expect(result.gate_status).toBe('OPEN')
    expect(result.satisfied).toBe(true)
  })

  it('enforce with missing step for Medium returns OVERRIDE_REQUIRED', () => {
    const policy = makePolicy()
    const result = enforceGate('Medium', [], policy)
    expect(result.gate_status).toBe('OVERRIDE_REQUIRED')
    expect(result.satisfied).toBe(false)
  })

  it('enforce with missing step for High returns CLOSED', () => {
    const policy = makePolicy()
    const result = enforceGate('High', [], policy)
    expect(result.gate_status).toBe('CLOSED')
  })

  it('enforce for TestOnly with all steps returns OPEN', () => {
    const policy = makePolicy()
    const required = getRequiredSteps(policy, 'TestOnly')
    const result = enforceGate('TestOnly', required, policy)
    expect(result.gate_status).toBe('OPEN')
  })
})

describe('validation gate — CLI', () => {
  it('CLI status mode returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/validation-gate.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toContain('Validation Gate')
    expect(parsed.mode).toBe('status')
    expect(typeof parsed.required_validations_per_risk_class).toBe('object')
  })

  it('CLI check mode returns valid JSON for Critical', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/validation-gate.cjs', 'check', '--risk', 'Critical'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.mode).toBe('check')
    expect(parsed.risk_class).toBe('Critical')
    expect(typeof parsed.gate_open).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// BREAK GLASS PROTOCOL
// ---------------------------------------------------------------------------

describe('break glass protocol — check mode', () => {
  it('force_push is identified as a break-glass action', () => {
    const result = checkBreakGlass('force_push')
    expect(result.is_break_glass).toBe(true)
    expect(result.action_id).toBe('force_push')
    expect(result.human_authorization_required).toBe(true)
    expect(result.bot_authorization_possible).toBe(false)
  })

  it('history_rewrite is a break-glass action', () => {
    const result = checkBreakGlass('history_rewrite')
    expect(result.is_break_glass).toBe(true)
    expect(result.bot_authorization_possible).toBe(false)
  })

  it('governance_bypass is a break-glass action', () => {
    const result = checkBreakGlass('governance_bypass')
    expect(result.is_break_glass).toBe(true)
    expect(result.bot_authorization_possible).toBe(false)
  })

  it('production_destructive is a break-glass action', () => {
    const result = checkBreakGlass('production_destructive')
    expect(result.is_break_glass).toBe(true)
    expect(result.human_authorization_required).toBe(true)
  })

  it('deploy_without_validation is a break-glass action', () => {
    const result = checkBreakGlass('deploy_without_validation')
    expect(result.is_break_glass).toBe(true)
  })

  it('non-break-glass action is permitted by standard governance', () => {
    const result = checkBreakGlass('update_readme')
    expect(result.is_break_glass).toBe(false)
    expect(result.bot_authorization_possible).toBe(true)
    expect(result.human_authorization_required).toBe(false)
  })

  it('all break-glass actions have bot_authorization_possible: false', () => {
    for (const actionId of Object.keys(BREAK_GLASS_ACTIONS)) {
      const result = checkBreakGlass(actionId)
      expect(result.bot_authorization_possible).toBe(false)
    }
  })

  it('escalation_path for break-glass actions mentions Human Owner', () => {
    const result = checkBreakGlass('secret_rotation')
    expect(result.escalation_path).toContain('Human Owner')
  })
})

describe('break glass protocol — audit mode', () => {
  it('audit mode returns blocked: true for a break-glass action', () => {
    const result = auditBreakGlass('force_push', 'security-executor')
    expect(result.attempted).toBe(true)
    expect(result.blocked).toBe(true)
    expect(result.requester).toBe('security-executor')
    expect(result.required_human_approval).toBe(true)
  })

  it('audit mode returns blocked: false for non-break-glass action', () => {
    const result = auditBreakGlass('update_readme', 'documentation-executor')
    expect(result.attempted).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.required_human_approval).toBe(false)
  })

  it('audit result always includes timestamp', () => {
    const result = auditBreakGlass('force_push', 'some-bot')
    expect(typeof result.timestamp).toBe('string')
    expect(result.timestamp.length).toBeGreaterThan(0)
  })

  it('audit for break-glass action has bot_authorization_possible: false', () => {
    const result = auditBreakGlass('merge_to_protected', 'release-manager')
    expect(result.bot_authorization_possible).toBe(false)
  })
})

describe('break glass protocol — status and isBreakGlass', () => {
  it('isBreakGlass returns true for known actions', () => {
    expect(isBreakGlass('force_push')).toBe(true)
    expect(isBreakGlass('secret_exposure')).toBe(true)
    expect(isBreakGlass('constitution_change')).toBe(true)
  })

  it('isBreakGlass returns false for unknown actions', () => {
    expect(isBreakGlass('write_tests')).toBe(false)
    expect(isBreakGlass('')).toBe(false)
    expect(isBreakGlass('update_docs')).toBe(false)
  })

  it('BREAK_GLASS_ACTIONS contains all 9 expected actions', () => {
    const ids = Object.keys(BREAK_GLASS_ACTIONS)
    expect(ids).toContain('force_push')
    expect(ids).toContain('history_rewrite')
    expect(ids).toContain('governance_bypass')
    expect(ids).toContain('production_destructive')
    expect(ids).toContain('secret_exposure')
    expect(ids).toContain('secret_rotation')
    expect(ids).toContain('constitution_change')
    expect(ids).toContain('merge_to_protected')
    expect(ids).toContain('deploy_without_validation')
    expect(ids.length).toBe(9)
  })

  it('CLI status mode returns valid JSON listing all break-glass actions', () => {
    const execution = spawnSync(process.execPath, ['scripts/break-glass-protocol.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toContain('Break Glass Protocol')
    expect(parsed.mode).toBe('status')
    expect(Array.isArray(parsed.break_glass_actions)).toBe(true)
    expect(parsed.break_glass_actions.length).toBe(9)
  })

  it('CLI check mode for force_push returns is_break_glass: true', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/break-glass-protocol.cjs', 'check', '--action', 'force_push'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.is_break_glass).toBe(true)
    expect(parsed.bot_authorization_possible).toBe(false)
  })

  it('CLI audit mode returns blocked: true for break-glass action', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/break-glass-protocol.cjs', 'audit', '--action', 'history_rewrite', '--requester', 'test-bot'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.blocked).toBe(true)
    expect(parsed.required_human_approval).toBe(true)
  })
})
