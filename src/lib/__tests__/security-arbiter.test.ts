import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  AGENT,
  PLAN_DECISIONS,
  REVIEW_DECISIONS,
  assessTestQuality,
  buildArbiterPrompt,
  buildOutput,
  evaluatePatchReview,
  evaluatePlanReview,
} = require('../../../scripts/security-arbiter.cjs')

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'security-arbiter-'))
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
      title: 'Harden gateways workspace route',
      branch: 'harden-gateways-workspace-route',
      risk: 'Critical',
      scope_files: ['src/app/api/gateways/route.ts'],
      why_next: 'Gateway route is the next smallest safe critical route.',
      excluded: [],
      implementation_prompt: 'runner prompt',
    },
    batch_planner: {
      next_strategy: 'single_route',
      why: 'Critical execution/control route remains.',
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
      target: 'src/app/api/gateways/route.ts',
      branch: 'harden-gateways-workspace-route',
      why: 'Critical execution/control route remains.',
    },
    policy: {
      allowed_files: [
        'src/app/api/gateways/route.ts',
        'src/lib/__tests__/gateways-route-security.test.ts',
      ],
      blocked_files: [
        'package-lock.json',
        'pnpm-lock.yaml',
        'src/app/api/tokens/route.ts',
        'src/app/api/tokens/by-agent/route.ts',
        'src/app/api/gateways/** (outside src/app/api/gateways/route.ts)',
      ],
      approval_gates: [],
      blocking_reasons: [],
      warnings: [],
    },
    implementation_prompt: [
      'STRICT SCOPE:',
      'BLOCKED FILES:',
      'do not use git add .',
      'do not push until approved',
      'do not create PR until approved',
      'node scripts/security-hardening-runner.cjs verify',
      'node scripts/security-governor.cjs verify',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm build',
    ].join('\n'),
    ...overrides,
  }
}

function makeRunnerVerify(overrides: Partial<any> = {}) {
  return {
    mode: 'verify',
    status: 'PASS',
    repo: {
      working_tree_clean: false,
    },
    verify: {
      changed_files: [
        'src/app/api/gateways/route.ts',
        'src/lib/__tests__/gateways-route-security.test.ts',
      ],
      untracked_files: [],
      dirty_files: [
        'src/app/api/gateways/route.ts',
        'src/lib/__tests__/gateways-route-security.test.ts',
      ],
      staged_files: [
        'src/app/api/gateways/route.ts',
        'src/lib/__tests__/gateways-route-security.test.ts',
      ],
      unstaged_files: [],
      blocking_conditions: [],
      warnings: [],
      fallback_regression: {
        passed: true,
        matches: [],
      },
      focused_tests: {
        found: ['src/lib/__tests__/gateways-route-security.test.ts'],
        missing: [],
        command: 'pnpm test -- src/lib/__tests__/gateways-route-security.test.ts',
      },
      stage_recommendation: {
        recommended: true,
        files: [
          'src/app/api/gateways/route.ts',
          'src/lib/__tests__/gateways-route-security.test.ts',
        ],
      },
      commit_recommendation: {
        recommended: true,
        message: 'Harden gateways workspace route',
      },
      classifications: {
        route_files: ['src/app/api/gateways/route.ts'],
        test_files: ['src/lib/__tests__/gateways-route-security.test.ts'],
        docs: [],
        scripts: [],
        package_files: [],
        lockfiles: [],
        unknown: [],
        route_families: ['gateways'],
      },
    },
    ...overrides,
  }
}

