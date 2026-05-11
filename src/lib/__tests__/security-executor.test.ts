import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  AGENT,
  PACKET_FILE,
  BLOCKED_STAGE_BASENAMES,
  buildOutput,
  buildPlanPacket,
  evaluateFinalizeState,
  extractBranchFromPrompt,
  extractSectionLines,
  getPacketPath,
  inferCommitMessageFromTarget,
  runFinalizeApprovedMode,
  runPlanMode,
  runRunApprovedMode,
  saveExecutionPacket,
} = require('../../../scripts/security-executor.cjs')

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'security-executor-'))
}

function writeRepoFile(root: string, relativePath: string, contents: string) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

function makeRunnerAudit(overrides: Partial<any> = {}) {
  return {
    mode: 'audit',
    status: 'PASS',
    recommendation: {
      title: 'Harden tokens workspace route',
      branch: 'harden-tokens-workspace-route',
      risk: 'Critical',
      scope_files: ['src/app/api/tokens/route.ts'],
      why_next: 'Critical token route remains.',
      excluded: [],
      implementation_prompt: 'runner prompt',
    },
    batch_planner: {
      next_strategy: 'single_route',
      why: 'Critical token route remains.',
      single_route_remaining_is_worth_it: true,
    },
    ...overrides,
  }
}

function makeGovernorPlan(overrides: Partial<any> = {}) {
  return {
    mode: 'plan',
    status: 'PASS',
    decision: 'APPROVE_IMPLEMENTATION_PROMPT',
    strategy: {
      next_strategy: 'single_route',
      risk: 'Critical',
      target: 'src/app/api/tokens/route.ts',
      branch: 'harden-tokens-workspace-route',
      why: 'Critical token route remains.',
    },
    policy: {
      allowed_files: [
        'src/app/api/tokens/route.ts',
        'src/lib/__tests__/tokens-route-security.test.ts',
      ],
      blocked_files: [
        'package-lock.json',
        'pnpm-lock.yaml',
        'src/app/api/tokens/by-agent/route.ts',
      ],
      approval_gates: [],
      blocking_reasons: [],
      warnings: [],
    },
    implementation_prompt: '',
    ...overrides,
  }
}

function makeArbiterPlan(overrides: Partial<any> = {}) {
  const prompt = [
    'PROJECT: Mission Control',
    '',
    'BRANCH:',
    'Create from updated main: harden-tokens-workspace-route',
    '',
    'EXACT ALLOWED FILES:',
    '- src/app/api/tokens/route.ts',
    '- src/lib/__tests__/tokens-route-security.test.ts',
    '',
    'EXACT BLOCKED FILES:',
    '- package-lock.json',
    '- pnpm-lock.yaml',
    '- src/app/api/tokens/by-agent/route.ts',
    '',
    'VALIDATION COMMANDS:',
    'pnpm test -- src/lib/__tests__/tokens-route-security.test.ts',
    'pnpm typecheck',
    'pnpm lint',
    'pnpm test',
    'pnpm build',
    'node scripts/security-hardening-runner.cjs verify',
    'node scripts/security-governor.cjs verify',
  ].join('\n')

  return {
    mode: 'plan',
    status: 'WARN',
    decision: 'APPROVE_WITH_NOTES',
    risk: 'Critical',
    implementation_prompt: prompt,
    authorization: {
      plan_approved: true,
      implementation_approved: false,
      stage_authorized: false,
      commit_authorized: false,
      push_authorized: false,
      pr_create_authorized: false,
      merge_authorized: false,
    },
    findings: {
      blockers: [],
      major: [],
      minor: ['Governor prompt is missing: governor verify.'],
      advisory: [],
    },
    ...overrides,
  }
}

