import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT: PEM_AGENT,
  ALWAYS_BLOCKED_ACTIONS,
  HUMAN_ONLY_ACTIONS,
  AUTONOMOUS_STAGE_COMMIT,
  buildDecision,
  buildStatusMode: pemStatus,
  buildEnforceMode,
  checkHardBlocks,
  checkProtectedDomain,
  enforce,
  getApprovalChain,
  isAlwaysBlocked,
  isHumanOnly,
  loadPolicy,
} = require('../../../scripts/policy-enforcement-middleware.cjs')

const {
  AGENT: ADS_AGENT,
  VALID_DECISIONS,
  VALID_RISK_LEVELS,
  REQUIRED_FIELDS,
  buildStatusMode: adsStatus,
  buildTemplateMode,
  buildValidateMode,
  buildTemplate,
  normalizeDecision,
  validateDecision,
} = require('../../../scripts/authority-decision-schema.cjs')

describe('policy enforcement middleware', () => {
  describe('identity', () => {
    it('exports correct agent', () => {
      expect(PEM_AGENT).toBe('Policy Enforcement Middleware v1')
    })

    it('always-blocked set contains critical violations', () => {
      expect(ALWAYS_BLOCKED_ACTIONS.has('force_push')).toBe(true)
      expect(ALWAYS_BLOCKED_ACTIONS.has('bypass_governance')).toBe(true)
      expect(ALWAYS_BLOCKED_ACTIONS.has('git_add_dot')).toBe(true)
    })

    it('human-only set contains push, create_pr, merge', () => {
      expect(HUMAN_ONLY_ACTIONS.has('push')).toBe(true)
      expect(HUMAN_ONLY_ACTIONS.has('create_pr')).toBe(true)
      expect(HUMAN_ONLY_ACTIONS.has('merge')).toBe(true)
    })

    it('autonomous stage/commit allowed for low-risk classes', () => {
      expect(AUTONOMOUS_STAGE_COMMIT.has('Low')).toBe(true)
      expect(AUTONOMOUS_STAGE_COMMIT.has('Tooling')).toBe(true)
      expect(AUTONOMOUS_STAGE_COMMIT.has('Docs')).toBe(true)
    })
  })

  describe('isAlwaysBlocked', () => {
    it('blocks force actions', () => {
      expect(isAlwaysBlocked('force_push')).toBe(true)
      expect(isAlwaysBlocked('bypass_governance')).toBe(true)
      expect(isAlwaysBlocked('rewrite_history')).toBe(true)
    })

    it('does not block safe actions', () => {
      expect(isAlwaysBlocked('commit')).toBe(false)
      expect(isAlwaysBlocked('observe')).toBe(false)
      expect(isAlwaysBlocked('approve')).toBe(false)
    })
  })

  describe('isHumanOnly', () => {
    it('push, create_pr, merge are human-only', () => {
      expect(isHumanOnly('push')).toBe(true)
      expect(isHumanOnly('create_pr')).toBe(true)
      expect(isHumanOnly('merge')).toBe(true)
    })

    it('commit and stage are not human-only', () => {
      expect(isHumanOnly('commit')).toBe(false)
      expect(isHumanOnly('stage')).toBe(false)
    })
  })

  describe('checkHardBlocks', () => {
    it('blocks git add .', () => {
      const { policy } = loadPolicy(ROOT)
      expect(checkHardBlocks('git add .', policy).blocked).toBe(true)
    })

    it('does not block safe action', () => {
      const { policy } = loadPolicy(ROOT)
      expect(checkHardBlocks('pnpm typecheck', policy).blocked).toBe(false)
    })
  })

  describe('checkProtectedDomain', () => {
    it('flags auth domain', () => {
      const { policy } = loadPolicy(ROOT)
      const result = checkProtectedDomain('change auth helper token', policy)
      expect(result.protected).toBe(true)
    })

    it('does not flag unrelated task', () => {
      const { policy } = loadPolicy(ROOT)
      const result = checkProtectedDomain('fix typo in readme', policy)
      expect(result.protected).toBe(false)
    })
  })

  describe('getApprovalChain', () => {
    it('Critical push has empty approved_bots', () => {
      const { policy } = loadPolicy(ROOT)
      const result = getApprovalChain('Critical', 'push', policy)
      expect(result.bots).toHaveLength(0)
      expect(result.human_required).toBe(true)
    })

    it('Tooling stage has chief-arbiter in bots', () => {
      const { policy } = loadPolicy(ROOT)
      const result = getApprovalChain('Tooling', 'stage', policy)
      expect(result.bots).toContain('chief-arbiter')
    })
  })

  describe('enforce', () => {
    it('rejects git add .', () => {
      const { policy } = loadPolicy(ROOT)
      const decision = enforce('git add .', {}, policy)
      expect(decision.decision).toBe('REJECT')
      expect(decision.blockers.length).toBeGreaterThan(0)
    })

    it('approves low-risk tooling action', () => {
      const { policy } = loadPolicy(ROOT)
      const decision = enforce('stage', { risk: 'Tooling', actor: 'chief-arbiter', approved_by: ['chief-arbiter'] }, policy)
      expect(['APPROVE', 'PENDING_HUMAN']).toContain(decision.decision)
    })

    it('never approves push autonomously', () => {
      const { policy } = loadPolicy(ROOT)
      const decision = enforce('push', { risk: 'Low', actor: 'chief-arbiter' }, policy)
      expect(decision.autonomous_allowed).toBe(false)
      expect(decision.human_required).toBe(true)
    })
  })

  describe('buildDecision', () => {
    it('returns canonical shape', () => {
      const decision = buildDecision({ action: 'commit', risk: 'Low', autonomous: true })
      expect(decision).toHaveProperty('decision')
      expect(decision).toHaveProperty('risk_level')
      expect(decision).toHaveProperty('authority_required')
      expect(decision).toHaveProperty('approved_by')
      expect(decision).toHaveProperty('blockers')
      expect(decision).toHaveProperty('validation_required')
      expect(decision).toHaveProperty('next_action')
    })

    it('blockers produce REJECT decision', () => {
      const decision = buildDecision({ blockers: ['hard block'] })
      expect(decision.decision).toBe('REJECT')
    })
  })

  describe('status mode', () => {
    it('returns PASS with policy loaded', () => {
      const result = pemStatus(ROOT)
      expect(result.status).toBe('PASS')
      expect(result.metadata.policy_loaded).toBe(true)
    })
  })

  describe('enforce mode', () => {
    it('returns FAIL for git add .', () => {
      const result = buildEnforceMode(ROOT, 'git add .', '')
      expect(result.status).toBe('FAIL')
      expect(result.metadata.decision.decision).toBe('REJECT')
    })
  })

  describe('cli', () => {
    it('status CLI returns valid JSON', () => {
      const r = spawnSync(process.execPath, ['scripts/policy-enforcement-middleware.cjs'], { cwd: ROOT, encoding: 'utf8' })
      expect(r.status).toBe(0)
      const d = JSON.parse(r.stdout.split('\n\n')[0])
      expect(d.agent).toBe(PEM_AGENT)
    })
  })
})

