import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  assessBatchCandidate,
  buildBatchPlanner,
  buildFamilySummary,
  buildOutput,
  chooseNextRecommendation,
  classifyRouteRisk,
  determineNextStrategy,
  findWorkspacePatterns,
  generateImplementationPrompt,
  runAuditMode,
  runVerifyMode,
  scanFiles,
  summarizeRiskBuckets,
  topFamiliesByFallback,
  verifyCurrentBranchState,
} = require('../../../scripts/security-hardening-runner.cjs')

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-hardening-runner-'))
  fs.mkdirSync(path.join(root, 'src', 'app', 'api'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'lib', '__tests__'), { recursive: true })
  return root
}

function writeRepoFile(root: string, relativePath: string, contents: string) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

function fakeGitRunner(overrides: Partial<{
  branch: string
  status: string
  head: string
  originMain: string
  localMain: string
  aheadBehind: string
}> = {}) {
  const values = {
    branch: 'security-hardening-check',
    status: '',
    head: 'abc1234',
    originMain: '5eab10d',
    localMain: '5eab10d',
    aheadBehind: '0\t0',
    ...overrides,
  }

  return (_command: string, args: string[]) => {
    const key = args.join(' ')
    const map: Record<string, string> = {
      'branch --show-current': values.branch,
      'status --short': values.status,
      'rev-parse --short HEAD': values.head,
      'rev-parse --short origin/main': values.originMain,
      'rev-parse --short main': values.localMain,
      'rev-list --left-right --count HEAD...origin/main': values.aheadBehind,
    }

    if (!(key in map)) {
      return { ok: false, status: 1, stdout: '', stderr: `Unexpected git call: ${key}`, error: '' }
    }

    return { ok: true, status: 0, stdout: map[key], stderr: '', error: '' }
  }
}

function routeSource(methods: string[], body = 'const workspaceId = auth.user.workspace_id ?? 1\nreturn NextResponse.json({ workspaceId })') {
  return [
    `import { NextRequest, NextResponse } from 'next/server'`,
    ...methods.map((method) => `export async function ${method}(request: NextRequest) {\n${body}\n}`),
    '',
  ].join('\n')
}