function makeRunnerVerify(overrides: Partial<any> = {}) {
  return {
    mode: 'verify',
    status: 'PASS',
    repo: {
      branch: 'harden-tokens-workspace-route',
      head: 'abc1234',
      working_tree_clean: false,
    },
    verify: {
      changed_files: [
        'src/app/api/tokens/route.ts',
        'src/lib/__tests__/tokens-route-security.test.ts',
      ],
      untracked_files: [],
      dirty_files: [
        'src/app/api/tokens/route.ts',
        'src/lib/__tests__/tokens-route-security.test.ts',
      ],
      staged_files: [],
      unstaged_files: [
        'src/app/api/tokens/route.ts',
        'src/lib/__tests__/tokens-route-security.test.ts',
      ],
      classifications: {
        route_files: ['src/app/api/tokens/route.ts'],
        test_files: ['src/lib/__tests__/tokens-route-security.test.ts'],
        docs: [],
        scripts: [],
        package_files: [],
        lockfiles: [],
        unknown: [],
        route_families: ['tokens'],
      },
      blocking_conditions: [],
      warnings: [],
      fallback_regression: { passed: true, matches: [] },
      focused_tests: {
        found: ['src/lib/__tests__/tokens-route-security.test.ts'],
        missing: [],
        command: 'pnpm test -- src/lib/__tests__/tokens-route-security.test.ts',
      },
      stage_recommendation: {
        recommended: true,
        files: [
          'src/app/api/tokens/route.ts',
          'src/lib/__tests__/tokens-route-security.test.ts',
        ],
      },
      commit_recommendation: {
        recommended: true,
        message: 'Harden tokens workspace route',
      },
      push_recommendation: { recommended: false },
    },
    ...overrides,
  }
}

function makeGovernorVerify(overrides: Partial<any> = {}) {
  return {
    mode: 'verify',
    status: 'PASS',
    decision: 'APPROVE_STAGE',
    policy: {
      blocking_reasons: [],
      warnings: [],
    },
    verify_decision: {
      stage_files: [
        'src/app/api/tokens/route.ts',
        'src/lib/__tests__/tokens-route-security.test.ts',
      ],
      commit_message: 'Harden tokens workspace route',
      push_allowed: false,
      pr_allowed: false,
    },
    ...overrides,
  }
}

function makeArbiterReview(overrides: Partial<any> = {}) {
  return {
    mode: 'review',
    status: 'PASS',
    decision: 'APPROVE',
    risk: 'Critical',
    authorization: {
      plan_approved: true,
      implementation_approved: true,
      stage_authorized: true,
      commit_authorized: true,
      push_authorized: false,
      pr_create_authorized: false,
      merge_authorized: false,
    },
    findings: {
      blockers: [],
      major: [],
      minor: [],
      advisory: [],
    },
    ...overrides,
  }
}

function makePacket(overrides: Partial<any> = {}) {
  const base = buildPlanPacket(makeArbiterPlan(), makeGovernorPlan(), makeRunnerAudit())
  return {
    ...base,
    ...overrides,
  }
}

function makeCommandRunner(script: Record<string, string | { ok?: boolean, stdout?: string, stderr?: string }>) {
  const calls: string[] = []
  const runner = (command: string, args: string[], options?: { cwd?: string }) => {
    const key = `${command} ${args.join(' ')}`
    calls.push(key)
    const entry = script[key]
    if (entry == null) {
      return { ok: false, status: 1, stdout: '', stderr: `Unexpected command: ${key}`, error: '' }
    }
    if (typeof entry === 'string') {
      return { ok: true, status: 0, stdout: entry, stderr: '', error: '' }
    }
    return {
      ok: entry.ok !== false,
      status: entry.ok === false ? 1 : 0,
      stdout: entry.stdout || '',
      stderr: entry.stderr || '',
      error: '',
    }
  }
  return { runner, calls }
}

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('security executor plan mode', () => {
  it('produces execution packet from approved Arbiter plan', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const result = runPlanMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
    })

    expect(result.decision).toBe('READY_TO_EXECUTE')
    expect(result.scope.branch).toBe('harden-tokens-workspace-route')
    expect(result.commit.message).toBe('Harden tokens workspace route')
    expect(result.pr.title).toBe('Harden tokens workspace route')
  })

  it('blocks when Arbiter does not approve plan', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const result = runPlanMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan({ decision: 'REQUEST_GOVERNOR_CORRECTION', authorization: { plan_approved: false } }) },
    })

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Arbiter plan decision')
  })

  it('carries allowed and blocked file lists through', () => {
    const packet = buildPlanPacket(makeArbiterPlan(), makeGovernorPlan(), makeRunnerAudit())

    expect(packet.approved_files).toEqual([
      'src/app/api/tokens/route.ts',
      'src/lib/__tests__/tokens-route-security.test.ts',
    ])
    expect(packet.blocked_files).toContain('src/app/api/tokens/by-agent/route.ts')
  })

  it('includes implementation prompt and validation commands', () => {
    const result = runPlanMode(makeTempRepo(), {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
    })

    expect(result.implementation_prompt).toContain('Create from updated main: harden-tokens-workspace-route')
    expect(result.validation_commands).toContain('pnpm typecheck')
    expect(result.validation_commands).toContain('node scripts/security-governor.cjs verify')
  })

  it('does not mutate in plan mode', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    runPlanMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
    })

    expect(fs.existsSync(getPacketPath(root))).toBe(false)
  })

  it('extracts branch and allowed file sections from the Arbiter prompt', () => {
    const prompt = makeArbiterPlan().implementation_prompt

    expect(extractBranchFromPrompt(prompt)).toBe('harden-tokens-workspace-route')
    expect(extractSectionLines(prompt, 'EXACT ALLOWED FILES:')).toEqual([
      'src/app/api/tokens/route.ts',
      'src/lib/__tests__/tokens-route-security.test.ts',
    ])
  })
})