describe('authority decision schema', () => {
  describe('identity', () => {
    it('exports correct agent', () => {
      expect(ADS_AGENT).toBe('Authority Decision Schema v1')
    })

    it('required fields include all seven', () => {
      expect(REQUIRED_FIELDS).toEqual(expect.arrayContaining([
        'decision', 'risk_level', 'authority_required',
        'approved_by', 'blockers', 'validation_required', 'next_action',
      ]))
    })

    it('valid decisions include APPROVE and REJECT', () => {
      expect(VALID_DECISIONS.has('APPROVE')).toBe(true)
      expect(VALID_DECISIONS.has('REJECT')).toBe(true)
      expect(VALID_DECISIONS.has('ESCALATE_TO_HUMAN')).toBe(true)
    })
  })

  describe('validateDecision', () => {
    it('accepts valid complete decision', () => {
      const decision = buildTemplate({ decision: 'APPROVE', risk_level: 'Low', authority_required: 'bot' })
      expect(validateDecision(decision).valid).toBe(true)
    })

    it('rejects missing required fields', () => {
      const result = validateDecision({ decision: 'APPROVE' })
      expect(result.valid).toBe(false)
      expect(result.errors.join(' ')).toContain('risk_level')
    })

    it('rejects invalid decision value', () => {
      const decision = buildTemplate({ decision: 'MAGIC' as any })
      const result = validateDecision(decision)
      expect(result.valid).toBe(false)
      expect(result.errors.join(' ')).toContain('Invalid decision value')
    })

    it('rejects invalid risk_level', () => {
      const decision = buildTemplate({ risk_level: 'Catastrophic' as any })
      expect(validateDecision(decision).valid).toBe(false)
    })

    it('rejects non-array approved_by', () => {
      const decision = { ...buildTemplate(), approved_by: 'chief-arbiter' }
      expect(validateDecision(decision).valid).toBe(false)
    })

    it('warns on unknown fields', () => {
      const decision = { ...buildTemplate(), custom_field: 'x' }
      const result = validateDecision(decision)
      expect(result.warnings.join(' ')).toContain('Unknown fields')
    })
  })

  describe('buildTemplate', () => {
    it('generates default template', () => {
      const t = buildTemplate()
      expect(t.decision).toBe('PENDING_HUMAN')
      expect(t.risk_level).toBe('Unknown')
      expect(Array.isArray(t.approved_by)).toBe(true)
      expect(Array.isArray(t.blockers)).toBe(true)
    })

    it('accepts overrides', () => {
      const t = buildTemplate({ decision: 'APPROVE', risk_level: 'Low' })
      expect(t.decision).toBe('APPROVE')
      expect(t.risk_level).toBe('Low')
    })
  })

  describe('normalizeDecision', () => {
    it('normalizes invalid decision to PENDING_HUMAN', () => {
      const result = normalizeDecision({ decision: 'BOGUS', risk_level: 'Low', authority_required: 'bot', approved_by: [], blockers: [], validation_required: [], next_action: '' })
      expect(result.decision).toBe('PENDING_HUMAN')
    })

    it('deduplicates approved_by array', () => {
      const result = normalizeDecision({ ...buildTemplate(), approved_by: ['a', 'a', 'b'] })
      expect(result.approved_by).toEqual(['a', 'b'])
    })
  })

  describe('status mode', () => {
    it('returns PASS with schema info', () => {
      const result = adsStatus()
      expect(result.status).toBe('PASS')
      expect(result.metadata.required_fields).toHaveLength(REQUIRED_FIELDS.length)
    })
  })

  describe('validate mode', () => {
    it('PASS for valid decision JSON', () => {
      const decision = buildTemplate({ decision: 'APPROVE', risk_level: 'Low' })
      const result = buildValidateMode(JSON.stringify(decision))
      expect(['PASS', 'WARN']).toContain(result.status)
      expect(result.metadata.valid).toBe(true)
    })

    it('FAIL for invalid JSON', () => {
      const result = buildValidateMode('{bad}')
      expect(result.status).toBe('FAIL')
    })
  })

  describe('template mode', () => {
    it('returns canonical template', () => {
      const result = buildTemplateMode()
      expect(result.status).toBe('PASS')
      expect(result.metadata.template).toBeDefined()
      expect(result.metadata.template.decision).toBe('PENDING_HUMAN')
    })
  })

  describe('cli', () => {
    it('status CLI returns valid JSON', () => {
      const r = spawnSync(process.execPath, ['scripts/authority-decision-schema.cjs'], { cwd: ROOT, encoding: 'utf8' })
      expect(r.status).toBe(0)
      const d = JSON.parse(r.stdout.split('\n\n')[0])
      expect(d.agent).toBe(ADS_AGENT)
    })

    it('template CLI returns valid decision template', () => {
      const r = spawnSync(process.execPath, ['scripts/authority-decision-schema.cjs', 'template'], { cwd: ROOT, encoding: 'utf8' })
      expect(r.status).toBe(0)
      const d = JSON.parse(r.stdout.split('\n\n')[0])
      expect(d.metadata.template.decision).toBeDefined()
    })
  })
})