function makeFinding(overrides: Partial<{
  file: string
  family: string
  methods: string[]
  line_count: number
  match_count: number
  fallback_count: number
  workspace_reference_count: number
  patterns: string[]
  matches: Array<{ label: string, kind: string, match: string, line: number, snippet: string }>
  risk: string
  risk_level: number
  risk_reason: string
  priority_score: number
}> = {}) {
  return {
    file: 'src/app/api/workflows/route.ts',
    family: 'workflows',
    methods: ['GET', 'POST'],
    line_count: 64,
    match_count: 2,
    fallback_count: 1,
    workspace_reference_count: 1,
    patterns: ['workspace_id ?? 1', 'auth.user.workspace_id'],
    matches: [
      {
        label: 'workspace_id ?? 1',
        kind: 'fallback_to_one',
        match: 'workspace_id ?? 1',
        line: 12,
        snippet: 'const workspaceId = auth.user.workspace_id ?? 1',
      },
      {
        label: 'auth.user.workspace_id',
        kind: 'workspace_reference',
        match: 'auth.user.workspace_id',
        line: 12,
        snippet: 'const workspaceId = auth.user.workspace_id ?? 1',
      },
    ],
    risk: 'High',
    risk_level: 2,
    risk_reason: 'workflow or pipeline route',
    priority_score: 79,
    ...overrides,
  }
}

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('security hardening runner audit helpers', () => {
  it('finds fallback-to-1 patterns', () => {
    const matches = findWorkspacePatterns('const workspaceId = auth.user.workspace_id ?? 1')

    expect(matches.some((match: { label: string }) => match.label === 'workspace_id ?? 1')).toBe(true)
    expect(matches.some((match: { label: string }) => match.label === 'auth.user.workspace_id')).toBe(true)
  })

  it('distinguishes route files from tests and non-route files', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    writeRepoFile(root, 'src/app/api/agents/route.ts', routeSource(['GET']))
    writeRepoFile(root, 'src/app/api/helpers.ts', 'export const workspaceId = 1\n')
    writeRepoFile(root, 'src/app/api/__tests__/agents.test.ts', 'it("works", () => {})\n')

    const result = scanFiles(root)

    expect(result.file_counts.route).toBe(1)
    expect(result.file_counts.test).toBe(1)
    expect(result.file_counts['non-route']).toBe(1)
  })

  it('classifies credential and key routes as Critical', () => {
    const risk = classifyRouteRisk(
      'src/app/api/agents/[id]/keys/route.ts',
      ['GET', 'POST'],
      findWorkspacePatterns('const workspaceId = auth.user.workspace_id ?? 1'),
    )

    expect(risk.risk).toBe('Critical')
  })

  it('classifies delivery and run routes as Critical or High', () => {
    const deliveryRisk = classifyRouteRisk(
      'src/app/api/notifications/deliver/route.ts',
      ['POST'],
      findWorkspacePatterns('const workspaceId = auth.user.workspace_id ?? 1'),
    )
    const runRisk = classifyRouteRisk(
      'src/app/api/v1/runs/route.ts',
      ['GET', 'POST'],
      findWorkspacePatterns('const workspaceId = auth.user.workspace_id ?? 1'),
    )

    expect(['Critical', 'High']).toContain(deliveryRisk.risk)
    expect(['Critical', 'High']).toContain(runRisk.risk)
  })

  it('recommends one smallest safe PR scope instead of repo-wide cleanup', () => {
    const recommendation = chooseNextRecommendation({
      route_findings: [
        {
          file: 'src/app/api/v1/runs/route.ts',
          family: 'v1/runs',
          fallback_count: 1,
          line_count: 74,
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'execution/run route',
          priority_score: 99,
        },
        {
          file: 'src/app/api/tokens/route.ts',
          family: 'tokens',
          fallback_count: 2,
          line_count: 617,
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'credential/key/token route',
          priority_score: 96,
        },
      ],
    })

    expect(recommendation.scope_files).toEqual(['src/app/api/v1/runs/route.ts'])
    expect(recommendation.excluded.join(' ')).toContain('keep this PR narrower')
    expect(recommendation.why_next).toContain('smallest safe next PR')
  })

  it('generated implementation prompt preserves the git discipline and validation commands', () => {
    const prompt = generateImplementationPrompt({
      branch: 'harden-v1-runs-workspace-route',
      scope_files: ['src/app/api/v1/runs/route.ts'],
    }, {
      strategy: 'single_route',
      routeFile: 'src/app/api/v1/runs/route.ts',
      focusedTests: ['src/lib/__tests__/v1-runs-route-security.test.ts'],
    })

    expect(prompt).toContain('do not use git add .')
    expect(prompt).toContain('do not push until approved')
    expect(prompt).toContain('do not create PR until approved')
    expect(prompt).toContain('pnpm typecheck')
    expect(prompt).toContain('rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1|auth\\.user\\.workspace_id|user\\.workspace_id|currentUser\\.workspace_id"')
  })
})