describe('security executor run-approved mode', () => {
  it('blocks on dirty main', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const { runner } = makeCommandRunner({
      'git status --short': ' M scripts/security-executor.cjs',
      'git branch --show-current': 'main',
    })

    const result = runRunApprovedMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
      commandRunner: runner,
    })

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Working tree must be clean')
  })

  it('creates the approved branch only when plan is approved', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const { runner, calls } = makeCommandRunner({
      'git status --short': '',
      'git branch --show-current': 'main',
      'git show-ref --verify --quiet refs/heads/harden-tokens-workspace-route': { ok: false, stderr: '' },
      'git checkout -b harden-tokens-workspace-route': 'Switched to a new branch',
    })

    const result = runRunApprovedMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
      commandRunner: runner,
    })

    expect(result.decision).toBe('READY_FOR_IMPLEMENTER')
    expect(calls).toContain('git checkout -b harden-tokens-workspace-route')
  })

  it('does not modify route files', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    writeRepoFile(root, 'src/app/api/tokens/route.ts', 'export {}\n')
    const before = fs.readFileSync(path.join(root, 'src/app/api/tokens/route.ts'), 'utf8')
    const { runner } = makeCommandRunner({
      'git status --short': '',
      'git branch --show-current': 'main',
      'git show-ref --verify --quiet refs/heads/harden-tokens-workspace-route': { ok: false, stderr: '' },
      'git checkout -b harden-tokens-workspace-route': 'Switched to a new branch',
    })

    runRunApprovedMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
      commandRunner: runner,
    })

    const after = fs.readFileSync(path.join(root, 'src/app/api/tokens/route.ts'), 'utf8')
    expect(after).toBe(before)
  })

  it('outputs READY_FOR_IMPLEMENTER', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    const { runner } = makeCommandRunner({
      'git status --short': '',
      'git branch --show-current': 'main',
      'git show-ref --verify --quiet refs/heads/harden-tokens-workspace-route': { ok: false, stderr: '' },
      'git checkout -b harden-tokens-workspace-route': 'Switched to a new branch',
    })

    const result = runRunApprovedMode(root, {
      runnerApi: { runAuditMode: () => makeRunnerAudit() },
      governorApi: { runPlanMode: () => makeGovernorPlan() },
      arbiterApi: { runPlanMode: () => makeArbiterPlan() },
      commandRunner: runner,
    })

    expect(result.decision).toBe('READY_FOR_IMPLEMENTER')
    expect(fs.existsSync(getPacketPath(root))).toBe(true)
  })
})

