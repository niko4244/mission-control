import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  AGENT,
  DECISIONS,
  buildOutput,
  candidateScopeIsMixed,
  evaluatePlanPolicy,
  evaluateVerifyPolicy,
  generateImplementationPrompt,
  parseRunnerJson,
  runPlanMode,
  runVerifyMode,
} = require('../../../scripts/security-governor.cjs')

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'security-governor-'))
}

function makeAuditResult(overrides: Partial<any> = {}) {
  return {
    mode: 'audit',
    status: 'PASS',
    repo: {
      branch: 'main',
      head: '15e73f7',
      working_tree_clean: true,
    },
    recommendation: {
      title: 'Harden gateways workspace route',
      branch: 'harden-gateways-workspace-route',
      risk: 'Critical',
      scope_files: ['src/app/api/gateways/route.ts'],
      why_next: 'Gateway route is the next smallest safe critical route.',
      excluded: [
        'Excluded src/app/api/tokens/route.ts: keep this PR narrower than the separate tokens Critical surface.',
        'Excluded src/app/api/tokens/by-agent/route.ts: keep this PR narrower than the separate tokens Critical surface.',
      ],
      implementation_prompt: 'runner prompt',
    },
    batch_planner: {
      enabled: true,
      next_strategy: 'single_route',
      why: 'Critical execution/credential/control routes still remain.',
      single_route_remaining_is_worth_it: true,
      risk_summary: {
        Critical: 3,
        High: 19,
        Medium: 28,
        Low: 0,
      },
      family_summary: [],
      batch_candidates: [],
      ci_guard_recommendation: {
        recommended: false,
        why: 'Wait until the fallback count drops further.',
      },
    },
    ...overrides,
  }
}

