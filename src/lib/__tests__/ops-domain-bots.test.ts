import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

// ── Script imports ───────────────────────────────────────────────────────────
const uiGov = require('../../../scripts/ui-dashboard-governor.cjs')
const opsDash = require('../../../scripts/operator-dashboard-bot.cjs')
const lessonsCurator = require('../../../scripts/lessons-curator.cjs')
const correctionMgr = require('../../../scripts/correction-loop-manager.cjs')
const promptCompiler = require('../../../scripts/prompt-compiler.cjs')
const registry = require('../../../config/mission-control-bot-registry.json')

// ── Temporary directory helpers ───────────────────────────────────────────────
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ops-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function tmpOptions(sub?: string) {
  const dir = sub ? path.join(tmpDir, sub) : tmpDir
  return { rootDir: tmpDir, dataDir: dir }
}

// ── UI Dashboard Governor ─────────────────────────────────────────────────────
describe('ui-dashboard-governor', () => {
  it('exports correct agent name', () => {
    expect(uiGov.AGENT).toBe('UI Dashboard Governor v1')
  })

  it('status CLI returns valid JSON', () => {
    const result = uiGov.buildStatusMode(ROOT)
    expect(typeof result).toBe('object')
    expect(result.agent).toBe('UI Dashboard Governor v1')
    expect(result.mode).toBe('status')
    expect(result.status).toBeDefined()
  })

  it('review: auth task → ESCALATE_TO_HUMAN', () => {
    const result = uiGov.buildReviewMode(ROOT, 'Update the login form to show auth token in header')
    expect(result.metadata.decision).toBe('ESCALATE_TO_HUMAN')
  })

  it('review: token in task → ESCALATE_TO_HUMAN', () => {
    const result = uiGov.buildReviewMode(ROOT, 'Display user API keys in dashboard widget')
    expect(result.metadata.decision).toBe('ESCALATE_TO_HUMAN')
  })

  it('review: cosmetic change → APPROVE', () => {
    const result = uiGov.buildReviewMode(ROOT, 'Update the color scheme of the header banner')
    expect(result.metadata.decision).toBe('APPROVE')
  })

  it('review: new panel → APPROVE_WITH_NOTES or APPROVE', () => {
    const result = uiGov.buildReviewMode(ROOT, 'Add new metrics panel to the overview page')
    expect(['APPROVE', 'APPROVE_WITH_NOTES']).toContain(result.metadata.decision)
  })

  it('review always includes requires_human_for with push/create_pr/merge', () => {
    const result = uiGov.buildReviewMode(ROOT, 'Update button colors')
    const rhf = result.metadata.requires_human_for
    expect(Array.isArray(rhf)).toBe(true)
    expect(rhf).toContain('push')
    expect(rhf).toContain('create_pr')
    expect(rhf).toContain('merge')
  })

  it('review: data exposure task → ESCALATE_TO_HUMAN', () => {
    const result = uiGov.buildReviewMode(ROOT, 'Show user secrets in the profile page panel')
    expect(result.metadata.decision).toBe('ESCALATE_TO_HUMAN')
    expect(result.metadata.data_exposure_risk).toBe(true)
  })

  it('review: missing task → FAIL', () => {
    const result = uiGov.buildReviewMode(ROOT, '')
    expect(result.status).toBe('FAIL')
  })

  it('status includes supervises list', () => {
    const result = uiGov.buildStatusMode(ROOT)
    expect(Array.isArray(result.metadata.supervises)).toBe(true)
    expect(result.metadata.supervises).toContain('operator-dashboard-bot')
  })
})