function makeGovernorVerify(overrides: Partial<any> = {}) {
  return {
    mode: 'verify',
    status: 'PASS',
    decision: 'APPROVE_COMMIT',
    policy: {
      blocking_reasons: [],
      warnings: [],
    },
    verify_decision: {
      stage_files: [
        'src/app/api/gateways/route.ts',
        'src/lib/__tests__/gateways-route-security.test.ts',
      ],
      commit_message: 'Harden gateways workspace route',
      push_allowed: false,
      pr_allowed: false,
    },
    ...overrides,
  }
}

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('security arbiter plan mode', () => {
  it('approves a clean Governor single-route Critical plan', () => {
    const result = evaluatePlanReview(makeGovernorPlan(), makeRunnerAudit())

    expect(result.decision).toBe('APPROVE_PLAN')
    expect(result.status).toBe('PASS')
    expect(result.authorization.plan_approved).toBe(true)
  })

  it('rejects gateway/control route batched with unrelated files', () => {
    const result = evaluatePlanReview(
      makeGovernorPlan({
        strategy: {
          next_strategy: 'route_family_batch',
          risk: 'Critical',
          target: 'mixed',
          branch: 'mixed',
          why: 'unsafe mix',
        },
        policy: {
          ...makeGovernorPlan().policy,
          allowed_files: [
            'src/app/api/gateways/route.ts',
            'src/app/api/projects/route.ts',
            'src/lib/__tests__/gateways-route-security.test.ts',
          ],
        },
      }),
      makeRunnerAudit({
        recommendation: {
          ...makeRunnerAudit().recommendation,
          scope_files: [
            'src/app/api/gateways/route.ts',
            'src/app/api/projects/route.ts',
          ],
        },
        batch_planner: {
          next_strategy: 'route_family_batch',
          why: 'unsafe batch',
          single_route_remaining_is_worth_it: false,
        },
      }),
    )

    expect(result.decision).toBe('REJECT_PLAN')
    expect(result.findings.blockers.join(' ')).toContain('Gateway/control or token routes were batched')
  })

  it('requests Governor correction when allowed files are too broad', () => {
    const result = evaluatePlanReview(
      makeGovernorPlan({
        policy: {
          ...makeGovernorPlan().policy,
          allowed_files: [
            'src/app/api/gateways/route.ts',
            'src/app/api/gateways/control/route.ts',
            'src/lib/__tests__/gateways-route-security.test.ts',
          ],
        },
      }),
      makeRunnerAudit(),
    )

    expect(result.decision).toBe('REQUEST_GOVERNOR_CORRECTION')
    expect(result.findings.major.join(' ')).toContain('Single-route plan must allow exactly one route file')
  })

  it('escalates to human when runner or governor output is malformed', () => {
    const result = evaluatePlanReview({ mode: 'plan' }, { mode: 'audit' })

    expect(result.decision).toBe('ESCALATE_TO_HUMAN')
    expect(result.status).toBe('FAIL')
  })

  it('verifies implementation prompt contains strict scope, blocked files, git discipline, runner verify, governor verify, and validation commands', () => {
    const prompt = buildArbiterPrompt(makeGovernorPlan())

    expect(prompt).toContain('STRICT SCOPE:')
    expect(prompt).toContain('EXACT BLOCKED FILES:')
    expect(prompt).toContain('do not use git add .')
    expect(prompt).toContain('do not push until approved')
    expect(prompt).toContain('node scripts/security-hardening-runner.cjs verify')
    expect(prompt).toContain('node scripts/security-governor.cjs verify')
    expect(prompt).toContain('pnpm typecheck')
  })
})