describe('security executor finalize-approved mode', () => {
  it('blocks when Runner verify fails', () => {
    const result = evaluateFinalizeState(
      makePacket(),
      {
        runnerState: { available: true, result: makeRunnerVerify({ status: 'FAIL', verify: { ...makeRunnerVerify().verify, blocking_conditions: ['Runner fail'] } }) },
        governorState: { available: true, result: makeGovernorVerify({ status: 'FAIL', decision: 'BLOCK_COMMIT' }) },
        arbiterState: { available: true, result: makeArbiterReview({ status: 'FAIL', decision: 'REJECT' }) },
      },
      'harden-tokens-workspace-route',
    )

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Runner verify returned FAIL')
  })

  it('blocks when Governor blocks commit', () => {
    const result = evaluateFinalizeState(
      makePacket(),
      {
        runnerState: { available: true, result: makeRunnerVerify() },
        governorState: { available: true, result: makeGovernorVerify({ decision: 'BLOCK_COMMIT', status: 'FAIL' }) },
        arbiterState: { available: true, result: makeArbiterReview() },
      },
      'harden-tokens-workspace-route',
    )

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Governor decision BLOCK_COMMIT')
  })

  it('blocks when Arbiter rejects', () => {
    const result = evaluateFinalizeState(
      makePacket(),
      {
        runnerState: { available: true, result: makeRunnerVerify() },
        governorState: { available: true, result: makeGovernorVerify() },
        arbiterState: { available: true, result: makeArbiterReview({ decision: 'REJECT', status: 'FAIL' }) },
      },
      'harden-tokens-workspace-route',
    )

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Arbiter decision REJECT')
  })

  it('blocks when untracked intended test files exist and stage is not authorized', () => {
    const result = evaluateFinalizeState(
      makePacket(),
      {
        runnerState: {
          available: true,
          result: makeRunnerVerify({
            status: 'FAIL',
            verify: {
              ...makeRunnerVerify().verify,
              untracked_files: ['src/lib/__tests__/tokens-route-security.test.ts'],
              blocking_conditions: ['Untracked intended test files must be staged intentionally'],
            },
          }),
        },
        governorState: { available: true, result: makeGovernorVerify({ status: 'FAIL', decision: 'BLOCK_COMMIT' }) },
        arbiterState: {
          available: true,
          result: makeArbiterReview({
            authorization: {
              ...makeArbiterReview().authorization,
              stage_authorized: false,
              commit_authorized: false,
            },
          }),
        },
      },
      'harden-tokens-workspace-route',
    )

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Untracked intended test files')
  })

  it('stages exact approved files only when authorized', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    saveExecutionPacket(root, makePacket())

    const firstRunner = makeRunnerVerify()
    const secondRunner = makeRunnerVerify({
      verify: {
        ...makeRunnerVerify().verify,
        staged_files: [
          'src/app/api/tokens/route.ts',
          'src/lib/__tests__/tokens-route-security.test.ts',
        ],
        unstaged_files: [],
      },
    })
    const toolSequences = {
      runner: [firstRunner, secondRunner, makeRunnerVerify({
        repo: {
          branch: 'harden-tokens-workspace-route',
          head: 'def5678',
          working_tree_clean: true,
        },
        verify: {
          ...makeRunnerVerify().verify,
          changed_files: [],
          dirty_files: [],
          staged_files: [],
          unstaged_files: [],
        },
      })],
      governor: [makeGovernorVerify(), makeGovernorVerify({ decision: 'APPROVE_COMMIT' }), makeGovernorVerify({ status: 'WARN', decision: 'NO_CHANGES', verify_decision: { stage_files: [], commit_message: '', push_allowed: false, pr_allowed: false }, policy: { blocking_reasons: [], warnings: ['clean'] } })],
      arbiter: [makeArbiterReview(), makeArbiterReview(), makeArbiterReview({ status: 'WARN', decision: 'APPROVE_WITH_NOTES', authorization: { ...makeArbiterReview().authorization, stage_authorized: false, commit_authorized: false } })],
    }
    const apis = {
      runnerApi: { runVerifyMode: () => toolSequences.runner.shift() },
      governorApi: { runVerifyMode: () => toolSequences.governor.shift() },
      arbiterApi: { runReviewMode: () => toolSequences.arbiter.shift() },
    }
    const { runner, calls } = makeCommandRunner({
      'git branch --show-current': 'harden-tokens-workspace-route',
      'git add -- src/app/api/tokens/route.ts src/lib/__tests__/tokens-route-security.test.ts': '',
      'git commit -m Harden tokens workspace route': '',
      'git rev-parse --short HEAD': 'def5678',
    })

    const result = runFinalizeApprovedMode(root, {
      ...apis,
      commandRunner: runner,
      shellRunner: () => ({ ok: true, status: 0, stdout: '', stderr: '', error: '' }),
    })

    expect(result.decision).toBe('APPROVED_COMMITTED_READY_FOR_PR')
    expect(calls).toContain('git add -- src/app/api/tokens/route.ts src/lib/__tests__/tokens-route-security.test.ts')
  })

  it('never stages package or lockfiles', () => {
    expect(BLOCKED_STAGE_BASENAMES.has('pnpm-lock.yaml')).toBe(true)
    expect(BLOCKED_STAGE_BASENAMES.has('package-lock.json')).toBe(true)
  })

  it('never uses git add .', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    saveExecutionPacket(root, makePacket())
    const toolSequences = {
      runner: [makeRunnerVerify(), makeRunnerVerify({
        verify: {
          ...makeRunnerVerify().verify,
          staged_files: [
            'src/app/api/tokens/route.ts',
            'src/lib/__tests__/tokens-route-security.test.ts',
          ],
          unstaged_files: [],
        },
      }), makeRunnerVerify({
        repo: { branch: 'harden-tokens-workspace-route', head: 'def5678', working_tree_clean: true },
        verify: { ...makeRunnerVerify().verify, changed_files: [], dirty_files: [], staged_files: [], unstaged_files: [] },
      })],
      governor: [makeGovernorVerify(), makeGovernorVerify({ decision: 'APPROVE_COMMIT' }), makeGovernorVerify({ status: 'WARN', decision: 'NO_CHANGES', verify_decision: { stage_files: [], commit_message: '', push_allowed: false, pr_allowed: false }, policy: { blocking_reasons: [], warnings: [] } })],
      arbiter: [makeArbiterReview(), makeArbiterReview(), makeArbiterReview({ status: 'WARN', decision: 'APPROVE_WITH_NOTES', authorization: { ...makeArbiterReview().authorization, stage_authorized: false, commit_authorized: false } })],
    }
    const { runner, calls } = makeCommandRunner({
      'git branch --show-current': 'harden-tokens-workspace-route',
      'git add -- src/app/api/tokens/route.ts src/lib/__tests__/tokens-route-security.test.ts': '',
      'git commit -m Harden tokens workspace route': '',
      'git rev-parse --short HEAD': 'def5678',
    })

    runFinalizeApprovedMode(root, {
      runnerApi: { runVerifyMode: () => toolSequences.runner.shift() },
      governorApi: { runVerifyMode: () => toolSequences.governor.shift() },
      arbiterApi: { runReviewMode: () => toolSequences.arbiter.shift() },
      commandRunner: runner,
      shellRunner: () => ({ ok: true, status: 0, stdout: '', stderr: '', error: '' }),
    })

    expect(calls.some((call) => call.includes('git add .'))).toBe(false)
  })

  it('commits only when Arbiter commit_authorized is true', () => {
    const result = evaluateFinalizeState(
      makePacket(),
      {
        runnerState: { available: true, result: makeRunnerVerify({ verify: { ...makeRunnerVerify().verify, staged_files: ['src/app/api/tokens/route.ts'], unstaged_files: [] } }) },
        governorState: { available: true, result: makeGovernorVerify({ decision: 'APPROVE_COMMIT' }) },
        arbiterState: {
          available: true,
          result: makeArbiterReview({
            authorization: {
              ...makeArbiterReview().authorization,
              commit_authorized: false,
            },
          }),
        },
      },
      'harden-tokens-workspace-route',
    )

    expect(result.decision).toBe('BLOCKED')
    expect(result.blocking_reasons.join(' ')).toContain('Arbiter has not authorized commit')
  })

  it('stops before push or PR and outputs commands instead', () => {
    const packet = makePacket()
    expect(packet.push_command).toContain('git push -u origin harden-tokens-workspace-route')
    expect(packet.create_command).toContain('gh pr create')
  })

  it('handles clean already-committed branch as ready for PR', () => {
    const result = evaluateFinalizeState(
      makePacket(),
      {
        runnerState: {
          available: true,
          result: makeRunnerVerify({
            repo: {
              branch: 'harden-tokens-workspace-route',
              head: 'def5678',
              working_tree_clean: true,
            },
            verify: {
              ...makeRunnerVerify().verify,
              changed_files: [],
              dirty_files: [],
              staged_files: [],
              unstaged_files: [],
            },
          }),
        },
        governorState: { available: true, result: makeGovernorVerify({ status: 'WARN', decision: 'NO_CHANGES' }) },
        arbiterState: { available: true, result: makeArbiterReview({ status: 'WARN', decision: 'APPROVE_WITH_NOTES', authorization: { ...makeArbiterReview().authorization, stage_authorized: false, commit_authorized: false } }) },
      },
      'harden-tokens-workspace-route',
    )

    expect(result.decision).toBe('APPROVED_COMMITTED_READY_FOR_PR')
  })
})

