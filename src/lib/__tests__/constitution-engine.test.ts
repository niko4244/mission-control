import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  FORBIDDEN_COMMAND_PATTERNS,
  buildAuthorityMode,
  buildCheckMode,
  buildClassifyMode,
  buildStatusMode,
  canActAutonomously,
  checkForbiddenCommand,
  checkPolicyHardBlock,
  getAuthorityRules,
  loadPolicy,
  requiresHumanApproval,
} = require('../../../scripts/constitution-engine.cjs')

describe('constitution engine', () => {
  describe('identity', () => {
    it('exports correct agent identity', () => {
      expect(AGENT).toBe('Constitution Engine v1')
    })

    it('defines forbidden command patterns', () => {
      const ids = FORBIDDEN_COMMAND_PATTERNS.map((p: any) => p.id)
      expect(ids).toContain('git_add_dot')
      expect(ids).toContain('force_push')
      expect(ids).toContain('no_verify')
      expect(ids).toContain('history_rewrite')
    })
  })

  describe('loadPolicy', () => {
    it('loads the real policy from ROOT', () => {
      const result = loadPolicy(ROOT)
      expect(result.ok).toBe(true)
      expect(Array.isArray(result.policy.risk_classes)).toBe(true)
      expect(Array.isArray(result.policy.hard_blocks)).toBe(true)
    })

    it('returns error when policy missing', () => {
      const result = loadPolicy('/nonexistent/path')
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    })
  })

  describe('checkForbiddenCommand', () => {
    it('forbids git add .', () => {
      const result = checkForbiddenCommand('git add .')
      expect(result.forbidden).toBe(true)
      expect(result.violations.map((v: any) => v.id)).toContain('git_add_dot')
    })

    it('forbids force push', () => {
      const result = checkForbiddenCommand('git push --force')
      expect(result.forbidden).toBe(true)
    })

    it('forbids --no-verify', () => {
      expect(checkForbiddenCommand('git commit --no-verify').forbidden).toBe(true)
    })

    it('forbids history rewrite', () => {
      expect(checkForbiddenCommand('git reset --hard HEAD~3').forbidden).toBe(true)
    })

    it('permits normal safe commands', () => {
      expect(checkForbiddenCommand('git status --short').forbidden).toBe(false)
      expect(checkForbiddenCommand('pnpm test').forbidden).toBe(false)
      expect(checkForbiddenCommand('git add src/lib/utils.ts').forbidden).toBe(false)
    })
  })

  describe('checkPolicyHardBlock', () => {
    it('blocks git add . action', () => {
      const { policy } = loadPolicy(ROOT)
      const result = checkPolicyHardBlock('git add .', policy)
      expect(result.blocked).toBe(true)
    })

    it('blocks merge action', () => {
      const { policy } = loadPolicy(ROOT)
      const result = checkPolicyHardBlock('merge branch to main', policy)
      expect(result.blocked).toBe(true)
    })

    it('does not block safe tasks', () => {
      const { policy } = loadPolicy(ROOT)
      const result = checkPolicyHardBlock('add test for security route', policy)
      expect(result.blocked).toBe(false)
    })
  })

  describe('requiresHumanApproval', () => {
    it('Critical push requires human', () => {
      const { policy } = loadPolicy(ROOT)
      const result = requiresHumanApproval('Critical', 'push', policy)
      expect(result.required).toBe(true)
    })

    it('Critical merge requires human', () => {
      const { policy } = loadPolicy(ROOT)
      const result = requiresHumanApproval('Critical', 'merge', policy)
      expect(result.required).toBe(true)
    })

    it('Low push requires human', () => {
      const { policy } = loadPolicy(ROOT)
      const result = requiresHumanApproval('Low', 'push', policy)
      expect(result.required).toBe(true)
    })
  })

  describe('canActAutonomously', () => {
    it('chief-arbiter can auto-plan Critical tasks', () => {
      const { policy } = loadPolicy(ROOT)
      const result = canActAutonomously('Critical', 'plan', policy)
      expect(result.allowed).toBe(true)
      expect(result.approved_bots).toContain('chief-arbiter')
    })

    it('nobody can auto-push any risk class', () => {
      const { policy } = loadPolicy(ROOT)
      for (const risk of ['Critical', 'High', 'Medium', 'Low', 'Tooling']) {
        const result = canActAutonomously(risk, 'push', policy)
        expect(result.allowed).toBe(false)
      }
    })

    it('nobody can auto-merge any risk class', () => {
      const { policy } = loadPolicy(ROOT)
      for (const risk of ['Critical', 'High', 'Medium', 'Low', 'Tooling']) {
        const result = canActAutonomously(risk, 'merge', policy)
        expect(result.allowed).toBe(false)
      }
    })
  })

  describe('getAuthorityRules', () => {
    it('returns full rules for Critical', () => {
      const { policy } = loadPolicy(ROOT)
      const rules = getAuthorityRules('Critical', policy)
      expect(rules).not.toBeNull()
      expect(rules.risk_class).toBe('Critical')
      expect(Array.isArray(rules.can_auto_stage)).toBe(true)
      expect(Array.isArray(rules.human_required_for)).toBe(true)
      expect(rules.human_required_for).toContain('push')
      expect(rules.human_required_for).toContain('merge')
    })

    it('returns null for unknown risk class', () => {
      const { policy } = loadPolicy(ROOT)
      expect(getAuthorityRules('Imaginary', policy)).toBeNull()
    })
  })

  describe('status mode', () => {
    it('returns canonical PASS shape', () => {
      const result = buildStatusMode(ROOT)
      expect(result.agent).toBe(AGENT)
      expect(result.mode).toBe('status')
      expect(result.status).toBe('PASS')
      expect(Array.isArray(result.metadata.risk_classes)).toBe(true)
      expect(result.metadata.risk_classes.length).toBeGreaterThan(0)
      expect(result.metadata.hard_block_count).toBeGreaterThan(0)
    })
  })

  describe('check mode', () => {
    it('forbids git add .', () => {
      const result = buildCheckMode(ROOT, 'git add .')
      expect(result.status).toBe('FAIL')
      expect(result.metadata.verdict).toBe('FORBIDDEN')
    })

    it('permits git status', () => {
      const result = buildCheckMode(ROOT, 'git status --short')
      expect(result.status).toBe('PASS')
      expect(result.metadata.verdict).toBe('PERMITTED')
    })
  })

  describe('classify mode', () => {
    it('classifies auth task as Critical security domain', () => {
      const result = buildClassifyMode(ROOT, 'change auth helper token validation')
      expect(result.metadata.risk).toBe('Critical')
      expect(result.metadata.domain).toContain('security')
    })

    it('classifies docs task as Docs risk', () => {
      const result = buildClassifyMode(ROOT, 'fix typo in documentation readme')
      expect(result.metadata.risk).toBe('Docs')
    })

    it('includes authority rules in classification', () => {
      const result = buildClassifyMode(ROOT, 'add test for utils')
      expect(result.metadata.authority_rules).toBeDefined()
    })
  })

  describe('authority mode', () => {
    it('returns Critical authority rules', () => {
      const result = buildAuthorityMode(ROOT, 'Critical')
      expect(result.status).toBe('PASS')
      expect(result.metadata.risk_class).toBe('Critical')
      expect(result.metadata.human_required_for).toContain('push')
    })

    it('returns FAIL when risk missing', () => {
      const result = buildAuthorityMode(ROOT, '')
      expect(result.status).toBe('FAIL')
    })

    it('Tooling allows arbiter-authorized stage and commit', () => {
      const result = buildAuthorityMode(ROOT, 'Tooling')
      expect(result.metadata.can_auto_stage).toContain('chief-arbiter')
      expect(result.metadata.can_auto_commit).toContain('chief-arbiter')
    })
  })

  describe('cli', () => {
    it('status CLI returns valid JSON', () => {
      const result = spawnSync(process.execPath, ['scripts/constitution-engine.cjs'], {
        cwd: ROOT, encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.agent).toBe(AGENT)
      expect(parsed.metadata.policy_loaded).toBe(true)
    })

    it('check CLI forbids git add .', () => {
      const result = spawnSync(
        process.execPath,
        ['scripts/constitution-engine.cjs', 'check', '--action', 'git add .'],
        { cwd: ROOT, encoding: 'utf8' },
      )
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.metadata.verdict).toBe('FORBIDDEN')
    })
  })
})