describe('security arbiter review mode', () => {
  it('approves clean patch when Runner/Governor verify pass and tests are meaningful', () => {
    const root = makeTempRoot()
    tempRoots.push(root)
    writeRepoFile(root, 'src/lib/__tests__/gateways-route-security.test.ts', [
      'denies unauthenticated access',
      'missing workspace context fails closed',
      'valid workspace still works',
      'cross-workspace access returns not found',
      'no workspace_id ?? 1 remains',
    ].join('\n'))

    const result = evaluatePatchReview(root, {
      runner_verify: makeRunnerVerify(),
      governor_verify: makeGovernorVerify(),
      git_diff: { available: true },
    })

    expect(result.decision).toBe('APPROVE')
    expect(result.authorization.commit_authorized).toBe(true)
    expect(result.final_release_gate.push_allowed).toBe(false)
  })

  it('requests corrections when tests are missing cross-workspace coverage', () => {
    const root = makeTempRoot()
    tempRoots.push(root)
    writeRepoFile(root, 'src/lib/__tests__/gateways-route-security.test.ts', [
      'denies unauthenticated access',
      'missing workspace context fails closed',
      'valid workspace still works',
      'no workspace_id ?? 1 remains',
    ].join('\n'))

    const result = evaluatePatchReview(root, {
      runner_verify: makeRunnerVerify(),
      governor_verify: makeGovernorVerify(),
      git_diff: { available: true },
    })

    expect(result.decision).toBe('REQUEST_CORRECTIONS')
    expect(result.feedback_for_implementer.join(' ')).toContain('cross-workspace denial')
  })

  it('rejects when fallback regression remains', () => {
    const result = evaluatePatchReview(makeTempRoot(), {
      runner_verify: makeRunnerVerify({
        status: 'FAIL',
        verify: {
          ...makeRunnerVerify().verify,
          fallback_regression: {
            passed: false,
            matches: [{ file: 'src/app/api/gateways/route.ts' }],
          },
          blocking_conditions: ['Fallback-to-1 pattern still present'],
        },
      }),
      governor_verify: makeGovernorVerify({
        status: 'FAIL',
        policy: {
          blocking_reasons: ['Fallback-to-1 pattern still present'],
          warnings: [],
        },
      }),
      git_diff: { available: true },
    })

    expect(result.decision).toBe('REJECT')
    expect(result.findings.blockers.join(' ')).toContain('Fallback regression')
  })

  it('rejects when package or lockfile drift exists', () => {
    const result = evaluatePatchReview(makeTempRoot(), {
      runner_verify: makeRunnerVerify({
        status: 'FAIL',
        verify: {
          ...makeRunnerVerify().verify,
          changed_files: ['pnpm-lock.yaml'],
          classifications: {
            ...makeRunnerVerify().verify.classifications,
            route_files: [],
            test_files: [],
            lockfiles: ['pnpm-lock.yaml'],
          },
          blocking_conditions: ['Lockfile drift detected: pnpm-lock.yaml'],
        },
      }),
      governor_verify: makeGovernorVerify({
        status: 'FAIL',
        policy: {
          blocking_reasons: ['Lockfile drift detected: pnpm-lock.yaml'],
          warnings: [],
        },
      }),
      git_diff: { available: true },
    })

    expect(result.decision).toBe('REJECT')
    expect(result.findings.blockers.join(' ')).toContain('Package or lockfile drift')
  })

  it('rejects when untracked intended test files exist', () => {
    const result = evaluatePatchReview(makeTempRoot(), {
      runner_verify: makeRunnerVerify({
        status: 'FAIL',
        verify: {
          ...makeRunnerVerify().verify,
          untracked_files: ['src/lib/__tests__/gateways-route-security.test.ts'],
          blocking_conditions: ['Untracked intended test files must be staged intentionally'],
        },
      }),
      governor_verify: makeGovernorVerify({
        status: 'FAIL',
        policy: {
          blocking_reasons: ['Untracked intended test files must be staged intentionally'],
          warnings: [],
        },
      }),
      git_diff: { available: true },
    })

    expect(result.decision).toBe('REJECT')
    expect(result.findings.blockers.join(' ')).toContain('Untracked intended test files')
  })

  it('rejects broad unrelated route changes', () => {
    const result = evaluatePatchReview(makeTempRoot(), {
      runner_verify: makeRunnerVerify({
        status: 'FAIL',
        verify: {
          ...makeRunnerVerify().verify,
          classifications: {
            ...makeRunnerVerify().verify.classifications,
            route_files: [
              'src/app/api/gateways/route.ts',
              'src/app/api/projects/route.ts',
            ],
            route_families: ['gateways', 'projects'],
          },
          blocking_conditions: ['Multiple unrelated route families changed'],
        },
      }),
      governor_verify: makeGovernorVerify({
        status: 'FAIL',
        policy: {
          blocking_reasons: ['Multiple unrelated route families changed'],
          warnings: [],
        },
      }),
      git_diff: { available: true },
    })

    expect(result.decision).toBe('REJECT')
    expect(result.findings.blockers.join(' ')).toContain('Broad unrelated route changes')
  })

  it('blocks push and pr for Critical routes even when commit is authorized', () => {
    const root = makeTempRoot()
    tempRoots.push(root)
    writeRepoFile(root, 'src/lib/__tests__/gateways-route-security.test.ts', [
      'denies unauthenticated access',
      'missing workspace context fails closed',
      'valid workspace still works',
      'cross-workspace access returns not found',
      'no workspace_id ?? 1 remains',
    ].join('\n'))

    const result = evaluatePatchReview(root, {
      runner_verify: makeRunnerVerify(),
      governor_verify: makeGovernorVerify(),
      git_diff: { available: true },
    })

    expect(result.authorization.commit_authorized).toBe(true)
    expect(result.authorization.push_authorized).toBe(false)
    expect(result.authorization.pr_create_authorized).toBe(false)
  })

  it('allows pr-create authorization only for low-risk tooling and test-only work', () => {
    const result = evaluatePatchReview(makeTempRoot(), {
      runner_verify: makeRunnerVerify({
        verify: {
          ...makeRunnerVerify().verify,
          changed_files: [
            'scripts/security-arbiter.cjs',
            'src/lib/__tests__/security-arbiter.test.ts',
          ],
          staged_files: [
            'scripts/security-arbiter.cjs',
            'src/lib/__tests__/security-arbiter.test.ts',
          ],
          classifications: {
            route_files: [],
            test_files: ['src/lib/__tests__/security-arbiter.test.ts'],
            docs: [],
            scripts: ['scripts/security-arbiter.cjs'],
            package_files: [],
            lockfiles: [],
            unknown: [],
            route_families: [],
          },
          focused_tests: {
            found: [],
            missing: [],
            command: '',
          },
          commit_recommendation: {
            recommended: true,
            message: 'Add security arbiter v1',
          },
        },
      }),
      governor_verify: makeGovernorVerify({
        verify_decision: {
          stage_files: [
            'scripts/security-arbiter.cjs',
            'src/lib/__tests__/security-arbiter.test.ts',
          ],
          commit_message: 'Add security arbiter v1',
          push_allowed: false,
          pr_allowed: false,
        },
      }),
      git_diff: { available: true },
    })

    expect(result.authorization.push_authorized).toBe(true)
    expect(result.authorization.pr_create_authorized).toBe(true)
    expect(result.final_release_gate.pr_allowed).toBe(true)
  })

  it('produces feedback for governor and implementer', () => {
    const root = makeTempRoot()
    tempRoots.push(root)
    writeRepoFile(root, 'src/lib/__tests__/gateways-route-security.test.ts', 'denies unauthenticated access')

    const result = evaluatePatchReview(root, {
      runner_verify: makeRunnerVerify(),
      governor_verify: makeGovernorVerify({
        decision: 'APPROVE_STAGE',
      }),
      git_diff: { available: true },
    })

    expect(result.feedback_for_governor.length).toBeGreaterThan(0)
    expect(result.feedback_for_implementer.length).toBeGreaterThan(0)
  })

  it('output shape includes authorization and final release gate', () => {
    const output = buildOutput('review', {
      status: 'PASS',
      decision: 'APPROVE',
      confidence: 'high',
      risk: 'Low',
      summary: 'ok',
      inputs: {
        runner_available: true,
        governor_available: true,
        git_diff_available: true,
      },
      authorization: {
        plan_approved: true,
        implementation_approved: true,
        stage_authorized: true,
        commit_authorized: true,
        push_authorized: false,
        pr_create_authorized: false,
        merge_authorized: false,
        human_required: [],
      },
      final_release_gate: {
        stage_allowed: true,
        commit_allowed: true,
        push_allowed: false,
        pr_allowed: false,
        merge_recommended: false,
      },
      human_action: 'act',
    })

    expect(output.agent).toBe(AGENT)
    expect(output.authorization.commit_authorized).toBe(true)
    expect(output.final_release_gate.merge_recommended).toBe(false)
  })
})