function makeVerifyResult(overrides: Partial<any> = {}) {
  return {
    mode: 'verify',
    status: 'PASS',
    repo: {
      branch: 'feature/gateways',
      head: 'abc1234',
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
      staged_files: [],
      unstaged_files: [
        'src/app/api/gateways/route.ts',
        'src/lib/__tests__/gateways-route-security.test.ts',
      ],
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
      push_recommendation: {
        recommended: false,
      },
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

describe('security governor plan mode', () => {
  it('parses runner audit output', () => {
    const parsed = parseRunnerJson(`${JSON.stringify(makeAuditResult(), null, 2)}\n\nsummary\n`)

    expect(parsed.mode).toBe('audit')
    expect(parsed.recommendation.scope_files).toEqual(['src/app/api/gateways/route.ts'])
  })

  it('approves single_route Critical recommendation with one scope file', () => {
    const result = evaluatePlanPolicy(makeAuditResult())

    expect(result.decision).toBe(DECISIONS.APPROVE_IMPLEMENTATION_PROMPT)
    expect(result.status).toBe('PASS')
    expect(result.strategy.next_strategy).toBe('single_route')
    expect(result.strategy.target).toBe('src/app/api/gateways/route.ts')
  })

  it('produces allowed file list including route and focused test', () => {
    const result = evaluatePlanPolicy(makeAuditResult())

    expect(result.policy.allowed_files).toContain('src/app/api/gateways/route.ts')
    expect(result.policy.allowed_files).toContain('src/lib/__tests__/gateways-route-security.test.ts')
  })

  it('produces blocked file list excluding unrelated tokens, workflows, and package lockfiles', () => {
    const result = evaluatePlanPolicy(makeAuditResult())

    expect(result.policy.blocked_files).toContain('src/app/api/tokens/route.ts')
    expect(result.policy.blocked_files).toContain('src/app/api/tokens/by-agent/route.ts')
    expect(result.policy.blocked_files).toContain('src/app/api/workflows/**')
    expect(result.policy.blocked_files).toContain('pnpm-lock.yaml')
  })

  it('generates implementation prompt with scope, blocked files, git discipline, and runner verify command', () => {
    const result = evaluatePlanPolicy(makeAuditResult())
    const prompt = generateImplementationPrompt({
      strategy: result.strategy,
      policy: result.policy,
    })

    expect(prompt).toContain('src/app/api/gateways/route.ts')
    expect(prompt).toContain('src/app/api/tokens/route.ts')
    expect(prompt).toContain('do not use git add .')
    expect(prompt).toContain('do not push until approved')
    expect(prompt).toContain('do not create PR until approved')
    expect(prompt).toContain('node scripts/security-hardening-runner.cjs verify')
  })

  it('blocks unsafe batch containing gateway/control plus unrelated files', () => {
    const result = evaluatePlanPolicy(makeAuditResult({
      recommendation: {
        title: 'Harden mixed batch',
        branch: 'harden-mixed-batch',
        risk: 'Critical',
        scope_files: [
          'src/app/api/gateways/route.ts',
          'src/app/api/projects/route.ts',
        ],
        why_next: 'unsafe mixed batch',
        excluded: [],
        implementation_prompt: '',
      },
      batch_planner: {
        enabled: true,
        next_strategy: 'route_family_batch',
        why: 'batch it',
        single_route_remaining_is_worth_it: false,
        risk_summary: {
          Critical: 1,
          High: 1,
          Medium: 0,
          Low: 0,
        },
        family_summary: [],
        batch_candidates: [
          {
            title: 'Harden mixed batch',
            branch: 'harden-mixed-batch',
            family: 'mixed',
            risk: 'Critical',
            scope_files: [
              'src/app/api/gateways/route.ts',
              'src/app/api/projects/route.ts',
            ],
            excluded: [],
            safe_to_batch: true,
            why_next: 'unsafe mixed batch',
            implementation_prompt: '',
          },
        ],
        ci_guard_recommendation: {
          recommended: false,
          why: '',
        },
      },
    }))

    expect(result.decision).toBe(DECISIONS.BLOCK_UNSAFE_SCOPE)
    expect(result.policy.blocking_reasons.join(' ')).toContain('Blocked mixed batch scope')
  })

  it('holds for manual review when runner output is malformed', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const result = runPlanMode(root, {
      runnerApi: {
        runAuditMode: () => ({ mode: 'audit', status: 'PASS' }),
      },
    })

    expect(result.decision).toBe(DECISIONS.HOLD_FOR_MANUAL_REVIEW)
    expect(result.status).toBe('FAIL')
  })

  it('recommends tooling or ci when runner strategy says tooling_or_ci', () => {
    const result = evaluatePlanPolicy(makeAuditResult({
      recommendation: {
        title: 'Add CI guard',
        branch: 'add-ci-guard',
        risk: 'Low',
        scope_files: [],
        why_next: 'prefer tooling',
        excluded: [],
        implementation_prompt: '',
      },
      batch_planner: {
        enabled: true,
        next_strategy: 'tooling_or_ci',
        why: 'Prefer CI guard now.',
        single_route_remaining_is_worth_it: false,
        risk_summary: {
          Critical: 0,
          High: 0,
          Medium: 12,
          Low: 1,
        },
        family_summary: [],
        batch_candidates: [],
        ci_guard_recommendation: {
          recommended: true,
          why: 'Block new fallback-to-1 regressions.',
        },
      },
    }))

    expect(result.decision).toBe(DECISIONS.RECOMMEND_TOOLING_OR_CI)
    expect(result.status).toBe('PASS')
  })
})

describe('security governor verify mode', () => {
  it('blocks commit when runner verify status is FAIL', () => {
    const result = evaluateVerifyPolicy(makeVerifyResult({ status: 'FAIL' }))

    expect(result.decision).toBe(DECISIONS.BLOCK_COMMIT)
    expect(result.status).toBe('FAIL')
  })

  it('blocks commit when untracked intended test file exists', () => {
    const result = evaluateVerifyPolicy(makeVerifyResult({
      status: 'FAIL',
      verify: {
        ...makeVerifyResult().verify,
        untracked_files: ['src/lib/__tests__/gateways-route-security.test.ts'],
        blocking_conditions: [
          'Untracked intended test files must be staged intentionally: src/lib/__tests__/gateways-route-security.test.ts',
        ],
      },
    }))

    expect(result.decision).toBe(DECISIONS.BLOCK_COMMIT)
    expect(result.policy.blocking_reasons.join(' ')).toContain('Untracked intended test files')
  })

  it('blocks commit on package lockfile drift', () => {
    const result = evaluateVerifyPolicy(makeVerifyResult({
      status: 'FAIL',
      verify: {
        ...makeVerifyResult().verify,
        changed_files: ['pnpm-lock.yaml'],
        classifications: {
          ...makeVerifyResult().verify.classifications,
          route_files: [],
          test_files: [],
          lockfiles: ['pnpm-lock.yaml'],
        },
        blocking_conditions: ['Lockfile drift detected: pnpm-lock.yaml'],
      },
    }))

    expect(result.decision).toBe(DECISIONS.BLOCK_COMMIT)
    expect(result.policy.blocking_reasons.join(' ')).toContain('Lockfile drift')
  })

  it('approves stage when runner verify passes and safe unstaged files are present', () => {
    const result = evaluateVerifyPolicy(makeVerifyResult())

    expect(result.decision).toBe(DECISIONS.APPROVE_STAGE)
    expect(result.status).toBe('PASS')
    expect(result.verify_decision.stage_files).toEqual([
      'src/app/api/gateways/route.ts',
      'src/lib/__tests__/gateways-route-security.test.ts',
    ])
  })

  it('approves commit when runner verify passes and files are staged safely', () => {
    const staged = makeVerifyResult({
      verify: {
        ...makeVerifyResult().verify,
        staged_files: [
          'src/app/api/gateways/route.ts',
          'src/lib/__tests__/gateways-route-security.test.ts',
        ],
        unstaged_files: [],
        dirty_files: [
          'src/app/api/gateways/route.ts',
          'src/lib/__tests__/gateways-route-security.test.ts',
        ],
      },
    })
    const result = evaluateVerifyPolicy(staged)

    expect(result.decision).toBe(DECISIONS.APPROVE_COMMIT)
    expect(result.verify_decision.commit_message).toBe('Harden gateways workspace route')
  })

  it('returns NO_CHANGES when branch is clean', () => {
    const result = evaluateVerifyPolicy(makeVerifyResult({
      repo: {
        branch: 'feature/gateways',
        head: 'abc1234',
        working_tree_clean: true,
      },
      verify: {
        ...makeVerifyResult().verify,
        changed_files: [],
        dirty_files: [],
        staged_files: [],
        unstaged_files: [],
      },
    }))

    expect(result.decision).toBe(DECISIONS.NO_CHANGES)
    expect(result.status).toBe('WARN')
  })

  it('never allows push or pr in v1', () => {
    const result = evaluateVerifyPolicy(makeVerifyResult())

    expect(result.verify_decision.push_allowed).toBe(false)
    expect(result.verify_decision.pr_allowed).toBe(false)
  })
})

describe('security governor general behavior', () => {
  it('output shape includes required fields', () => {
    const output = buildOutput('plan', {
      status: 'PASS',
      decision: DECISIONS.APPROVE_IMPLEMENTATION_PROMPT,
      runner: {
        available: true,
        mode: 'audit',
        status: 'PASS',
      },
      strategy: {
        next_strategy: 'single_route',
        risk: 'Critical',
        target: 'src/app/api/gateways/route.ts',
        branch: 'harden-gateways-workspace-route',
        why: 'why',
      },
      policy: {
        allowed_files: ['src/app/api/gateways/route.ts'],
        blocked_files: ['pnpm-lock.yaml'],
        approval_gates: ['gate'],
        blocking_reasons: [],
        warnings: [],
      },
      implementation_prompt: 'prompt',
      verify_decision: {
        stage_files: [],
        commit_message: '',
        push_allowed: false,
        pr_allowed: false,
      },
      human_action: 'act',
      summary: 'summary',
    })

    expect(output.agent).toBe(AGENT)
    expect(output.policy.allowed_files).toEqual(['src/app/api/gateways/route.ts'])
    expect(output.verify_decision.push_allowed).toBe(false)
  })

  it('governor remains non-mutating by design', () => {
    const plan = evaluatePlanPolicy(makeAuditResult())
    const verify = evaluateVerifyPolicy(makeVerifyResult())

    expect(plan.implementation_prompt).toContain('do not use git add .')
    expect(verify.verify_decision.push_allowed).toBe(false)
    expect(verify.verify_decision.pr_allowed).toBe(false)
  })

  it('route-family helper flags mixed gateway batch scope', () => {
    expect(candidateScopeIsMixed({
      scope_files: [
        'src/app/api/gateways/route.ts',
        'src/app/api/projects/route.ts',
      ],
    })).toBe(true)
  })
})