// ── Operator Dashboard Bot ────────────────────────────────────────────────────
describe('operator-dashboard-bot', () => {
  it('exports correct agent name', () => {
    expect(opsDash.AGENT).toBe('Operator Dashboard Bot v1')
  })

  it('status CLI returns valid JSON', () => {
    const result = opsDash.buildStatusMode(ROOT)
    expect(typeof result).toBe('object')
    expect(result.agent).toBe('Operator Dashboard Bot v1')
    expect(result.mode).toBe('status')
  })

  it('dashboard returns overall_health field', () => {
    const result = opsDash.buildDashboardMode(ROOT)
    expect(result.metadata).toHaveProperty('overall_health')
    expect(['PASS', 'WARN', 'FAIL']).toContain(result.metadata.overall_health)
  })

  it('dashboard returns governance_summary', () => {
    const result = opsDash.buildDashboardMode(ROOT)
    expect(result.metadata).toHaveProperty('governance_summary')
    const gs = result.metadata.governance_summary
    expect(gs).toHaveProperty('implemented_bots')
    expect(gs).toHaveProperty('planned_bots')
    expect(gs).toHaveProperty('release_ready')
  })

  it('dashboard returns next_recommended_action', () => {
    const result = opsDash.buildDashboardMode(ROOT)
    expect(result.metadata).toHaveProperty('next_recommended_action')
    expect(typeof result.metadata.next_recommended_action).toBe('string')
    expect(result.metadata.next_recommended_action.length).toBeGreaterThan(0)
  })

  it('dashboard returns operator_alerts array', () => {
    const result = opsDash.buildDashboardMode(ROOT)
    expect(result.metadata).toHaveProperty('operator_alerts')
    expect(Array.isArray(result.metadata.operator_alerts)).toBe(true)
  })

  it('dashboard returns timestamp', () => {
    const result = opsDash.buildDashboardMode(ROOT)
    expect(result.metadata).toHaveProperty('timestamp')
    expect(() => new Date(result.metadata.timestamp)).not.toThrow()
  })
})