describe('security arbiter general behavior', () => {
  it('remains non-mutating by design', () => {
    const prompt = buildArbiterPrompt(makeGovernorPlan())

    expect(prompt).toContain('do not use git add .')
    expect(prompt).toContain('do not push until approved')
    expect(prompt).toContain('do not create PR until approved')
  })

  it('decision enums are stable', () => {
    expect([...PLAN_DECISIONS]).toEqual([
      'APPROVE_PLAN',
      'APPROVE_WITH_NOTES',
      'REQUEST_GOVERNOR_CORRECTION',
      'REJECT_PLAN',
      'ESCALATE_TO_HUMAN',
    ])
    expect([...REVIEW_DECISIONS]).toEqual([
      'APPROVE',
      'APPROVE_WITH_NOTES',
      'REQUEST_CORRECTIONS',
      'REJECT',
      'ESCALATE_TO_HUMAN',
    ])
  })

  it('human action is always explicit', () => {
    const result = evaluatePlanReview(makeGovernorPlan(), makeRunnerAudit())

    expect(result.human_action.length).toBeGreaterThan(0)
  })

  it('test quality helper detects complete route coverage', () => {
    const quality = assessTestQuality(
      ['src/app/api/gateways/route.ts'],
      ['src/lib/__tests__/gateways-route-security.test.ts'],
      () => [
        'denies unauthenticated access',
        'missing workspace context fails closed',
        'valid workspace still works',
        'cross-workspace access returns not found',
        'no workspace_id ?? 1 remains',
      ].join('\n'),
    )

    expect(quality.meaningful).toBe(true)
    expect(quality.missing).toEqual([])
  })
})