describe('security hardening runner batch planner', () => {
  it('groups files by route family', () => {
    const summary = buildFamilySummary({
      route_findings: [
        makeFinding({
          file: 'src/app/api/v1/runs/[run_id]/route.ts',
          family: 'v1/runs',
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'execution/run route',
        }),
        makeFinding({
          file: 'src/app/api/v1/runs/[run_id]/eval/route.ts',
          family: 'v1/runs',
          methods: ['PUT'],
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'execution/run route',
        }),
        makeFinding({
          file: 'src/app/api/tokens/by-agent/route.ts',
          family: 'tokens',
          methods: ['GET'],
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'credential/key/token route',
        }),
      ],
    })

    expect(summary.map((item: { family: string }) => item.family)).toEqual(['v1/runs', 'tokens'])
    expect(summary[0].route_files).toEqual([
      'src/app/api/v1/runs/[run_id]/route.ts',
      'src/app/api/v1/runs/[run_id]/eval/route.ts',
    ])
  })

  it('produces risk bucket summary', () => {
    const summary = summarizeRiskBuckets([
      makeFinding({ risk: 'Critical', risk_level: 3 }),
      makeFinding({ risk: 'High', risk_level: 2 }),
      makeFinding({ risk: 'Medium', risk_level: 1 }),
      makeFinding({ risk: 'Low', risk_level: 0 }),
    ])

    expect(summary).toEqual({
      Critical: 1,
      High: 1,
      Medium: 1,
      Low: 1,
    })
  })

  it('identifies top route families by fallback count', () => {
    const familySummary = [
      {
        family: 'tokens',
        risk: 'Critical',
        fallback_to_one_findings: 3,
        route_count: 2,
      },
      {
        family: 'workflows',
        risk: 'High',
        fallback_to_one_findings: 2,
        route_count: 2,
      },
      {
        family: 'requests',
        risk: 'Medium',
        fallback_to_one_findings: 1,
        route_count: 1,
      },
    ]

    expect(topFamiliesByFallback(familySummary as any)).toEqual([
      { family: 'tokens', risk: 'Critical', fallback_to_one_findings: 3, route_count: 2 },
      { family: 'workflows', risk: 'High', fallback_to_one_findings: 2, route_count: 2 },
      { family: 'requests', risk: 'Medium', fallback_to_one_findings: 1, route_count: 1 },
    ])
  })

  it('recommends single_route when a Critical execution route remains', () => {
    const recommendation = chooseNextRecommendation({
      route_findings: [
        makeFinding({
          file: 'src/app/api/v1/runs/[run_id]/eval/route.ts',
          family: 'v1/runs',
          methods: ['PUT'],
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'execution/run route',
          line_count: 39,
        }),
      ],
    })
    const planner = buildBatchPlanner({
      total_findings: 2,
      fallback_to_one_findings: 1,
      route_findings: [
        makeFinding({
          file: 'src/app/api/v1/runs/[run_id]/eval/route.ts',
          family: 'v1/runs',
          methods: ['PUT'],
          risk: 'Critical',
          risk_level: 3,
          risk_reason: 'execution/run route',
          line_count: 39,
        }),
      ],
    }, recommendation)

    expect(planner.next_strategy).toBe('single_route')
    expect(planner.single_route_remaining_is_worth_it).toBe(true)
  })

  it('recommends route_family_batch when multiple related High routes remain and no Critical route blocks', () => {
    const scanResults = {
      total_findings: 6,
      fallback_to_one_findings: 3,
      route_findings: [
        makeFinding({
          file: 'src/app/api/workflows/route.ts',
          family: 'workflows',
          risk: 'High',
          risk_level: 2,
          line_count: 96,
        }),
        makeFinding({
          file: 'src/app/api/workflows/[id]/route.ts',
          family: 'workflows',
          methods: ['GET', 'PATCH'],
          risk: 'High',
          risk_level: 2,
          line_count: 82,
        }),
      ],
    }
    const planner = buildBatchPlanner(scanResults as any, chooseNextRecommendation(scanResults as any))

    expect(planner.next_strategy).toBe('route_family_batch')
    expect(planner.batch_candidates[0].family).toBe('workflows')
  })

  it('refuses to batch unrelated domains', () => {
    const result = assessBatchCandidate([
      makeFinding({ file: 'src/app/api/workflows/route.ts', family: 'workflows' }),
      makeFinding({ file: 'src/app/api/projects/route.ts', family: 'projects' }),
    ])

    expect(result.safe_to_batch).toBe(false)
    expect(result.why).toContain('unrelated route families')
  })

  it('refuses to batch gateway/control routes with unrelated routes', () => {
    const result = assessBatchCandidate([
      makeFinding({
        file: 'src/app/api/gateways/route.ts',
        family: 'gateways',
        risk: 'Critical',
        risk_level: 3,
        risk_reason: 'gateway/terminal/control-adjacent route',
      }),
      makeFinding({
        file: 'src/app/api/gateways/control/route.ts',
        family: 'gateways',
        methods: ['POST'],
        risk: 'Critical',
        risk_level: 3,
        risk_reason: 'gateway/terminal/control-adjacent route',
      }),
    ])

    expect(result.safe_to_batch).toBe(false)
    expect(result.why).toContain('Gateway/control-adjacent')
  })

  it('allows a small tightly related family batch', () => {
    const result = assessBatchCandidate([
      makeFinding({
        file: 'src/app/api/workflows/route.ts',
        family: 'workflows',
        risk: 'High',
        risk_level: 2,
        line_count: 84,
      }),
      makeFinding({
        file: 'src/app/api/workflows/[id]/route.ts',
        family: 'workflows',
        methods: ['GET', 'PATCH'],
        risk: 'High',
        risk_level: 2,
        line_count: 72,
      }),
    ])

    expect(result.safe_to_batch).toBe(true)
  })

  it('generated grouped prompt includes included files, exclusions, git discipline, verify command, and fallback search', () => {
    const prompt = generateImplementationPrompt({
      branch: 'harden-workflows-workspace-routes',
      scope_files: [
        'src/app/api/workflows/route.ts',
        'src/app/api/workflows/[id]/route.ts',
      ],
      excluded: ['src/app/api/projects/route.ts'],
    }, {
      strategy: 'route_family_batch',
      family: 'workflows',
      routeFiles: [
        'src/app/api/workflows/route.ts',
        'src/app/api/workflows/[id]/route.ts',
      ],
      excludedFiles: ['src/app/api/projects/route.ts'],
      focusedTests: ['src/lib/__tests__/workflows-route-security.test.ts'],
    })

    expect(prompt).toContain('exact included route files: src/app/api/workflows/route.ts, src/app/api/workflows/[id]/route.ts')
    expect(prompt).toContain('exact excluded files: src/app/api/projects/route.ts')
    expect(prompt).toContain('do not use git add .')
    expect(prompt).toContain('do not push until approved')
    expect(prompt).toContain('node scripts/security-hardening-runner.cjs verify')
    expect(prompt).toContain('rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1" src/app/api/workflows/route.ts src/app/api/workflows/[id]/route.ts')
  })

  it('emits a CI guard recommendation when direct fallback hits are low enough', () => {
    const planner = buildBatchPlanner({
      total_findings: 20,
      fallback_to_one_findings: 3,
      route_findings: [
        makeFinding({
          file: 'src/app/api/events/route.ts',
          family: 'unknown',
          methods: ['GET'],
          risk: 'Medium',
          risk_level: 1,
          risk_reason: 'read-only workspace-scoped API route',
        }),
      ],
    } as any, chooseNextRecommendation({
      route_findings: [
        makeFinding({
          file: 'src/app/api/events/route.ts',
          family: 'unknown',
          methods: ['GET'],
          risk: 'Medium',
          risk_level: 1,
          risk_reason: 'read-only workspace-scoped API route',
        }),
      ],
    } as any))

    expect(planner.ci_guard_recommendation.recommended).toBe(true)
    expect(planner.ci_guard_recommendation.why).toContain('workspace_id ?? 1')
  })
})