describe('security executor general behavior', () => {
  it('output shape includes required fields', () => {
    const output = buildOutput('plan', {
      status: 'PASS',
      decision: 'READY_TO_EXECUTE',
      authority: {
        runner_status: 'PASS',
        governor_decision: 'APPROVE_IMPLEMENTATION_PROMPT',
        arbiter_decision: 'APPROVE_WITH_NOTES',
        stage_authorized: false,
        commit_authorized: false,
        push_authorized: false,
        pr_create_authorized: false,
      },
      scope: {
        branch: 'harden-tokens-workspace-route',
        approved_files: ['src/app/api/tokens/route.ts'],
        blocked_files: ['pnpm-lock.yaml'],
        changed_files: [],
        staged_files: [],
        untracked_files: [],
      },
      actions_taken: [],
      blocking_reasons: [],
      warnings: [],
      commit: { message: 'Harden tokens workspace route', hash: '' },
      pr: { title: 'Harden tokens workspace route', body: 'body', push_command: 'git push', create_command: 'gh pr create' },
      human_action: 'act',
    })

    expect(output.agent).toBe(AGENT)
    expect(output.scope.branch).toBe('harden-tokens-workspace-route')
    expect(output.pr.create_command).toContain('gh pr create')
  })

  it('executor remains non-remote-mutating', () => {
    const packet = makePacket()

    expect(packet.push_command).toContain('git push')
    expect(packet.create_command).toContain('gh pr create')
    expect(packet.create_command).not.toContain('gh pr merge')
  })

  it('push, PR, and merge are never executed in v1', () => {
    const root = makeTempRepo()
    tempRoots.push(root)
    saveExecutionPacket(root, makePacket())
    const toolSequences = {
      runner: [makeRunnerVerify({ repo: { branch: 'harden-tokens-workspace-route', head: 'def5678', working_tree_clean: true }, verify: { ...makeRunnerVerify().verify, changed_files: [], dirty_files: [], staged_files: [], unstaged_files: [] } })],
      governor: [makeGovernorVerify({ status: 'WARN', decision: 'NO_CHANGES' })],
      arbiter: [makeArbiterReview({ status: 'WARN', decision: 'APPROVE_WITH_NOTES', authorization: { ...makeArbiterReview().authorization, stage_authorized: false, commit_authorized: false } })],
    }
    const { runner, calls } = makeCommandRunner({
      'git branch --show-current': 'harden-tokens-workspace-route',
      'git rev-parse --short HEAD': 'def5678',
    })

    runFinalizeApprovedMode(root, {
      runnerApi: { runVerifyMode: () => toolSequences.runner.shift() },
      governorApi: { runVerifyMode: () => toolSequences.governor.shift() },
      arbiterApi: { runReviewMode: () => toolSequences.arbiter.shift() },
      commandRunner: runner,
    })

    expect(calls.some((call) => call.startsWith('gh '))).toBe(false)
    expect(calls.some((call) => call.includes('push'))).toBe(false)
    expect(calls.some((call) => call.includes('merge'))).toBe(false)
  })
})
