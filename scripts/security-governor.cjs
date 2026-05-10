#!/usr/bin/env node
/**
 * security-governor.cjs
 * Approval-gated governance layer above the Security Hardening Runner.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Security Governor v1';
const LABEL = 'APPROVAL GATED / NON-MUTATING';
const VALID_MODES = new Set(['plan', 'verify']);
const RUNNER_SCRIPT = 'scripts/security-hardening-runner.cjs';
const DEFAULT_VALIDATION_COMMANDS = [
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm build',
];
const DECISIONS = {
  APPROVE_IMPLEMENTATION_PROMPT: 'APPROVE_IMPLEMENTATION_PROMPT',
  HOLD_FOR_MANUAL_REVIEW: 'HOLD_FOR_MANUAL_REVIEW',
  RECOMMEND_TOOLING_OR_CI: 'RECOMMEND_TOOLING_OR_CI',
  BLOCK_UNSAFE_SCOPE: 'BLOCK_UNSAFE_SCOPE',
  NO_ACTION: 'NO_ACTION',
  APPROVE_STAGE: 'APPROVE_STAGE',
  APPROVE_COMMIT: 'APPROVE_COMMIT',
  BLOCK_COMMIT: 'BLOCK_COMMIT',
  NO_CHANGES: 'NO_CHANGES',
};
const BLOCKED_FAMILY_GLOBS = [
  'src/app/api/workflows/**',
  'src/app/api/pipelines/**',
  'src/app/api/projects/**',
  'src/app/api/agents/**',
  'src/app/api/memory/**',
];
const ALWAYS_BLOCKED_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
];

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function riskLevel(label) {
  if (label === 'Critical') return 3;
  if (label === 'High') return 2;
  if (label === 'Medium') return 1;
  return 0;
}

function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
  });

  return {
    ok: !result.error && result.status === 0,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : '',
  };
}

function parseRunnerJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Runner output was empty.');
  }

  const separatorIndex = trimmed.indexOf('\n\n');
  const candidate = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  return JSON.parse(candidate);
}

function loadRunnerApi(rootDir) {
  const absolute = path.join(rootDir, RUNNER_SCRIPT);
  if (!fs.existsSync(absolute)) {
    return null;
  }

  try {
    return require(absolute);
  } catch {
    return null;
  }
}

function getRouteFamily(filePath) {
  const normalized = normalizePath(filePath);
  const prefix = 'src/app/api/';
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  const parts = relative.split('/').filter(Boolean);
  const trimmed = parts.slice(0, -1).filter((part) => !part.startsWith('['));

  if (trimmed.length === 0) return 'unknown';
  if (trimmed[0] === 'v1' && trimmed[1]) return `v1/${trimmed[1]}`;
  return trimmed[0] || 'unknown';
}

function getDomainName(filePath) {
  const family = getRouteFamily(filePath);
  const parts = family.split('/');
  return parts[parts.length - 1];
}

function inferFocusedTestCandidates(routeFile, runnerApi) {
  if (runnerApi && typeof runnerApi.inferFocusedTestCandidates === 'function') {
    return runnerApi.inferFocusedTestCandidates(routeFile);
  }

  const family = getRouteFamily(routeFile);
  const slug = family.replace(/\//g, '-');
  const domain = getDomainName(routeFile);

  return unique([
    `src/lib/__tests__/${slug}-route-security.test.ts`,
    `src/lib/__tests__/${domain}-route-security.test.ts`,
    `src/lib/__tests__/${domain}-security.test.ts`,
  ]);
}

function extractPathsFromText(values) {
  const matches = [];

  for (const value of values || []) {
    const found = String(value).match(/src\/[A-Za-z0-9_./\-[\]]+/g);
    if (found) {
      matches.push(...found.map((item) => normalizePath(item)));
    }
  }

  return unique(matches);
}

function routeFamiliesForFiles(files) {
  return unique((files || []).map((file) => getRouteFamily(file)));
}

function candidateScopeIsMixed(candidate) {
  const files = Array.isArray(candidate && candidate.scope_files) ? candidate.scope_files : [];
  const families = routeFamiliesForFiles(files);
  const normalized = files.map((file) => normalizePath(file).toLowerCase());
  const hasGatewayControl = normalized.some((file) => /(gateway|gateways|terminal|control)/.test(file));
  const hasTokenCredential = normalized.some((file) => /(token|tokens|key|keys|credential|credentials|secret|secrets)/.test(file));

  if (families.length > 1 && hasGatewayControl) return true;
  if (families.length > 1 && hasTokenCredential) return true;
  return false;
}

function isReviewableBatch(candidate) {
  const fileCount = Array.isArray(candidate && candidate.scope_files) ? candidate.scope_files.length : 0;
  const risk = String(candidate && candidate.risk || 'Low');

  if (risk === 'Critical') return fileCount <= 2;
  if (risk === 'High') return fileCount <= 5;
  return fileCount <= 8;
}

function chooseBatchCandidate(auditResult) {
  const candidates = Array.isArray(auditResult && auditResult.batch_planner && auditResult.batch_planner.batch_candidates)
    ? auditResult.batch_planner.batch_candidates
    : [];

  return candidates.find((candidate) => candidate && candidate.safe_to_batch) || null;
}

function hasSaferBatchCandidate(auditResult, recommendation) {
  const singleRisk = riskLevel(recommendation && recommendation.risk);
  const safeCandidates = Array.isArray(auditResult && auditResult.batch_planner && auditResult.batch_planner.batch_candidates)
    ? auditResult.batch_planner.batch_candidates.filter((candidate) => candidate && candidate.safe_to_batch)
    : [];

  return safeCandidates.some((candidate) => {
    const candidateRisk = riskLevel(candidate.risk);
    const candidateFiles = Array.isArray(candidate.scope_files) ? candidate.scope_files.length : 0;
    const singleFiles = Array.isArray(recommendation && recommendation.scope_files) ? recommendation.scope_files.length : 0;
    return candidateRisk > singleRisk || (candidateRisk === singleRisk && candidateFiles <= singleFiles);
  });
}

function isRunnerAuditResult(result) {
  return Boolean(
    result
      && result.mode === 'audit'
      && result.repo
      && result.recommendation
      && result.batch_planner
      && typeof result.batch_planner.next_strategy === 'string'
  );
}

function isRunnerVerifyResult(result) {
  return Boolean(
    result
      && result.mode === 'verify'
      && result.repo
      && result.verify
      && result.verify.stage_recommendation
      && result.verify.commit_recommendation
  );
}

function getRunnerResult(rootDir, mode, options = {}) {
  const runnerApi = options.runnerApi || loadRunnerApi(rootDir);
  const fnName = mode === 'verify' ? 'runVerifyMode' : 'runAuditMode';

  if (runnerApi && typeof runnerApi[fnName] === 'function') {
    try {
      return {
        available: true,
        source: 'module',
        runnerApi,
        result: runnerApi[fnName](rootDir),
      };
    } catch (error) {
      return {
        available: false,
        source: 'module',
        runnerApi,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const scriptPath = path.join(rootDir, RUNNER_SCRIPT);
  if (!fs.existsSync(scriptPath)) {
    return {
      available: false,
      source: 'none',
      runnerApi,
      error: `Runner script not found: ${RUNNER_SCRIPT}`,
    };
  }

  const execution = runCommand(process.execPath, [scriptPath, mode], { cwd: rootDir });
  if (!execution.ok) {
    return {
      available: false,
      source: 'cli',
      runnerApi,
      error: execution.stderr || execution.error || `Runner ${mode} command failed.`,
    };
  }

  try {
    return {
      available: true,
      source: 'cli',
      runnerApi,
      result: parseRunnerJson(execution.stdout),
    };
  } catch (error) {
    return {
      available: false,
      source: 'cli',
      runnerApi,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function deriveAllowedFiles(strategy, runnerApi) {
  const scopeFiles = Array.isArray(strategy.scope_files) ? unique(strategy.scope_files) : [];
  const testFiles = [];

  for (const routeFile of scopeFiles) {
    const candidates = inferFocusedTestCandidates(routeFile, runnerApi);
    if (candidates[0]) {
      testFiles.push(candidates[0]);
    }
  }

  return unique([...scopeFiles, ...testFiles]);
}

function deriveBlockedFiles(auditResult, strategy, allowedFiles) {
  const recommendation = auditResult && auditResult.recommendation ? auditResult.recommendation : {};
  const blocked = [
    ...ALWAYS_BLOCKED_FILES,
    ...extractPathsFromText(recommendation.excluded),
    ...BLOCKED_FAMILY_GLOBS,
  ];
  const targetFiles = Array.isArray(strategy.scope_files) ? strategy.scope_files : [];

  if (targetFiles.length === 1) {
    const target = targetFiles[0];
    const family = getRouteFamily(target);
    if (family === 'gateways') {
      blocked.push('src/app/api/gateways/** (outside src/app/api/gateways/route.ts)');
    } else if (family === 'tokens') {
      blocked.push('src/app/api/tokens/** (outside approved scope)');
    }
  }

  return unique(blocked.filter((item) => !allowedFiles.includes(item)));
}

function buildApprovalGates(strategy) {
  const gates = [
    'Audit first and keep the approved scope unchanged until implementation starts.',
    'Run the Security Hardening Runner verify command before commit review.',
    'Do not use git add .; only stage exact approved files after validation.',
    'Do not push until explicitly approved.',
    'Do not create a PR until explicitly approved.',
  ];

  if (strategy.next_strategy === 'route_family_batch') {
    gates.push('Do not expand the route-family batch beyond the explicitly approved files.');
  }

  return gates;
}

function generateImplementationPrompt(planContext) {
  const { strategy, policy } = planContext;
  const scopeFiles = Array.isArray(strategy.scope_files) ? strategy.scope_files : [];
  const routeSearchTargets = scopeFiles.length > 0 ? scopeFiles.join(' ') : 'src/app/api/.../route.ts';
  const focusedTests = policy.allowed_files.filter((file) => /__tests__\/.*(test|spec)\./.test(file));
  const focusedTestCommand = focusedTests.length > 0
    ? `pnpm test -- ${focusedTests.join(' ')}`
    : 'pnpm test -- src/lib/__tests__/route-security.test.ts';

  return [
    'PROJECT: Mission Control',
    'LOCAL REPO: C:\\Users\\nikma\\mission-control',
    'CANONICAL REPO: https://github.com/niko4244/mission-control',
    '',
    'TASK TYPE:',
    strategy.next_strategy === 'route_family_batch'
      ? 'Approval-gated route-family workspace hardening batch PR.'
      : 'Approval-gated focused workspace-route hardening PR.',
    '',
    'GOAL:',
    `Implement only the governor-approved scope for ${strategy.target || 'the selected route scope'} using the existing repository hardening patterns.`,
    '',
    'PRECONDITION:',
    '1. Confirm local main is current:',
    '   git checkout main',
    '   git pull origin main',
    '   git status --short',
    '   git rev-parse --short HEAD',
    '   git log --oneline -5',
    '',
    'Required:',
    '- working tree clean',
    '- stop and report if main is dirty or not current',
    '- do not create a branch until checks pass',
    '',
    'BRANCH:',
    `Create from updated main: ${strategy.branch || 'harden-workspace-route'}`,
    '',
    'STRICT SCOPE:',
    '- audit first',
    strategy.next_strategy === 'route_family_batch'
      ? '- route-family batch only for the exact approved files listed below'
      : '- one approved route only',
    '- smallest safe scope only',
    '- no broad refactor',
    '- no repo-wide cleanup',
    '',
    'EXACT ALLOWED FILES:',
    ...policy.allowed_files.map((file) => `- ${file}`),
    '',
    'EXACT BLOCKED FILES:',
    ...policy.blocked_files.map((file) => `- ${file}`),
    '',
    'AUDIT / SEARCH COMMAND:',
    `rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1|auth\\.user\\.workspace_id|user\\.workspace_id|currentUser\\.workspace_id" ${routeSearchTargets} src/lib/__tests__`,
    '',
    'IMPLEMENTATION REQUIREMENTS:',
    '- inspect the approved route files first and identify every fallback-to-1 path',
    '- replace implicit workspace fallback with the established fail-closed workspace pattern',
    '- preserve existing behavior outside workspace isolation hardening',
    '- do not trust client-supplied workspace identifiers',
    '- do not broaden scope beyond the approved files',
    '',
    'SECURITY REQUIREMENTS:',
    '- no workspace_id ?? 1',
    '- no workspaceId ?? 1',
    '- fail closed when workspace context is missing',
    '- deny or hide cross-workspace access',
    '- keep existing auth/role checks intact or stricter',
    '',
    'TEST REQUIREMENTS:',
    '- add or update focused route security coverage for every touched route',
    '- cover denied unauthenticated access where applicable',
    '- cover missing workspace context',
    '- cover authorized workspace-scoped behavior',
    '- assert the touched route source no longer contains fallback-to-1 patterns',
    '',
    'VALIDATION COMMANDS:',
    focusedTestCommand,
    ...DEFAULT_VALIDATION_COMMANDS,
    'node scripts/security-hardening-runner.cjs verify',
    '',
    'STATIC FALLBACK REGRESSION:',
    `rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1" ${routeSearchTargets}`,
    '',
    'DIFF REVIEW BEFORE COMMIT:',
    'git status --short',
    'git diff --stat',
    'git diff --name-only',
    `git diff -- ${policy.allowed_files.join(' ')}`,
    '',
    'GIT RULES:',
    '- do not use git add .',
    '- only stage exact approved files after validation and approval',
    '- do not push until approved',
    '- do not create PR until approved',
    '',
    'REQUIRED OUTPUT FORMAT:',
    'A. Precondition results',
    'B. Audit findings',
    'C. Files changed',
    'D. Security hardening changes',
    'E. Tests added or updated',
    'F. Validation results',
    'G. Diff scope',
    'H. Exact files recommended to stage',
    'I. Commit recommendation',
    'J. PR recommendation',
  ].join('\n');
}

function evaluatePlanPolicy(auditResult, runnerApi) {
  const recommendation = auditResult && auditResult.recommendation ? auditResult.recommendation : {};
  const batchPlanner = auditResult && auditResult.batch_planner ? auditResult.batch_planner : {};
  const runnerStrategy = String(batchPlanner.next_strategy || 'hold/manual_review');
  const scopeFiles = Array.isArray(recommendation.scope_files) ? recommendation.scope_files : [];
  const warnings = [];
  const blockingReasons = [];
  let decision = DECISIONS.NO_ACTION;
  let approvedStrategy = {
    next_strategy: runnerStrategy,
    risk: recommendation.risk || 'Low',
    target: scopeFiles[0] || '',
    branch: recommendation.branch || '',
    why: batchPlanner.why || recommendation.why_next || '',
    scope_files: scopeFiles,
  };

  if (!isRunnerAuditResult(auditResult) || !scopeFiles.length && runnerStrategy === 'single_route') {
    return {
      decision: DECISIONS.HOLD_FOR_MANUAL_REVIEW,
      status: 'FAIL',
      strategy: approvedStrategy,
      policy: {
        allowed_files: [],
        blocked_files: [...ALWAYS_BLOCKED_FILES],
        approval_gates: buildApprovalGates(approvedStrategy),
        blocking_reasons: ['Runner audit output was malformed or missing an actionable recommendation.'],
        warnings: [],
      },
      implementation_prompt: '',
      human_action: 'Do not start implementation. Inspect the runner output manually and repair the recommendation flow first.',
    };
  }

  if (runnerStrategy === 'tooling_or_ci') {
    decision = DECISIONS.RECOMMEND_TOOLING_OR_CI;
    approvedStrategy = {
      ...approvedStrategy,
      target: recommendation.title || 'tooling_or_ci follow-up',
    };
  } else if (runnerStrategy === 'hold/manual_review') {
    decision = DECISIONS.HOLD_FOR_MANUAL_REVIEW;
    warnings.push('Runner already recommends manual review before implementation.');
  } else if (runnerStrategy === 'single_route') {
    if (!['Critical', 'High'].includes(String(recommendation.risk))) {
      blockingReasons.push('Single-route approval requires a Critical or High runner recommendation.');
    }
    if (scopeFiles.length !== 1) {
      blockingReasons.push('Single-route approval requires exactly one scope file.');
    }
    if (batchPlanner.single_route_remaining_is_worth_it !== true) {
      blockingReasons.push('Runner does not consider single-route mode worth continuing.');
    }
    if (hasSaferBatchCandidate(auditResult, recommendation)) {
      warnings.push('A safe batch candidate may now be more efficient than the single-route recommendation.');
    }

    if (blockingReasons.length === 0) {
      decision = DECISIONS.APPROVE_IMPLEMENTATION_PROMPT;
    } else {
      decision = DECISIONS.BLOCK_UNSAFE_SCOPE;
    }
  } else if (runnerStrategy === 'route_family_batch') {
    const candidate = chooseBatchCandidate(auditResult);
    approvedStrategy = {
      ...approvedStrategy,
      target: candidate && candidate.family ? candidate.family : approvedStrategy.target,
      branch: candidate && candidate.branch ? candidate.branch : approvedStrategy.branch,
      risk: candidate && candidate.risk ? candidate.risk : approvedStrategy.risk,
      why: candidate && candidate.why_next ? candidate.why_next : approvedStrategy.why,
      scope_files: candidate && Array.isArray(candidate.scope_files) ? candidate.scope_files : approvedStrategy.scope_files,
    };

    if (!candidate) {
      blockingReasons.push('Runner did not supply a safe batch candidate to approve.');
    } else {
      if (!candidate.safe_to_batch) {
        blockingReasons.push('Selected route-family batch was not marked safe by the runner.');
      }
      if (candidateScopeIsMixed(candidate)) {
        blockingReasons.push('Blocked mixed batch scope detected: gateway/control or token routes are mixed with unrelated files.');
      }
      if (!isReviewableBatch(candidate)) {
        blockingReasons.push('Batch scope is larger than the governor review policy allows.');
      }
      if ((batchPlanner.risk_summary && batchPlanner.risk_summary.Critical > 0) && candidate.risk !== 'Critical') {
        blockingReasons.push('A non-Critical batch cannot skip ahead of remaining Critical route work.');
      }
    }

    if (blockingReasons.length === 0) {
      decision = DECISIONS.APPROVE_IMPLEMENTATION_PROMPT;
    } else {
      decision = DECISIONS.BLOCK_UNSAFE_SCOPE;
    }
  }

  const allowedFiles = decision === DECISIONS.APPROVE_IMPLEMENTATION_PROMPT
    ? deriveAllowedFiles(approvedStrategy, runnerApi)
    : [];
  const blockedFiles = deriveBlockedFiles(auditResult, approvedStrategy, allowedFiles);
  const policy = {
    allowed_files: allowedFiles,
    blocked_files: blockedFiles,
    approval_gates: buildApprovalGates(approvedStrategy),
    blocking_reasons: unique(blockingReasons),
    warnings: unique(warnings),
  };

  let status = 'PASS';
  if (decision === DECISIONS.BLOCK_UNSAFE_SCOPE || decision === DECISIONS.HOLD_FOR_MANUAL_REVIEW) {
    status = decision === DECISIONS.BLOCK_UNSAFE_SCOPE ? 'FAIL' : 'WARN';
  }
  if (decision === DECISIONS.RECOMMEND_TOOLING_OR_CI) {
    status = 'PASS';
  }
  if (auditResult.status === 'WARN' && status === 'PASS') {
    status = 'WARN';
    policy.warnings.push('Runner audit reported warnings; keep human review active before implementation.');
  }

  const implementationPrompt = decision === DECISIONS.APPROVE_IMPLEMENTATION_PROMPT
    ? generateImplementationPrompt({ strategy: approvedStrategy, policy })
    : '';

  let humanAction = 'No action recommended.';
  if (decision === DECISIONS.APPROVE_IMPLEMENTATION_PROMPT) {
    humanAction = 'Paste the implementation prompt into Codex, keep the approved scope exact, and do not broaden the diff manually.';
  } else if (decision === DECISIONS.RECOMMEND_TOOLING_OR_CI) {
    humanAction = 'Pause route hardening and draft the recommended tooling or CI guard instead.';
  } else if (decision === DECISIONS.HOLD_FOR_MANUAL_REVIEW || decision === DECISIONS.BLOCK_UNSAFE_SCOPE) {
    humanAction = 'Do not start implementation. Review the blocked scope and governor warnings first.';
  }

  return {
    decision,
    status,
    strategy: approvedStrategy,
    policy,
    implementation_prompt: implementationPrompt,
    human_action: humanAction,
  };
}

function inferGovernorCommitMessage(verifyResult) {
  const scripts = verifyResult && verifyResult.classifications ? verifyResult.classifications.scripts || [] : [];
  const tests = verifyResult && verifyResult.classifications ? verifyResult.classifications.test_files || [] : [];

  if (scripts.includes('scripts/security-governor.cjs') && tests.includes('src/lib/__tests__/security-governor.test.ts')) {
    return 'Add security governor v1';
  }

  return verifyResult && verifyResult.commit_recommendation ? verifyResult.commit_recommendation.message || '' : '';
}

function evaluateVerifyPolicy(verifyResult) {
  const blockingReasons = [];
  const warnings = [];
  const classifications = verifyResult && verifyResult.verify && verifyResult.verify.classifications
    ? verifyResult.verify.classifications
    : {
        route_files: [],
        test_files: [],
        docs: [],
        scripts: [],
        package_files: [],
        lockfiles: [],
        unknown: [],
        route_families: [],
      };
  const changedFiles = verifyResult && verifyResult.verify ? verifyResult.verify.changed_files || [] : [];
  const stagedFiles = verifyResult && verifyResult.verify ? verifyResult.verify.staged_files || [] : [];
  const unstagedFiles = verifyResult && verifyResult.verify ? verifyResult.verify.unstaged_files || [] : [];

  if (!isRunnerVerifyResult(verifyResult)) {
    return {
      decision: DECISIONS.HOLD_FOR_MANUAL_REVIEW,
      status: 'FAIL',
      verify_decision: {
        stage_files: [],
        commit_message: '',
        push_allowed: false,
        pr_allowed: false,
      },
      policy: {
        allowed_files: [],
        blocked_files: [...ALWAYS_BLOCKED_FILES],
        approval_gates: buildApprovalGates({ next_strategy: 'hold/manual_review' }),
        blocking_reasons: ['Runner verify output was malformed or unavailable.'],
        warnings: [],
      },
      human_action: 'Do not stage or commit. Repair the runner verify path first.',
    };
  }

  if (verifyResult.status === 'FAIL') {
    blockingReasons.push('Runner verify returned FAIL.');
  }

  blockingReasons.push(...(verifyResult.verify.blocking_conditions || []));

  if (classifications.lockfiles.length > 0) {
    blockingReasons.push(`Lockfile drift is blocked by governor policy: ${classifications.lockfiles.join(', ')}`);
  }

  if (classifications.package_files.length > 0) {
    blockingReasons.push(`Package file drift is blocked by governor policy: ${classifications.package_files.join(', ')}`);
  }

  if (verifyResult.verify.fallback_regression && verifyResult.verify.fallback_regression.passed === false) {
    blockingReasons.push('Fallback regression did not pass.');
  }

  if (classifications.route_files.length > 0 && (classifications.scripts.length > 0 || classifications.unknown.length > 0)) {
    blockingReasons.push('Scope drift detected: route hardening changes are mixed with unrelated implementation files.');
  }

  if (changedFiles.length === 0 && verifyResult.status === 'PASS') {
    return {
      decision: DECISIONS.NO_CHANGES,
      status: 'WARN',
      verify_decision: {
        stage_files: [],
        commit_message: '',
        push_allowed: false,
        pr_allowed: false,
      },
      policy: {
        allowed_files: [],
        blocked_files: [...ALWAYS_BLOCKED_FILES],
        approval_gates: buildApprovalGates({ next_strategy: 'hold/manual_review' }),
        blocking_reasons: [],
        warnings: ['Branch is already clean; there is nothing to stage or commit.'],
      },
      human_action: 'No changes to verify. Keep push and PR creation gated behind explicit approval.',
    };
  }

  if (blockingReasons.length > 0) {
    return {
      decision: DECISIONS.BLOCK_COMMIT,
      status: 'FAIL',
      verify_decision: {
        stage_files: [],
        commit_message: '',
        push_allowed: false,
        pr_allowed: false,
      },
      policy: {
        allowed_files: [],
        blocked_files: [...ALWAYS_BLOCKED_FILES],
        approval_gates: buildApprovalGates({ next_strategy: 'hold/manual_review' }),
        blocking_reasons: unique(blockingReasons),
        warnings: [],
      },
      human_action: 'Do not commit. Resolve the reported blocking conditions before staging or committing anything.',
    };
  }

  if (classifications.docs.length > 0 || classifications.unknown.length > 0) {
    warnings.push('Scope confidence is ambiguous because docs or unknown files changed alongside the implementation.');
  }

  let decision = DECISIONS.NO_ACTION;
  let humanAction = 'Review the verification report before taking the next step.';
  if (stagedFiles.length > 0 && unstagedFiles.length === 0 && (verifyResult.verify.untracked_files || []).length === 0) {
    decision = DECISIONS.APPROVE_COMMIT;
    humanAction = 'Commit the staged files with the approved message, but do not push yet.';
  } else if (verifyResult.verify.stage_recommendation && verifyResult.verify.stage_recommendation.recommended) {
    decision = DECISIONS.APPROVE_STAGE;
    humanAction = 'Stage exactly the recommended files, rerun verify if needed, and keep push/PR gated behind approval.';
  } else if (warnings.length > 0) {
    decision = DECISIONS.HOLD_FOR_MANUAL_REVIEW;
    humanAction = 'Pause for manual review before staging or committing this scope.';
  }

  const status = decision === DECISIONS.HOLD_FOR_MANUAL_REVIEW ? 'WARN' : 'PASS';

  return {
    decision,
    status,
    verify_decision: {
      stage_files: verifyResult.verify.stage_recommendation && verifyResult.verify.stage_recommendation.recommended
        ? verifyResult.verify.stage_recommendation.files
        : [],
      commit_message: decision === DECISIONS.APPROVE_COMMIT ? inferGovernorCommitMessage(verifyResult.verify) : '',
      push_allowed: false,
      pr_allowed: false,
    },
    policy: {
      allowed_files: [],
      blocked_files: [...ALWAYS_BLOCKED_FILES],
      approval_gates: buildApprovalGates({ next_strategy: 'hold/manual_review' }),
      blocking_reasons: [],
      warnings: unique(warnings),
    },
    human_action: humanAction,
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status,
    decision: data.decision,
    runner: data.runner,
    strategy: data.strategy,
    policy: data.policy,
    implementation_prompt: data.implementation_prompt || '',
    verify_decision: data.verify_decision || {
      stage_files: [],
      commit_message: '',
      push_allowed: false,
      pr_allowed: false,
    },
    human_action: data.human_action || '',
    summary: data.summary || '',
  };
}

function summarizePlan(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: plan',
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `Runner audit: ${result.runner.status}`,
    `Strategy: ${result.strategy.next_strategy} (${result.strategy.risk})`,
    `Target: ${result.strategy.target || 'none'}`,
    `Next human action: ${result.human_action}`,
  ].join('\n');
}

function summarizeVerify(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: verify',
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `Runner verify: ${result.runner.status}`,
    `Stage files: ${result.verify_decision.stage_files.length > 0 ? result.verify_decision.stage_files.join(', ') : 'none'}`,
    `Next human action: ${result.human_action}`,
  ].join('\n');
}

function runPlanMode(rootDir, options = {}) {
  const runnerState = getRunnerResult(rootDir, 'audit', options);
  if (!runnerState.available || !isRunnerAuditResult(runnerState.result)) {
    const result = buildOutput('plan', {
      status: 'FAIL',
      decision: DECISIONS.HOLD_FOR_MANUAL_REVIEW,
      runner: {
        available: false,
        mode: 'audit',
        status: 'FAIL',
      },
      strategy: {
        next_strategy: 'hold/manual_review',
        risk: 'Low',
        target: '',
        branch: '',
        why: runnerState.error || 'Runner audit was unavailable.',
      },
      policy: {
        allowed_files: [],
        blocked_files: [...ALWAYS_BLOCKED_FILES],
        approval_gates: buildApprovalGates({ next_strategy: 'hold/manual_review' }),
        blocking_reasons: [runnerState.error || 'Runner audit was unavailable or malformed.'],
        warnings: [],
      },
      implementation_prompt: '',
      verify_decision: {
        stage_files: [],
        commit_message: '',
        push_allowed: false,
        pr_allowed: false,
      },
      human_action: 'Do not start implementation. Repair the runner audit path first.',
    });
    result.summary = summarizePlan(result);
    return result;
  }

  const evaluated = evaluatePlanPolicy(runnerState.result, runnerState.runnerApi);
  const result = buildOutput('plan', {
    status: evaluated.status,
    decision: evaluated.decision,
    runner: {
      available: true,
      mode: 'audit',
      status: runnerState.result.status,
    },
    strategy: {
      next_strategy: evaluated.strategy.next_strategy,
      risk: evaluated.strategy.risk,
      target: evaluated.strategy.target,
      branch: evaluated.strategy.branch,
      why: evaluated.strategy.why,
    },
    policy: evaluated.policy,
    implementation_prompt: evaluated.implementation_prompt,
    verify_decision: {
      stage_files: [],
      commit_message: '',
      push_allowed: false,
      pr_allowed: false,
    },
    human_action: evaluated.human_action,
  });
  result.summary = summarizePlan(result);
  return result;
}

function runVerifyMode(rootDir, options = {}) {
  const runnerState = getRunnerResult(rootDir, 'verify', options);
  if (!runnerState.available || !isRunnerVerifyResult(runnerState.result)) {
    const result = buildOutput('verify', {
      status: 'FAIL',
      decision: DECISIONS.HOLD_FOR_MANUAL_REVIEW,
      runner: {
        available: false,
        mode: 'verify',
        status: 'FAIL',
      },
      strategy: {
        next_strategy: 'hold/manual_review',
        risk: 'Low',
        target: '',
        branch: '',
        why: runnerState.error || 'Runner verify was unavailable.',
      },
      policy: {
        allowed_files: [],
        blocked_files: [...ALWAYS_BLOCKED_FILES],
        approval_gates: buildApprovalGates({ next_strategy: 'hold/manual_review' }),
        blocking_reasons: [runnerState.error || 'Runner verify was unavailable or malformed.'],
        warnings: [],
      },
      implementation_prompt: '',
      verify_decision: {
        stage_files: [],
        commit_message: '',
        push_allowed: false,
        pr_allowed: false,
      },
      human_action: 'Do not stage or commit. Repair the runner verify path first.',
    });
    result.summary = summarizeVerify(result);
    return result;
  }

  const evaluated = evaluateVerifyPolicy(runnerState.result);
  const result = buildOutput('verify', {
    status: evaluated.status,
    decision: evaluated.decision,
    runner: {
      available: true,
      mode: 'verify',
      status: runnerState.result.status,
    },
    strategy: {
      next_strategy: 'hold/manual_review',
      risk: 'Low',
      target: '',
      branch: '',
      why: '',
    },
    policy: evaluated.policy,
    implementation_prompt: '',
    verify_decision: evaluated.verify_decision,
    human_action: evaluated.human_action,
  });
  result.summary = summarizeVerify(result);
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2)) {
  const mode = VALID_MODES.has(String(argv[0] || '').toLowerCase())
    ? String(argv[0]).toLowerCase()
    : 'plan';
  const rootDir = path.resolve(__dirname, '..');

  if (!fs.existsSync(rootDir)) {
    throw new Error(`Repository root not found: ${rootDir}`);
  }

  if (mode === 'verify') {
    return runVerifyMode(rootDir);
  }

  return runPlanMode(rootDir);
}

module.exports = {
  AGENT,
  LABEL,
  ALWAYS_BLOCKED_FILES,
  DECISIONS,
  buildOutput,
  candidateScopeIsMixed,
  deriveAllowedFiles,
  deriveBlockedFiles,
  evaluatePlanPolicy,
  evaluateVerifyPolicy,
  formatOutput,
  generateImplementationPrompt,
  getRunnerResult,
  getRouteFamily,
  inferFocusedTestCandidates,
  inferGovernorCommitMessage,
  isReviewableBatch,
  isRunnerAuditResult,
  isRunnerVerifyResult,
  loadRunnerApi,
  main,
  parseRunnerJson,
  routeFamiliesForFiles,
  runCommand,
  runPlanMode,
  runVerifyMode,
  summarizePlan,
  summarizeVerify,
};

if (require.main === module) {
  const result = main();
  process.stdout.write(formatOutput(result));
}