describe('security hardening runner verify helpers', () => {
  it('detects dirty main as blocking', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const result = verifyCurrentBranchState(root, {
      branch: 'main',
      head: 'abc1234',
      origin_main: '5eab10d',
      working_tree_clean: false,
      is_main: true,
      dirty_files: ['src/app/api/v1/runs/route.ts'],
      untracked_files: [],
      staged_files: [],
      unstaged_files: ['src/app/api/v1/runs/route.ts'],
    })

    expect(result.blocking_conditions).toContain('Running on main with dirty files is not allowed.')
  })

  it('detects untracked intended test files as blocking', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    writeRepoFile(root, 'src/app/api/pipelines/run/route.ts', routeSource(['GET'], 'return NextResponse.json({ ok: true })'))

    const result = verifyCurrentBranchState(root, {
      branch: 'feature/pipelines',
      head: 'abc1234',
      origin_main: '5eab10d',
      working_tree_clean: false,
      is_main: false,
      dirty_files: [
        'src/app/api/pipelines/run/route.ts',
        'src/lib/__tests__/pipeline-run-route-security.test.ts',
      ],
      untracked_files: ['src/lib/__tests__/pipeline-run-route-security.test.ts'],
      staged_files: [],
      unstaged_files: [
        'src/app/api/pipelines/run/route.ts',
        'src/lib/__tests__/pipeline-run-route-security.test.ts',
      ],
    })

    expect(result.blocking_conditions.join(' ')).toContain('Untracked intended test files must be staged intentionally')
  })

  it('detects package lockfile drift as blocking', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const result = verifyCurrentBranchState(root, {
      branch: 'feature/route-hardening',
      head: 'abc1234',
      origin_main: '5eab10d',
      working_tree_clean: false,
      is_main: false,
      dirty_files: ['pnpm-lock.yaml'],
      untracked_files: [],
      staged_files: [],
      unstaged_files: ['pnpm-lock.yaml'],
    })

    expect(result.blocking_conditions.join(' ')).toContain('Lockfile drift detected')
  })

  it('detects fallback still present in touched routes as blocking', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    writeRepoFile(root, 'src/app/api/v1/runs/route.ts', routeSource(['GET', 'POST']))
    writeRepoFile(root, 'src/lib/__tests__/v1-runs-route-security.test.ts', 'export {}\n')

    const result = verifyCurrentBranchState(root, {
      branch: 'feature/runs',
      head: 'abc1234',
      origin_main: '5eab10d',
      working_tree_clean: false,
      is_main: false,
      dirty_files: [
        'src/app/api/v1/runs/route.ts',
        'src/lib/__tests__/v1-runs-route-security.test.ts',
      ],
      untracked_files: [],
      staged_files: [],
      unstaged_files: [
        'src/app/api/v1/runs/route.ts',
        'src/lib/__tests__/v1-runs-route-security.test.ts',
      ],
    })

    expect(result.blocking_conditions.join(' ')).toContain('Fallback-to-1 pattern still present in touched route files')
  })

  it('recommends exact stage files when diff scope is clean', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    writeRepoFile(root, 'src/app/api/v1/runs/route.ts', routeSource(
      ['GET', 'POST'],
      'const workspaceId = requireWorkspaceId(request)\nreturn NextResponse.json({ workspaceId })',
    ))
    writeRepoFile(root, 'src/lib/__tests__/v1-runs-route-security.test.ts', 'export {}\n')

    const result = verifyCurrentBranchState(root, {
      branch: 'feature/runs',
      head: 'abc1234',
      origin_main: '5eab10d',
      working_tree_clean: false,
      is_main: false,
      dirty_files: [
        'src/app/api/v1/runs/route.ts',
        'src/lib/__tests__/v1-runs-route-security.test.ts',
      ],
      untracked_files: [],
      staged_files: [],
      unstaged_files: [
        'src/app/api/v1/runs/route.ts',
        'src/lib/__tests__/v1-runs-route-security.test.ts',
      ],
    })

    expect(result.blocking_conditions).toEqual([])
    expect(result.stage_recommendation.recommended).toBe(true)
    expect(result.stage_recommendation.files).toEqual([
      'src/app/api/v1/runs/route.ts',
      'src/lib/__tests__/v1-runs-route-security.test.ts',
    ])
    expect(result.commit_recommendation.recommended).toBe(true)
  })

  it('does not recommend push or PR from verify mode', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const result = verifyCurrentBranchState(root, {
      branch: 'feature/tooling',
      head: 'abc1234',
      origin_main: '5eab10d',
      working_tree_clean: false,
      is_main: false,
      dirty_files: ['scripts/security-hardening-runner.cjs'],
      untracked_files: [],
      staged_files: [],
      unstaged_files: ['scripts/security-hardening-runner.cjs'],
    })

    expect(result.push_recommendation.recommended).toBe(false)
  })
})

