import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  AUTHORITY,
  ALWAYS_HUMAN_REQUIRED,
  AUTONOMOUS_STAGE_COMMIT_RISKS,
  buildEscalateMode,
  buildReviewMode,
  buildStatusMode,
  evaluateReview,
  isCriticalHardBlock,
  loadBotSystem,
} = require('../../../scripts/chief-arbiter.cjs')

const {
  loadPolicy,
  loadRegistry,
  getAuthorityView,
} = require('../../../scripts/mission-control-bot-system.cjs')

describe('chief arbiter', () => {
  describe('identity and authority', () => {
    it('exports correct agent identity', () => {
      expect(AGENT).toBe('Chief Arbiter v1')
      expect(AUTHORITY).toBe('CROSS_DOMAIN_FINAL_BOT_REVIEW')
    })

    it('never authorizes push, pr, or merge', () => {
      expect(ALWAYS_HUMAN_REQUIRED).toEqual(
        expect.arrayContaining(['push', 'create_pr', 'merge']),
      )
    })

    it('registry marks chief-arbiter as implemented', () => {
      const registry = loadRegistry(ROOT)
      const bot = registry.bots.find((b: any) => b.id === 'chief-arbiter')

      expect(bot).toBeDefined()
      expect(bot.status).toBe('implemented')
      expect(bot.implementation_script).toBe('scripts/chief-arbiter.cjs')
    })

    it('authority view shows observe-only — no mutate, push, or merge', () => {
      const registry = loadRegistry(ROOT)
      const policy = loadPolicy(ROOT)
      const authority = getAuthorityView('chief-arbiter', registry, policy)

      expect(authority.may_do).toEqual(
        expect.arrayContaining(['authorize', 'reject', 'request corrections']),
      )
      expect(authority.may_not_do).toEqual(
        expect.arrayContaining(['mutate', 'push', 'create pr', 'merge']),
      )
    })

    it('chief-arbiter outranks all domain governors', () => {
      const registry = loadRegistry(ROOT)
      const chief = registry.bots.find((b: any) => b.id === 'chief-arbiter')
      const governors = registry.bots.filter(
        (b: any) => b.category === 'governor' || b.category === 'domain-arbiter',
      )

      expect(chief.authority_level).toBeLessThan(
        Math.min(...governors.map((b: any) => b.authority_level)),
      )
    })
  })

  describe('status mode', () => {
    it('returns canonical output with correct shape', () => {
      const result = buildStatusMode(ROOT)

      expect(result.agent).toBe(AGENT)
      expect(result.authority).toBe(AUTHORITY)
      expect(result.mode).toBe('status')
      expect(['PASS', 'WARN', 'FAIL']).toContain(result.status)
      expect(result.metadata.self_view).toBeDefined()
      expect(result.metadata.self_view.bot_id).toBe('chief-arbiter')
      expect(Array.isArray(result.metadata.implemented_bots)).toBe(true)
      expect(typeof result.summary).toBe('string')
    })

    it('reports chief-arbiter itself in implemented bots', () => {
      const result = buildStatusMode(ROOT)

      expect(result.metadata.implemented_bots).toContain('chief-arbiter')
    })

    it('lists supervised bots from registry', () => {
      const result = buildStatusMode(ROOT)

      expect(result.metadata.supervises).toEqual(
        expect.arrayContaining(['task-router', 'security-arbiter', 'release-governor']),
      )
    })

    it('authorization never grants push or merge', () => {
      const result = buildStatusMode(ROOT)

      expect(result.authorization.push_authorized).toBe(false)
      expect(result.authorization.merge_authorized).toBe(false)
      expect(result.authorization.pr_create_authorized).toBe(false)
    })
  })

  describe('review mode — hard blocks', () => {
    it('isCriticalHardBlock detects git add . pattern', () => {
      expect(isCriticalHardBlock('git add .')).toBe(true)
      expect(isCriticalHardBlock('merge without human approval')).toBe(true)
      expect(isCriticalHardBlock('lockfile drift')).toBe(true)
      expect(isCriticalHardBlock('fix typo')).toBe(false)
    })

    it('rejects task that requests git add .', () => {
      const result = buildReviewMode(ROOT, 'use git add . to stage all files', '')

      expect(result.decision).toBe('REJECT')
      expect(result.status).toBe('FAIL')
      expect(result.findings.blockers.join(' ')).toContain('git add .')
      expect(result.authorization.stage_authorized).toBe(false)
      expect(result.authorization.commit_authorized).toBe(false)
    })

    it('rejects task that requests merge without human approval', () => {
      const result = buildReviewMode(ROOT, 'merge without human approval to ship faster', '')

      expect(result.decision).toBe('REJECT')
      expect(result.findings.blockers.join(' ')).toContain('merge without human approval')
    })

    it('missing task returns FAIL', () => {
      const result = buildReviewMode(ROOT, '', '')

      expect(result.status).toBe('FAIL')
      expect(result.decision).toBe('ESCALATE_TO_HUMAN')
    })
  })

  describe('review mode — risk routing', () => {
    it('approves low-risk docs task with stage/commit authorized', () => {
      const result = buildReviewMode(ROOT, 'fix typo in documentation readme', '')

      expect(['APPROVE', 'APPROVE_WITH_NOTES']).toContain(result.decision)
      expect(result.risk).toBe('Docs')
      expect(result.authorization.stage_authorized).toBe(true)
      expect(result.authorization.commit_authorized).toBe(true)
      expect(result.authorization.push_authorized).toBe(false)
      expect(result.authorization.merge_authorized).toBe(false)
    })

    it('approves tooling task with stage/commit authorized', () => {
      const result = buildReviewMode(ROOT, 'add lint script to package scripts', '')

      expect(AUTONOMOUS_STAGE_COMMIT_RISKS).toContain(result.risk)
      expect(result.authorization.stage_authorized).toBe(true)
      expect(result.authorization.commit_authorized).toBe(true)
    })

    it('critical risk task always keeps push/pr/merge human-required', () => {
      const result = buildReviewMode(
        ROOT,
        'harden workspace fallback in tokens route auth helper',
        'security-governor',
      )

      expect(result.risk).toBe('Critical')
      expect(result.authorization.push_authorized).toBe(false)
      expect(result.authorization.pr_create_authorized).toBe(false)
      expect(result.authorization.merge_authorized).toBe(false)
      expect(result.authorization.human_required).toEqual(
        expect.arrayContaining(['push', 'create_pr', 'merge']),
      )
    })

    it('escalates protected domain task without governor', () => {
      const result = buildReviewMode(ROOT, 'change auth helper and tokens endpoint', '')

      expect(result.decision).toBe('ESCALATE_TO_HUMAN')
      expect(result.risk).toBe('Critical')
    })

    it('flags authority chain mismatch', () => {
      const policy = loadPolicy(ROOT)
      const reviewed = evaluateReview('fix typo in docs readme', 'security-governor', policy)

      expect(reviewed.findings.major.join(' ')).toContain('mismatch')
      expect(reviewed.decision).toBe('REQUEST_CORRECTIONS')
    })

    it('approves docs task with matching governor', () => {
      const policy = loadPolicy(ROOT)
      const reviewed = evaluateReview('fix typo in documentation readme', 'documentation-governor', policy)

      expect(['APPROVE', 'APPROVE_WITH_NOTES']).toContain(reviewed.decision)
      expect(reviewed.findings.major).toHaveLength(0)
    })
  })

  describe('escalate mode', () => {
    it('returns canonical escalation report', () => {
      const result = buildEscalateMode(ROOT)

      expect(result.agent).toBe(AGENT)
      expect(result.mode).toBe('escalate')
      expect(result.status).toBe('PASS')
      expect(Array.isArray(result.metadata.escalations_by_risk)).toBe(true)
      expect(Array.isArray(result.metadata.human_only_actions)).toBe(true)
      expect(Array.isArray(result.metadata.hard_blocks)).toBe(true)
      expect(Array.isArray(result.metadata.protected_domains)).toBe(true)
    })

    it('escalation registry covers all policy risk classes', () => {
      const result = buildEscalateMode(ROOT)
      const classes = result.metadata.escalations_by_risk.map((e: any) => e.risk_class)

      expect(classes).toEqual(
        expect.arrayContaining(['Critical', 'High', 'Medium', 'Low', 'Tooling']),
      )
    })

    it('human-only actions include merge', () => {
      const result = buildEscalateMode(ROOT)

      expect(result.metadata.human_only_actions).toContain('merge')
    })

    it('never authorizes push or merge in escalate mode', () => {
      const result = buildEscalateMode(ROOT)

      expect(result.authorization.push_authorized).toBe(false)
      expect(result.authorization.merge_authorized).toBe(false)
    })
  })

  describe('cli', () => {
    it('status CLI output is valid JSON with correct agent', () => {
      const execution = spawnSync(process.execPath, ['scripts/chief-arbiter.cjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      })

      expect(execution.status).toBe(0)
      const jsonText = execution.stdout.split('\n\n')[0]
      const parsed = JSON.parse(jsonText)
      expect(parsed.agent).toBe(AGENT)
      expect(parsed.authority).toBe(AUTHORITY)
      expect(parsed.mode).toBe('status')
    })

    it('review CLI rejects git add . task', () => {
      const execution = spawnSync(
        process.execPath,
        ['scripts/chief-arbiter.cjs', 'review', '--task', 'use git add . to stage everything'],
        { cwd: ROOT, encoding: 'utf8' },
      )

      expect(execution.status).toBe(0)
      const jsonText = execution.stdout.split('\n\n')[0]
      const parsed = JSON.parse(jsonText)
      expect(parsed.decision).toBe('REJECT')
    })
  })

  describe('bot system integration', () => {
    it('bot system detects chief-arbiter as implemented after script exists', () => {
      const botSystem = loadBotSystem(ROOT)
      expect(botSystem.available).toBe(true)

      const shared = botSystem.api.buildStatusMode(ROOT)
      expect(shared.registry.implemented).toContain('chief-arbiter')
    })

    it('bot system recommended_next_bot_pr no longer points to chief-arbiter', () => {
      const shared = buildStatusMode(ROOT)
      const nextBot = shared.metadata.planned_bots

      expect(nextBot).not.toContain('chief-arbiter')
    })
  })
})
