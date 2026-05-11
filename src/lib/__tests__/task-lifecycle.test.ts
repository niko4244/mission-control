import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT: LIFECYCLE_AGENT,
  LABEL: LIFECYCLE_LABEL,
  LIFECYCLE_STAGES,
  buildAdvanceMode,
  buildLifecycleMap,
  buildMapMode,
  buildStatusMode: buildLifecycleStatus,
  computeStageBlockers,
  determineRiskForTask,
} = require('../../../scripts/task-lifecycle-engine.cjs')

const {
  AGENT: INTAKE_AGENT,
  LABEL: INTAKE_LABEL,
  buildApprovalEnvelope,
  buildFallbackRouting,
  buildIntakeMode,
  buildRouting,
  buildStatusMode: buildIntakeStatus,
  classifyIntent,
  computeRiskLevel,
  detectHardBlocks,
} = require('../../../scripts/request-intake-pipeline.cjs')

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function loadPolicy() {
  const { loadPolicy: lp } = require('../../../scripts/mission-control-bot-system.cjs')
  return lp(ROOT)
}

// ---------------------------------------------------------------------------
// SCRIPT 1: task-lifecycle-engine
// ---------------------------------------------------------------------------

describe('task-lifecycle-engine', () => {
  it('status mode returns correct agent name and label', () => {
    const result = buildLifecycleStatus(ROOT)

    expect(result.agent).toBe(LIFECYCLE_AGENT)
    expect(result.agent).toBe('Task Lifecycle Engine v1')
    expect(result.label).toBe(LIFECYCLE_LABEL)
    expect(result.label).toBe('OBSERVE ONLY / LIFECYCLE ORCHESTRATOR')
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
  })

  it('status mode reports subsystem availability', () => {
    const result = buildLifecycleStatus(ROOT)

    expect(result.subsystems).toBeDefined()
    expect(typeof result.subsystems['bot-system'].available).toBe('boolean')
    expect(result.subsystems['bot-system'].available).toBe(true)
  })

  it('status mode lists all 9 lifecycle stages', () => {
    const result = buildLifecycleStatus(ROOT)

    expect(Array.isArray(result.lifecycle_stages)).toBe(true)
    expect(result.lifecycle_stages).toHaveLength(9)
    expect(result.lifecycle_stages).toEqual([
      'observe', 'classify', 'plan', 'approve', 'implement',
      'validate', 'commit', 'pr', 'audit',
    ])
  })

  it('map mode returns lifecycle_map array with all 9 stages', () => {
    const result = buildMapMode('implement new feature for dashboard')

    expect(result.mode).toBe('map')
    expect(result.status).toBe('PASS')
    expect(Array.isArray(result.lifecycle_map)).toBe(true)
    expect(result.lifecycle_map).toHaveLength(9)
    const stageNames = result.lifecycle_map.map((entry: any) => entry.stage)
    expect(stageNames).toEqual(LIFECYCLE_STAGES)
  })

  it('map mode returns correct shape for each stage entry', () => {
    const result = buildMapMode('refactor routing module')

    for (const entry of result.lifecycle_map) {
      expect(typeof entry.stage).toBe('string')
      expect(typeof entry.status).toBe('string')
      expect(typeof entry.requires_human).toBe('boolean')
      expect(typeof entry.required_authority).toBe('string')
      expect(typeof entry.autonomous_safe).toBe('boolean')
      expect(typeof entry.description).toBe('string')
      expect(Array.isArray(entry.blockers)).toBe(true)
    }
  })

  it('pr stage always has requires_human: true in map', () => {
    const result = buildMapMode('create a pull request for the feature branch')

    const prStage = result.lifecycle_map.find((entry: any) => entry.stage === 'pr')
    expect(prStage).toBeDefined()
    expect(prStage.requires_human).toBe(true)
  })

  it('pr stage requires_human is true regardless of risk level', () => {
    const docsMap = buildLifecycleMap('fix a typo in docs', 'observe', null)
    const criticalMap = buildLifecycleMap('fix auth token leak', 'observe', null)

    const docsPr = docsMap.find((entry: any) => entry.stage === 'pr')
    const criticalPr = criticalMap.find((entry: any) => entry.stage === 'pr')

    expect(docsPr.requires_human).toBe(true)
    expect(criticalPr.requires_human).toBe(true)
  })

  it('observe and classify stages are autonomous_safe', () => {
    const result = buildMapMode('investigate slow query in dashboard')

    const observe = result.lifecycle_map.find((entry: any) => entry.stage === 'observe')
    const classify = result.lifecycle_map.find((entry: any) => entry.stage === 'classify')

    expect(observe.autonomous_safe).toBe(true)
    expect(classify.autonomous_safe).toBe(true)
  })

  it('implement, commit, pr stages are NOT autonomous_safe', () => {
    const result = buildMapMode('implement new auth feature')

    const implement = result.lifecycle_map.find((entry: any) => entry.stage === 'implement')
    const commit = result.lifecycle_map.find((entry: any) => entry.stage === 'commit')
    const pr = result.lifecycle_map.find((entry: any) => entry.stage === 'pr')

    expect(implement.autonomous_safe).toBe(false)
    expect(commit.autonomous_safe).toBe(false)
    expect(pr.autonomous_safe).toBe(false)
  })

  it('advance mode returns correct next_stage from classify', () => {
    const result = buildAdvanceMode('implement a new search feature', 'classify', null)

    expect(result.mode).toBe('advance')
    expect(result.current_stage).toBe('classify')
    expect(result.next_stage).toBe('plan')
    expect(typeof result.next_action).toBe('string')
    expect(result.next_action.length).toBeGreaterThan(0)
  })

  it('advance mode returns null next_stage at the final stage (audit)', () => {
    const result = buildAdvanceMode('fix docs typo', 'audit', null)

    expect(result.current_stage).toBe('audit')
    expect(result.next_stage).toBeNull()
  })

  it('advance mode includes lifecycle_map, current_stage, and next_action', () => {
    const result = buildAdvanceMode('add new API endpoint', 'plan', 'chief-arbiter')

    expect(Array.isArray(result.lifecycle_map)).toBe(true)
    expect(result.lifecycle_map).toHaveLength(9)
    expect(typeof result.current_stage).toBe('string')
    expect(typeof result.next_action).toBe('string')
  })

  it('advance mode marks stages before current as completed', () => {
    const result = buildAdvanceMode('refactor api routes', 'plan', null)

    const observe = result.lifecycle_map.find((e: any) => e.stage === 'observe')
    const classify = result.lifecycle_map.find((e: any) => e.stage === 'classify')

    expect(observe.status).toBe('completed')
    expect(classify.status).toBe('completed')
  })

  it('advance mode fails with missing task', () => {
    const result = buildAdvanceMode('', 'classify', null)

    expect(result.status).toBe('FAIL')
    expect(typeof result.error).toBe('string')
    expect(result.error.length).toBeGreaterThan(0)
  })

  it('advance mode fails with invalid current-stage', () => {
    const result = buildAdvanceMode('fix bug', 'not-a-stage', null)

    expect(result.status).toBe('FAIL')
    expect(typeof result.error).toBe('string')
  })

  it('plan stage is blocked for Critical risk without approval', () => {
    const blockers = computeStageBlockers('plan', 'Critical', null)

    expect(Array.isArray(blockers)).toBe(true)
    expect(blockers.length).toBeGreaterThan(0)
    expect(blockers.join(' ')).toMatch(/chief-arbiter|authorization/i)
  })

  it('determineRiskForTask classifies auth-related task as Critical', () => {
    expect(determineRiskForTask('fix auth token validation bug')).toBe('Critical')
    expect(determineRiskForTask('update gateway authentication flow')).toBe('Critical')
  })

  it('determineRiskForTask classifies docs task as Docs', () => {
    expect(determineRiskForTask('fix typo in readme documentation')).toBe('Docs')
    expect(determineRiskForTask('update the guide for new users')).toBe('Docs')
  })

  it('CLI for task-lifecycle-engine returns valid JSON with correct agent', () => {
    const execution = spawnSync(process.execPath, ['scripts/task-lifecycle-engine.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    // Output format is JSON + "\n\n" + summary text; parse only the JSON block
    const jsonBlock = execution.stdout.split('\n\n')[0]
    const parsed = JSON.parse(jsonBlock)
    expect(parsed.agent).toBe(LIFECYCLE_AGENT)
    expect(parsed.mode).toBe('status')
  })

  it('CLI map mode returns valid JSON with lifecycle_map', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/task-lifecycle-engine.cjs', 'map', '--task', 'add user search feature'],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    // Output format is JSON + "\n\n" + summary text; parse only the JSON block
    const jsonBlock = execution.stdout.split('\n\n')[0]
    const parsed = JSON.parse(jsonBlock)
    expect(Array.isArray(parsed.lifecycle_map)).toBe(true)
    expect(parsed.lifecycle_map).toHaveLength(9)
  })
})

// ---------------------------------------------------------------------------
// SCRIPT 2: request-intake-pipeline
// ---------------------------------------------------------------------------

describe('request-intake-pipeline', () => {
  it('status mode returns correct agent name and label', () => {
    const result = buildIntakeStatus(ROOT)

    expect(result.agent).toBe(INTAKE_AGENT)
    expect(result.agent).toBe('Request Intake Pipeline v1')
    expect(result.label).toBe(INTAKE_LABEL)
    expect(result.label).toBe('OBSERVE ONLY / REQUEST CLASSIFIER')
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
  })

  it('status mode lists valid sources and intent classes', () => {
    const result = buildIntakeStatus(ROOT)

    expect(Array.isArray(result.valid_sources)).toBe(true)
    expect(result.valid_sources).toContain('human')
    expect(result.valid_sources).toContain('bot')
    expect(result.valid_sources).toContain('scheduled')
    expect(Array.isArray(result.intent_classes)).toBe(true)
    expect(result.intent_classes.length).toBeGreaterThan(0)
  })

  it('intake mode classifies a security request as Critical', () => {
    const result = buildIntakeMode('harden the auth token gateway for workspace fallback', 'human', ROOT)

    expect(result.mode).toBe('intake')
    expect(result.receipt).toBeDefined()
    expect(result.receipt.risk_level).toBe('Critical')
    expect(result.receipt.intent).toBe('security')
    expect(result.receipt.requires_human).toBe(true)
  })

  it('intake mode classifies a docs typo as Docs risk', () => {
    const result = buildIntakeMode('fix typo in the readme documentation guide', 'human', ROOT)

    expect(result.receipt).toBeDefined()
    expect(result.receipt.risk_level).toBe('Docs')
    expect(result.receipt.intent).toBe('docs')
  })

  it('intake mode produces intake receipt with all required fields', () => {
    const result = buildIntakeMode('add a new feature to the user dashboard', 'human', ROOT)

    expect(result.receipt).toBeDefined()
    const receipt = result.receipt

    expect(typeof receipt.request_id).toBe('string')
    expect(receipt.request_id.startsWith('req-')).toBe(true)
    expect(typeof receipt.request).toBe('string')
    expect(typeof receipt.source).toBe('string')
    expect(typeof receipt.intent).toBe('string')
    expect(typeof receipt.risk_level).toBe('string')
    expect(Array.isArray(receipt.hard_blocks)).toBe(true)
    expect(typeof receipt.routing).toBe('object')
    expect(typeof receipt.approval_envelope).toBe('object')
    expect(typeof receipt.lifecycle_entry).toBe('string')
    expect(typeof receipt.requires_human).toBe('boolean')
    expect(typeof receipt.timestamp).toBe('string')
  })

  it('hard block is detected when request includes lockfile drift', () => {
    const blocks = detectHardBlocks('update the lockfile without explicit approval')

    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.join(' ')).toMatch(/lockfile/i)
  })

  it('intake mode with hard block returns WARN status and triggers block in receipt', () => {
    const result = buildIntakeMode(
      'merge all changes without human approval automatically',
      'bot',
      ROOT,
    )

    expect(result.receipt).toBeDefined()
    expect(result.receipt.hard_blocks.length).toBeGreaterThan(0)
    expect(result.status).toBe('WARN')
  })

  it('hard block detected for auth helper change triggers block entry', () => {
    const blocks = detectHardBlocks('change the auth helper workspace enforcement logic')

    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.join(' ')).toMatch(/auth|workspace/i)
  })

  it('routing is populated from policy for security request', () => {
    const result = buildIntakeMode('harden the gateway auth token route', 'human', ROOT)

    expect(result.receipt.routing).toBeDefined()
    expect(typeof result.receipt.routing.primary_bot).toBe('string')
    expect(result.receipt.routing.primary_bot.length).toBeGreaterThan(0)
    expect(typeof result.receipt.routing.arbiter).toBe('string')
    expect(typeof result.receipt.routing.arbiter_required).toBe('boolean')
    expect(result.receipt.routing.primary_bot).toBe('security-governor')
  })

  it('routing is populated from policy for docs request', () => {
    const result = buildIntakeMode('fix typo in docs readme', 'human', ROOT)

    expect(result.receipt.routing.primary_bot).toBe('documentation-governor')
    expect(result.receipt.routing.secondary_bot).toBe('documentation-executor')
    expect(result.receipt.routing.arbiter_required).toBe(false)
  })

  it('approval_envelope has autonomous_actions and human_required_actions', () => {
    const envelope = buildApprovalEnvelope('Critical', [])

    expect(Array.isArray(envelope.autonomous_actions)).toBe(true)
    expect(Array.isArray(envelope.human_required_actions)).toBe(true)
    expect(envelope.human_required_actions).toContain('pr')
    expect(envelope.human_required_actions).toContain('merge')
  })

  it('Docs risk level allows more autonomous actions than Critical', () => {
    const criticalEnvelope = buildApprovalEnvelope('Critical', [])
    const docsEnvelope = buildApprovalEnvelope('Docs', [])

    expect(docsEnvelope.autonomous_actions.length).toBeGreaterThan(
      criticalEnvelope.autonomous_actions.length,
    )
  })

  it('intake mode fails with missing --request value', () => {
    const result = buildIntakeMode('', 'human', ROOT)

    expect(result.status).toBe('FAIL')
    expect(typeof result.error).toBe('string')
    expect(result.error.length).toBeGreaterThan(0)
  })

  it('intake mode normalizes invalid source to human', () => {
    const result = buildIntakeMode('add docs update', 'invalid-source', ROOT)

    expect(result.receipt).toBeDefined()
    expect(result.receipt.source).toBe('human')
  })

  it('classifyIntent identifies security keywords correctly', () => {
    expect(classifyIntent('harden auth token gateway')).toBe('security')
    expect(classifyIntent('fix workspace enforcement vulnerability')).toBe('security')
  })

  it('classifyIntent identifies docs correctly', () => {
    expect(classifyIntent('fix typo in readme')).toBe('docs')
    expect(classifyIntent('update documentation guide')).toBe('docs')
  })

  it('computeRiskLevel returns Critical for security intent', () => {
    expect(computeRiskLevel('fix auth token leak', 'security')).toBe('Critical')
    expect(computeRiskLevel('harden gateway route', 'security')).toBe('Critical')
  })

  it('CLI for request-intake-pipeline returns valid JSON with correct agent', () => {
    const execution = spawnSync(process.execPath, ['scripts/request-intake-pipeline.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    // Output format is JSON + "\n\n" + summary text; parse only the JSON block
    const jsonBlock = execution.stdout.split('\n\n')[0]
    const parsed = JSON.parse(jsonBlock)
    expect(parsed.agent).toBe(INTAKE_AGENT)
    expect(parsed.mode).toBe('status')
  })

  it('CLI intake mode returns valid JSON with receipt', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/request-intake-pipeline.cjs', 'intake', '--request', 'add new dashboard widget feature'],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    // Output format is JSON + "\n\n" + summary text; parse only the JSON block
    const jsonBlock = execution.stdout.split('\n\n')[0]
    const parsed = JSON.parse(jsonBlock)
    expect(parsed.mode).toBe('intake')
    expect(parsed.receipt).toBeDefined()
    expect(typeof parsed.receipt.request_id).toBe('string')
    expect(typeof parsed.receipt.intent).toBe('string')
    expect(typeof parsed.receipt.risk_level).toBe('string')
  })
})