describe('security hardening runner output shape', () => {
  it('builds the expected basic JSON envelope', () => {
    const output = buildOutput('audit', {
      status: 'PASS',
      risk_level: 0,
      repo: {
        branch: 'main',
        head: '5eab10d',
        origin_main: '5eab10d',
        working_tree_clean: true,
        warnings: [],
      },
      summary: 'ok',
    })

    expect(output.agent).toBe('Security Hardening Runner v1.1')
    expect(output.label).toBe('OBSERVE ONLY')
    expect(output.mode).toBe('audit')
    expect(output.scan.root).toBe('src/app/api')
    expect(output.batch_planner.enabled).toBe(false)
    expect(output.verify.push_recommendation.recommended).toBe(false)
  })

  it('returns basic shape for both audit and verify mode runners', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    writeRepoFile(root, 'src/app/api/v1/runs/route.ts', routeSource(['GET', 'POST']))
    writeRepoFile(root, 'src/lib/__tests__/v1-runs-route-security.test.ts', 'export {}\n')

    const audit = runAuditMode(root, fakeGitRunner({
      branch: 'main',
      status: '',
      head: '5eab10d',
      originMain: '5eab10d',
      localMain: '5eab10d',
    }))

    const verify = runVerifyMode(root, fakeGitRunner({
      branch: 'feature/runs',
      status: ' M src/app/api/v1/runs/route.ts\n M src/lib/__tests__/v1-runs-route-security.test.ts\n',
    }))

    expect(audit.status).toBe('PASS')
    expect(audit.recommendation.scope_files).toEqual(['src/app/api/v1/runs/route.ts'])
    expect(audit.batch_planner.enabled).toBe(true)
    expect(audit.batch_planner.next_strategy).toBe('single_route')
    expect(verify.mode).toBe('verify')
    expect(verify.verify.changed_files).toEqual([
      'src/app/api/v1/runs/route.ts',
      'src/lib/__tests__/v1-runs-route-security.test.ts',
    ])
  })

  it('does not use blocker wording in verify PASS summary when there are no blocking conditions', () => {
    const root = makeTempRepo()
    tempRoots.push(root)

    const verify = runVerifyMode(root, fakeGitRunner({
      branch: 'feature/runner',
      status: '',
      head: '0a4ceaf',
      originMain: '2b3fcb2',
      localMain: '2b3fcb2',
    }))

    expect(verify.status).toBe('PASS')
    expect(verify.verify.blocking_conditions).toEqual([])
    expect(verify.summary).not.toContain('resolve blockers first')
    expect(verify.summary).toContain('branch is clean')
  })
})