// ── Lessons Curator ───────────────────────────────────────────────────────────
describe('lessons-curator', () => {
  it('exports correct agent name', () => {
    expect(lessonsCurator.AGENT).toBe('Lessons Curator v1')
  })

  it('status CLI returns valid JSON', () => {
    const result = lessonsCurator.buildStatusMode(ROOT, { dataDir: tmpDir })
    expect(typeof result).toBe('object')
    expect(result.agent).toBe('Lessons Curator v1')
    expect(result.mode).toBe('status')
  })

  it('add creates entry with required fields', () => {
    const lessonsPath = path.join(tmpDir, 'lessons.jsonl')
    const result = lessonsCurator.buildAddMode(ROOT, {
      title: 'Always gate on human approval before push',
      body: 'Bots must never push without explicit human confirmation.',
      lesson_type: 'pattern',
      source: 'chief-arbiter',
      severity: 'warn',
      tags: ['governance', 'git'],
    }, { lessonsPath })
    expect(result.status).toBe('PASS')
    expect(result.metadata.lesson).toBeDefined()
    const l = result.metadata.lesson
    expect(l.id).toMatch(/^les-/)
    expect(l.title).toBe('Always gate on human approval before push')
    expect(l.lesson_type).toBe('pattern')
    expect(l.source).toBe('chief-arbiter')
    expect(Array.isArray(l.tags)).toBe(true)
    expect(l.tags).toContain('governance')
  })

  it('add rejects missing title/body', () => {
    const lessonsPath = path.join(tmpDir, 'lessons2.jsonl')
    const result = lessonsCurator.buildAddMode(ROOT, { lesson_type: 'pattern' }, { lessonsPath })
    expect(result.status).toBe('FAIL')
  })

  it('list returns all lessons when no filter', () => {
    const lessonsPath = path.join(tmpDir, 'lessons3.jsonl')
    lessonsCurator.appendLesson(lessonsPath, { title: 'T1', body: 'B1', lesson_type: 'pattern', source: 'human', severity: 'info' })
    lessonsCurator.appendLesson(lessonsPath, { title: 'T2', body: 'B2', lesson_type: 'correction', source: 'human', severity: 'warn' })
    const result = lessonsCurator.buildListMode(ROOT, {}, { lessonsPath })
    expect(result.metadata.count).toBe(2)
  })

  it('list filters by type', () => {
    const lessonsPath = path.join(tmpDir, 'lessons4.jsonl')
    lessonsCurator.appendLesson(lessonsPath, { title: 'P1', body: 'B1', lesson_type: 'pattern', source: 'human', severity: 'info' })
    lessonsCurator.appendLesson(lessonsPath, { title: 'C1', body: 'B2', lesson_type: 'correction', source: 'human', severity: 'warn' })
    const result = lessonsCurator.buildListMode(ROOT, { lesson_type: 'pattern' }, { lessonsPath })
    expect(result.metadata.count).toBe(1)
    expect(result.metadata.lessons[0].lesson_type).toBe('pattern')
  })

  it('list returns empty array for nonexistent type', () => {
    const lessonsPath = path.join(tmpDir, 'lessons5.jsonl')
    lessonsCurator.appendLesson(lessonsPath, { title: 'T', body: 'B', lesson_type: 'pattern', source: 'human', severity: 'info' })
    const result = lessonsCurator.buildListMode(ROOT, { lesson_type: 'postmortem' }, { lessonsPath })
    expect(result.metadata.count).toBe(0)
    expect(result.metadata.lessons).toEqual([])
  })

  it('inspect returns lesson by id', () => {
    const lessonsPath = path.join(tmpDir, 'lessons6.jsonl')
    const addResult = lessonsCurator.buildAddMode(ROOT, {
      title: 'Findable',
      body: 'Body text',
      lesson_type: 'warning',
      source: 'human',
      severity: 'info',
    }, { lessonsPath })
    const id = addResult.metadata.lesson.id
    const inspectResult = lessonsCurator.buildInspectMode(ROOT, id, { lessonsPath })
    expect(inspectResult.status).toBe('PASS')
    expect(inspectResult.metadata.lesson.id).toBe(id)
  })

  it('inspect returns FAIL for unknown id', () => {
    const lessonsPath = path.join(tmpDir, 'lessons7.jsonl')
    const result = lessonsCurator.buildInspectMode(ROOT, 'les-nonexistent', { lessonsPath })
    expect(result.status).toBe('FAIL')
  })

  it('validateLesson catches invalid lesson_type', () => {
    const errors = lessonsCurator.validateLesson({
      id: 'les-test',
      timestamp: new Date().toISOString(),
      source: 'human',
      lesson_type: 'invalid_type',
      title: 'T',
      body: 'B',
      severity: 'info',
    })
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ── Correction Loop Manager ───────────────────────────────────────────────────
describe('correction-loop-manager', () => {
  it('exports correct agent name', () => {
    expect(correctionMgr.AGENT).toBe('Correction Loop Manager v1')
  })

  it('status CLI returns valid JSON', () => {
    const result = correctionMgr.buildStatusMode(ROOT, { dataDir: tmpDir })
    expect(typeof result).toBe('object')
    expect(result.agent).toBe('Correction Loop Manager v1')
    expect(result.mode).toBe('status')
  })

  it('submit creates open correction', () => {
    const correctionsPath = path.join(tmpDir, 'corrections.jsonl')
    const result = correctionMgr.buildSubmitMode(ROOT, {
      requester: 'security-governor',
      target_bot: 'security-executor',
      original_task: 'Harden workspace route',
      correction_requested: 'Must add explicit workspace ID validation',
    }, { correctionsPath })
    expect(result.status).toBe('PASS')
    const c = result.metadata.correction
    expect(c.id).toMatch(/^cor-/)
    expect(c.status).toBe('open')
    expect(c.requester).toBe('security-governor')
    expect(c.target_bot).toBe('security-executor')
  })

  it('submit rejects missing required fields', () => {
    const correctionsPath = path.join(tmpDir, 'corrections2.jsonl')
    const result = correctionMgr.buildSubmitMode(ROOT, { requester: 'human' }, { correctionsPath })
    expect(result.status).toBe('FAIL')
  })

  it('list returns all corrections when no filter', () => {
    const correctionsPath = path.join(tmpDir, 'corrections3.jsonl')
    correctionMgr.appendCorrection(correctionsPath, {
      requester: 'human', target_bot: 'security-executor',
      original_task: 'Task A', correction_requested: 'Fix A', status: 'open',
    })
    correctionMgr.appendCorrection(correctionsPath, {
      requester: 'security-governor', target_bot: 'security-executor',
      original_task: 'Task B', correction_requested: 'Fix B', status: 'addressed',
    })
    const result = correctionMgr.buildListMode(ROOT, {}, { correctionsPath })
    expect(result.metadata.count).toBe(2)
  })

  it('list filters by status', () => {
    const correctionsPath = path.join(tmpDir, 'corrections4.jsonl')
    correctionMgr.appendCorrection(correctionsPath, {
      requester: 'human', target_bot: 'a',
      original_task: 'T1', correction_requested: 'C1', status: 'open',
    })
    correctionMgr.appendCorrection(correctionsPath, {
      requester: 'human', target_bot: 'b',
      original_task: 'T2', correction_requested: 'C2', status: 'verified',
    })
    const result = correctionMgr.buildListMode(ROOT, { status: 'open' }, { correctionsPath })
    expect(result.metadata.count).toBe(1)
    expect(result.metadata.corrections[0].status).toBe('open')
  })

  it('advance updates status to addressed', () => {
    const correctionsPath = path.join(tmpDir, 'corrections5.jsonl')
    const submit = correctionMgr.buildSubmitMode(ROOT, {
      requester: 'human', target_bot: 'bot-x',
      original_task: 'T', correction_requested: 'C',
    }, { correctionsPath })
    const id = submit.metadata.correction.id
    const advance = correctionMgr.buildAdvanceMode(ROOT, id, 'Applied the fix', { correctionsPath })
    expect(advance.status).toBe('PASS')
    expect(advance.metadata.correction.status).toBe('addressed')
    expect(advance.metadata.correction.resolution).toBe('Applied the fix')
  })

  it('advance increments iterations', () => {
    const correctionsPath = path.join(tmpDir, 'corrections6.jsonl')
    const submit = correctionMgr.buildSubmitMode(ROOT, {
      requester: 'human', target_bot: 'bot-y',
      original_task: 'T', correction_requested: 'C',
    }, { correctionsPath })
    const id = submit.metadata.correction.id
    correctionMgr.buildAdvanceMode(ROOT, id, 'Fix 1', { correctionsPath })
    const advance2 = correctionMgr.buildAdvanceMode(ROOT, id, 'Fix 2', { correctionsPath })
    expect(advance2.metadata.correction.iterations).toBeGreaterThanOrEqual(1)
  })

  it('verify marks correction as verified', () => {
    const correctionsPath = path.join(tmpDir, 'corrections7.jsonl')
    const submit = correctionMgr.buildSubmitMode(ROOT, {
      requester: 'human', target_bot: 'bot-z',
      original_task: 'T', correction_requested: 'C',
    }, { correctionsPath })
    const id = submit.metadata.correction.id
    correctionMgr.buildAdvanceMode(ROOT, id, 'Fixed it', { correctionsPath })
    const verify = correctionMgr.buildVerifyMode(ROOT, id, { correctionsPath })
    expect(verify.status).toBe('PASS')
    expect(verify.metadata.correction.status).toBe('verified')
  })

  it('advance returns FAIL for unknown id', () => {
    const correctionsPath = path.join(tmpDir, 'corrections8.jsonl')
    const result = correctionMgr.buildAdvanceMode(ROOT, 'cor-nonexistent', 'fix', { correctionsPath })
    expect(result.status).toBe('FAIL')
  })

  it('verify returns FAIL for unknown id', () => {
    const correctionsPath = path.join(tmpDir, 'corrections9.jsonl')
    const result = correctionMgr.buildVerifyMode(ROOT, 'cor-nonexistent', { correctionsPath })
    expect(result.status).toBe('FAIL')
  })
})

// ── Prompt Compiler ───────────────────────────────────────────────────────────
describe('prompt-compiler', () => {
  it('exports correct agent name', () => {
    expect(promptCompiler.AGENT).toBe('Prompt Compiler v1')
  })

  it('status CLI returns valid JSON', () => {
    const result = promptCompiler.buildStatusMode(ROOT)
    expect(typeof result).toBe('object')
    expect(result.agent).toBe('Prompt Compiler v1')
    expect(result.mode).toBe('status')
  })

  it('compile returns prompt_text', () => {
    const result = promptCompiler.buildCompileMode(ROOT,
      'Add workspace validation to API route',
      'chief-arbiter',
      'High',
      'security-executor',
    )
    expect(result.status).toBe('PASS')
    expect(result.metadata).toHaveProperty('prompt_text')
    expect(typeof result.metadata.prompt_text).toBe('string')
    expect(result.metadata.prompt_text.length).toBeGreaterThan(100)
  })

  it('compile prompt_text contains task', () => {
    const task = 'Implement route-level workspace enforcement'
    const result = promptCompiler.buildCompileMode(ROOT, task, 'security-governor', 'Medium', 'security-executor')
    expect(result.metadata.prompt_text).toContain(task)
  })

  it('compile rejects empty approved_by', () => {
    const result = promptCompiler.buildCompileMode(ROOT, 'Some task', '', 'Low', 'security-executor')
    expect(result.status).toBe('FAIL')
  })

  it('compile rejects unrecognized approved_by', () => {
    const result = promptCompiler.buildCompileMode(ROOT, 'Some task', 'random-bot', 'Low', '')
    expect(result.status).toBe('FAIL')
  })

  it('compile always includes human_required_for: push/create_pr/merge', () => {
    const result = promptCompiler.buildCompileMode(ROOT, 'Deploy update', 'chief-arbiter', 'Medium', 'security-executor')
    expect(result.metadata).toHaveProperty('human_required_for')
    const hrf = result.metadata.human_required_for
    expect(Array.isArray(hrf)).toBe(true)
    expect(hrf).toContain('push')
    expect(hrf).toContain('create_pr')
    expect(hrf).toContain('merge')
  })

  it('compile returns approved_by and risk_level in metadata', () => {
    const result = promptCompiler.buildCompileMode(ROOT, 'Add feature', 'human-owner', 'High', 'security-executor')
    expect(result.metadata.approved_by).toBe('human-owner')
    expect(result.metadata.risk_level).toBe('High')
  })

  it('compile returns executor in metadata', () => {
    const result = promptCompiler.buildCompileMode(ROOT, 'Task', 'release-governor', 'Low', 'release-manager')
    expect(result.metadata.executor).toBe('release-manager')
  })

  it('validateAuthority accepts all recognized bots', () => {
    const bots = promptCompiler.RECOGNIZED_AUTHORITY_BOTS
    for (const bot of bots) {
      const r = promptCompiler.validateAuthority(bot)
      expect(r.valid).toBe(true)
    }
  })

  it('validateAuthority rejects unknown bot', () => {
    const r = promptCompiler.validateAuthority('totally-made-up-bot')
    expect(r.valid).toBe(false)
  })

  it('compile missing task returns FAIL', () => {
    const result = promptCompiler.buildCompileMode(ROOT, '', 'chief-arbiter', 'Low', '')
    expect(result.status).toBe('FAIL')
  })
})

// ── Registry validation ───────────────────────────────────────────────────────
describe('registry: all 5 bots implemented', () => {
  const botIds = [
    'ui-dashboard-governor',
    'operator-dashboard-bot',
    'lessons-curator',
    'correction-loop-manager',
    'prompt-compiler',
  ]

  for (const id of botIds) {
    it(`registry has ${id} as implemented`, () => {
      const bot = registry.bots.find((b: any) => b.id === id)
      expect(bot).toBeDefined()
      expect(bot.status).toBe('implemented')
      expect(bot.implementation_script).toBeDefined()
    })
  }
})

// ── Package.json aliases ──────────────────────────────────────────────────────
describe('package.json: all 5 aliases present', () => {
  const pkg = require('../../../package.json')

  it('has govern:ui alias', () => {
    expect(pkg.scripts['govern:ui']).toContain('ui-dashboard-governor.cjs')
  })

  it('has dashboard:ops alias', () => {
    expect(pkg.scripts['dashboard:ops']).toContain('operator-dashboard-bot.cjs')
  })

  it('has lessons:add alias', () => {
    expect(pkg.scripts['lessons:add']).toContain('lessons-curator.cjs')
  })

  it('has corrections:list alias', () => {
    expect(pkg.scripts['corrections:list']).toContain('correction-loop-manager.cjs')
  })

  it('has prompt:compile alias', () => {
    expect(pkg.scripts['prompt:compile']).toContain('prompt-compiler.cjs')
  })
})
