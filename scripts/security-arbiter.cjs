#!/usr/bin/env node
/**
 * security-arbiter.cjs
 * Final bot-level reviewer above the Security Governor.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Mission Control Arbiter v1';
const AUTHORITY = 'FINAL_BOT_REVIEW';
const LABEL = 'NON-MUTATING / AUTHORIZATION-GATED';
const VALID_MODES = new Set(['plan', 'review']);
const PLAN_DECISIONS = new Set([
  'APPROVE_PLAN',
  'APPROVE_WITH_NOTES',
  'REQUEST_GOVERNOR_CORRECTION',
  'REJECT_PLAN',
  'ESCALATE_TO_HUMAN',
]);
const REVIEW_DECISIONS = new Set([
  'APPROVE',
  'APPROVE_WITH_NOTES',
  'REQUEST_CORRECTIONS',
  'REJECT',
  'ESCALATE_TO_HUMAN',
]);
const BLOCKED_FILES = ['package-lock.json', 'pnpm-lock.yaml'];
const VALIDATION_COMMANDS = [
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm build',
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

function parseJsonWithSummary(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Tool output was empty.');
  }

  const separatorIndex = trimmed.indexOf('\n\n');
  const candidate = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  return JSON.parse(candidate);
}

function loadApi(rootDir, scriptPath) {
  const absolute = path.join(rootDir, scriptPath);
  if (!fs.existsSync(absolute)) {
    return null;
  }

  try {
    return require(absolute);
  } catch {
    return null;
  }
}

function getToolResult(rootDir, config, options = {}) {
  const api = options.api || loadApi(rootDir, config.script);
  if (api && typeof api[config.fnName] === 'function') {
    try {
      return {
        available: true,
        source: 'module',
        api,
        result: api[config.fnName](rootDir),
      };
    } catch (error) {
      return {
        available: false,
        source: 'module',
        api,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const absolute = path.join(rootDir, config.script);
  if (!fs.existsSync(absolute)) {
    return {
      available: false,
      source: 'none',
      api,
      error: `Script not found: ${config.script}`,
    };
  }

  const execution = runCommand(process.execPath, [absolute, config.cliMode], { cwd: rootDir });
  if (!execution.ok) {
    return {
      available: false,
      source: 'cli',
      api,
      error: execution.stderr || execution.error || `${config.script} ${config.cliMode} failed.`,
    };
  }

  try {
    return {
      available: true,
      source: 'cli',
      api,
      result: parseJsonWithSummary(execution.stdout),
    };
  } catch (error) {
    return {
      available: false,
      source: 'cli',
      api,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectGitDiff(rootDir, commandRunner = runCommand) {
  const status = commandRunner('git', ['status', '--short'], { cwd: rootDir });
  const diffStat = commandRunner('git', ['diff', '--stat'], { cwd: rootDir });
  const diffNames = commandRunner('git', ['diff', '--name-only'], { cwd: rootDir });
  const diffText = commandRunner('git', ['diff'], { cwd: rootDir });

  return {
    available: status.ok && diffStat.ok && diffNames.ok && diffText.ok,
    git_status_short: status.ok ? splitLines(status.stdout).filter(Boolean) : [],
    diff_stat: diffStat.ok ? splitLines(diffStat.stdout).filter(Boolean) : [],
    diff_name_only: diffNames.ok ? splitLines(diffNames.stdout).filter(Boolean) : [],
    diff_text: diffText.ok ? diffText.stdout : '',
  };
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean);
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

function inferRiskFromFiles(files) {
  const normalized = (files || []).map((file) => normalizePath(file).toLowerCase());

  if (normalized.some((file) => /(token|tokens|key|keys|credential|credentials|secret|secrets|gateway|gateways|terminal|control|delivery|dispatch|approval|run|runs|execute|execution)/.test(file))) {
    return 'Critical';
  }
  if (normalized.some((file) => /(webhook|webhooks|notification|notifications|workflow|workflows|pipeline|pipelines|project|projects)/.test(file))) {
    return 'High';
  }
  if (normalized.some((file) => /(agent|agents|chat|status|search|memory|request|requests)/.test(file))) {
    return 'Medium';
  }
  return 'Low';
}

function classifyChangedFiles(files) {
  const classifications = {
    route_files: [],
    test_files: [],
    docs: [],
    scripts: [],
    package_files: [],
    lockfiles: [],
    unknown: [],
    route_families: [],
  };

  for (const file of files || []) {
    const normalized = normalizePath(file);
    const basename = path.posix.basename(normalized);
    if ((/\/route\.(t|j)sx?$/i).test(normalized)) {
      classifications.route_files.push(normalized);
      continue;
    }
    if ((/\/(__tests__\/.*|.*\.(test|spec)\.(t|j)sx?)$/i).test(normalized)) {
      classifications.test_files.push(normalized);
      continue;
    }
    if (normalized.startsWith('scripts/')) {
      classifications.scripts.push(normalized);
      continue;
    }
    if (normalized.startsWith('docs/') || /\.md$/i.test(normalized)) {
      classifications.docs.push(normalized);
      continue;
    }
    if (basename === 'package.json') {
      classifications.package_files.push(normalized);
      continue;
    }
    if (BLOCKED_FILES.includes(basename)) {
      classifications.lockfiles.push(normalized);
      continue;
    }
    classifications.unknown.push(normalized);
  }

  classifications.route_families = unique(classifications.route_files.map((file) => getRouteFamily(file)));
  return classifications;
}

function assessTestQuality(routeFiles, testFiles, fileReader = defaultFileReader) {
  if ((routeFiles || []).length === 0) {
    return {
      meaningful: true,
      missing: [],
      found: [],
      notes: ['No route files changed; route-specific workspace isolation checks were not required.'],
    };
  }

  const combined = (testFiles || [])
    .map((file) => {
      try {
        return fileReader(file);
      } catch {
        return '';
      }
    })
    .join('\n')
    .toLowerCase();

  const checks = [
    { label: 'unauthenticated denial', regex: /unauthenticated|denies unauthenticated|unauthorized/ },
    { label: 'missing workspace fail-closed', regex: /missing workspace|workspace context|workspace required|fail closed/ },
    { label: 'valid workspace success', regex: /valid workspace|authorized workspace|still works|supported behavior|success/ },
    { label: 'cross-workspace denial', regex: /cross-workspace|other workspace|not found|does not leak/ },
    { label: 'static fallback regression', regex: /workspace_id \?\? 1|workspaceid \?\? 1|fallback regression|no .*workspace_id/ },
  ];

  const missing = checks.filter((check) => !check.regex.test(combined)).map((check) => check.label);
  return {
    meaningful: missing.length === 0,
    missing,
    found: checks.filter((check) => !missing.includes(check.label)).map((check) => check.label),
    notes: [],
  };
}

function defaultFileReader(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function isToolingOnly(classifications) {
  return classifications.route_files.length === 0
    && classifications.package_files.length === 0
    && classifications.lockfiles.length === 0
    && classifications.unknown.length === 0
    && (classifications.scripts.length > 0 || classifications.test_files.length > 0);
}

function buildArbiterPrompt(governorPlan) {
  const strategy = governorPlan.strategy || {};
  const policy = governorPlan.policy || {};
  const routeFiles = (policy.allowed_files || []).filter((file) => file.startsWith('src/app/api/'));
  const testFiles = (policy.allowed_files || []).filter((file) => file.includes('__tests__'));
  const searchTargets = routeFiles.length > 0 ? routeFiles.join(' ') : (strategy.target || 'src/app/api/.../route.ts');

  return [
    'PROJECT: Mission Control',
    'LOCAL REPO: C:\\Users\\nikma\\mission-control',
    'CANONICAL REPO: https://github.com/niko4244/mission-control',
    '',
    'TASK TYPE:',
    strategy.next_strategy === 'route_family_batch'
      ? 'Arbiter-approved route-family workspace hardening PR.'
      : 'Arbiter-approved focused workspace-route hardening PR.',
    '',
    'GOAL:',
    `Implement only the Arbiter-approved scope for ${strategy.target || 'the selected route scope'} and preserve strict review discipline.`,
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
      ? '- touch only the explicitly approved route-family files listed below'
      : '- touch exactly one route plus one focused test file',
    '- no broad refactor',
    '- no helper or auth changes without explicit approval',
    '',
    'EXACT ALLOWED FILES:',
    ...(policy.allowed_files || []).map((file) => `- ${file}`),
    '',
    'EXACT BLOCKED FILES:',
    ...(policy.blocked_files || []).map((file) => `- ${file}`),
    '',
    'AUDIT / SEARCH COMMAND:',
    `rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1|auth\\.user\\.workspace_id|user\\.workspace_id|currentUser\\.workspace_id" ${searchTargets} src/lib/__tests__`,
    '',
    'IMPLEMENTATION REQUIREMENTS:',
    '- preserve existing behavior outside workspace isolation hardening',
    '- do not trust client-supplied workspace identifiers',
    '- keep scope exact and avoid adjacent route creep',
    '',
    'SECURITY REQUIREMENTS:',
    '- remove fallback-to-1 behavior',
    '- fail closed when workspace context is missing',
    '- deny or hide cross-workspace access',
    '- keep existing auth/role checks intact or stricter',
    '',
    'TEST REQUIREMENTS:',
    '- prove unauthenticated denial',
    '- prove missing workspace context fails closed',
    '- prove valid workspace-scoped success',
    '- prove cross-workspace denial or not found behavior',
    '- prove static fallback regression removal',
    '',
    'VALIDATION COMMANDS:',
    ...(testFiles.length > 0 ? [`pnpm test -- ${testFiles.join(' ')}`] : []),
    ...VALIDATION_COMMANDS,
    'node scripts/security-hardening-runner.cjs verify',
    'node scripts/security-governor.cjs verify',
    '',
    'STATIC FALLBACK REGRESSION:',
    `rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1" ${searchTargets}`,
    '',
    'DIFF REVIEW BEFORE COMMIT:',
    'git status --short',
    'git diff --stat',
    'git diff --name-only',
    `git diff -- ${(policy.allowed_files || []).join(' ')}`,
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

function evaluatePlanReview(governorPlan, runnerAudit) {
  const findings = {
    blockers: [],
    major: [],
    minor: [],
    advisory: [],
  };
  const requiredCorrections = [];
  const feedbackForGovernor = [];
  const feedbackForImplementer = [];
  let decision = 'APPROVE_PLAN';
  let status = 'PASS';
  let confidence = 'high';
  const risk = governorPlan && governorPlan.strategy ? governorPlan.strategy.risk || 'Unknown' : 'Unknown';

  const malformedGovernor = !governorPlan
    || governorPlan.mode !== 'plan'
    || !governorPlan.strategy
    || !governorPlan.policy
    || !Array.isArray(governorPlan.policy.allowed_files);
  const malformedRunner = !runnerAudit
    || runnerAudit.mode !== 'audit'
    || !runnerAudit.recommendation
    || !runnerAudit.batch_planner;

  if (malformedGovernor || malformedRunner) {
    findings.blockers.push('Runner or Governor output was unavailable or malformed.');
    decision = 'ESCALATE_TO_HUMAN';
    status = 'FAIL';
    confidence = 'low';
  } else {
    const governorDecision = governorPlan.decision;
    const strategy = governorPlan.strategy || {};
    const policy = governorPlan.policy || {};
    const allowedFiles = unique(policy.allowed_files || []);
    const blockedFiles = unique(policy.blocked_files || []);
    const routeFiles = allowedFiles.filter((file) => file.startsWith('src/app/api/'));
    const testFiles = allowedFiles.filter((file) => file.includes('__tests__'));
    const prompt = String(governorPlan.implementation_prompt || '');
    const runnerTarget = runnerAudit.recommendation && Array.isArray(runnerAudit.recommendation.scope_files)
      ? runnerAudit.recommendation.scope_files[0] || ''
      : '';
    const tokensBlocked = blockedFiles.includes('src/app/api/tokens/route.ts') && blockedFiles.includes('src/app/api/tokens/by-agent/route.ts');
    const gatewaySiblingsBlocked = blockedFiles.some((file) => file.includes('src/app/api/gateways/**'));

    if (!['APPROVE_IMPLEMENTATION_PROMPT', 'RECOMMEND_TOOLING_OR_CI', 'HOLD_FOR_MANUAL_REVIEW'].includes(governorDecision)) {
      findings.major.push(`Governor decision ${governorDecision} is not a normal implementation-reviewable state.`);
      decision = 'REQUEST_GOVERNOR_CORRECTION';
      status = 'WARN';
      confidence = 'moderate';
    }

    if (strategy.next_strategy === 'single_route') {
      if (runnerAudit.batch_planner && runnerAudit.batch_planner.next_strategy !== 'single_route') {
        findings.major.push('Governor accepted a single-route plan that does not match the runner strategy.');
      }
      if (runnerTarget && strategy.target !== runnerTarget) {
        findings.major.push('Governor target does not match the runner’s top recommendation.');
      }
      if (routeFiles.length !== 1) {
        findings.major.push('Single-route plan must allow exactly one route file.');
      }
      if (testFiles.length !== 1) {
        findings.major.push('Single-route plan should allow exactly one focused test file.');
      }
      if (!tokensBlocked) {
        findings.major.push('Token routes are not explicitly blocked.');
      }
      if ((strategy.target || '').includes('gateways') && !gatewaySiblingsBlocked) {
        findings.major.push('Unrelated gateway/control routes are not explicitly blocked.');
      }
      if (routeFiles.length === 1 && testFiles.length === 1 && findings.major.length === 0 && findings.blockers.length === 0) {
        feedbackForImplementer.push('Keep the implementation diff to the approved route and one focused security test file only.');
      }
    }

    if (strategy.next_strategy === 'route_family_batch') {
      const scope = routeFiles;
      const routeFamilies = unique(scope.map((file) => getRouteFamily(file)));
      const mixedGateway = scope.some((file) => /(gateway|gateways|terminal|control)/i.test(file)) && routeFamilies.length > 1;
      const mixedTokens = scope.some((file) => /(token|tokens|key|keys|credential|credentials)/i.test(file)) && routeFamilies.length > 1;

      if (mixedGateway || mixedTokens) {
        findings.blockers.push('Gateway/control or token routes were batched with unrelated files.');
        decision = 'REJECT_PLAN';
        status = 'FAIL';
        confidence = 'high';
      }
    }

    const promptChecks = [
      { label: 'strict scope', ok: /STRICT SCOPE:/i.test(prompt) },
      { label: 'blocked files', ok: /BLOCKED FILES:/i.test(prompt) },
      { label: 'no git add .', ok: /do not use git add \./i.test(prompt) },
      { label: 'do not push', ok: /do not push until approved/i.test(prompt) },
      { label: 'runner verify', ok: /node scripts\/security-hardening-runner\.cjs verify/i.test(prompt) },
      { label: 'governor verify', ok: /node scripts\/security-governor\.cjs verify/i.test(prompt) },
      { label: 'validation commands', ok: /pnpm typecheck/i.test(prompt) && /pnpm lint/i.test(prompt) && /pnpm build/i.test(prompt) },
    ];
    const missingPromptItems = promptChecks.filter((item) => !item.ok).map((item) => item.label);
    if (missingPromptItems.length > 0) {
      findings.minor.push(`Governor prompt is missing: ${missingPromptItems.join(', ')}.`);
      feedbackForGovernor.push(`Tighten the implementation prompt to include: ${missingPromptItems.join(', ')}.`);
      if (missingPromptItems.includes('governor verify')) {
        decision = decision === 'APPROVE_PLAN' ? 'APPROVE_WITH_NOTES' : decision;
        status = 'WARN';
        confidence = confidence === 'high' ? 'moderate' : confidence;
      }
    }

    if (governorPlan.status === 'WARN' || runnerAudit.status === 'WARN') {
      findings.advisory.push('Plan review was run from a feature branch or with non-blocking tool warnings, so human review should stay active.');
      if (status === 'PASS') status = 'WARN';
      if (decision === 'APPROVE_PLAN') decision = 'APPROVE_WITH_NOTES';
    }

    if (findings.major.length > 0 && !PLAN_DECISIONS.has(decision)) {
      decision = 'REQUEST_GOVERNOR_CORRECTION';
      status = 'WARN';
      confidence = 'moderate';
    }
    if (findings.major.length > 0 && decision === 'APPROVE_PLAN') {
      decision = 'REQUEST_GOVERNOR_CORRECTION';
      status = 'WARN';
      confidence = 'moderate';
    }
    if (findings.blockers.length > 0 && decision !== 'REJECT_PLAN') {
      decision = 'REJECT_PLAN';
      status = 'FAIL';
      confidence = 'high';
    }
  }

  if (decision === 'REQUEST_GOVERNOR_CORRECTION') {
    requiredCorrections.push('Narrow the allowed files and blocked files to match the approved route scope exactly.');
  }
  if (decision === 'REJECT_PLAN') {
    requiredCorrections.push('Stop implementation and replace the unsafe plan with a narrower approved scope.');
  }
  if (decision === 'ESCALATE_TO_HUMAN') {
    requiredCorrections.push('Human owner must inspect runner/governor availability or malformed outputs before implementation continues.');
  }

  const implementationPrompt = governorPlan && governorPlan.mode === 'plan' ? buildArbiterPrompt(governorPlan) : '';
  const authorization = {
    plan_approved: decision === 'APPROVE_PLAN' || decision === 'APPROVE_WITH_NOTES',
    implementation_approved: false,
    stage_authorized: false,
    commit_authorized: false,
    push_authorized: false,
    pr_create_authorized: false,
    merge_authorized: false,
    human_required: ['implementation start approval', 'push approval', 'PR creation approval', 'merge approval'],
  };
  const finalReleaseGate = {
    stage_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_recommended: false,
  };

  let humanAction = 'Do not start implementation until the Arbiter approves the plan.';
  if (decision === 'APPROVE_PLAN' || decision === 'APPROVE_WITH_NOTES') {
    humanAction = 'Paste the Arbiter-reviewed implementation prompt into Codex, keep scope exact, and do not broaden the diff manually.';
  } else if (decision === 'REQUEST_GOVERNOR_CORRECTION') {
    humanAction = 'Return the plan to the Governor for correction before starting implementation.';
  } else if (decision === 'REJECT_PLAN') {
    humanAction = 'Reject the plan, stop implementation, and replace it with a narrower safe scope.';
  } else if (decision === 'ESCALATE_TO_HUMAN') {
    humanAction = 'Escalate to the human owner before any implementation begins.';
  }

  return {
    status,
    decision,
    confidence,
    risk,
    findings,
    required_corrections: requiredCorrections,
    feedback_for_governor: feedbackForGovernor,
    feedback_for_implementer: feedbackForImplementer,
    implementation_prompt: implementationPrompt,
    authorization,
    final_release_gate: finalReleaseGate,
    human_action: humanAction,
  };
}

function evaluatePatchReview(rootDir, inputs, options = {}) {
  const findings = {
    blockers: [],
    major: [],
    minor: [],
    advisory: [],
  };
  const requiredCorrections = [];
  const feedbackForGovernor = [];
  const feedbackForImplementer = [];
  let decision = 'APPROVE';
  let status = 'PASS';
  let confidence = 'high';

  const runnerVerify = inputs.runner_verify;
  const governorVerify = inputs.governor_verify;
  const diff = inputs.git_diff;

  if (!runnerVerify || !governorVerify || runnerVerify.mode !== 'verify' || governorVerify.mode !== 'verify') {
    findings.blockers.push('Runner or Governor verify output was unavailable or malformed.');
    decision = 'ESCALATE_TO_HUMAN';
    status = 'FAIL';
    confidence = 'low';
  }

  const changedFiles = runnerVerify && runnerVerify.verify ? runnerVerify.verify.changed_files || [] : [];
  const classifications = runnerVerify && runnerVerify.verify && runnerVerify.verify.classifications
    ? runnerVerify.verify.classifications
    : classifyChangedFiles(changedFiles);
  const reviewRisk = inferRiskFromFiles(changedFiles);

  if (runnerVerify && runnerVerify.status === 'FAIL') {
    findings.blockers.push('Runner verify returned FAIL.');
  }
  if (governorVerify && governorVerify.status === 'FAIL') {
    findings.blockers.push('Governor verify returned FAIL.');
  }

  const runnerBlockers = runnerVerify && runnerVerify.verify ? runnerVerify.verify.blocking_conditions || [] : [];
  const governorBlockers = governorVerify && governorVerify.policy ? governorVerify.policy.blocking_reasons || [] : [];
  findings.blockers.push(...runnerBlockers);
  findings.blockers.push(...governorBlockers);

  if (classifications.lockfiles.length > 0 || classifications.package_files.length > 0) {
    findings.blockers.push('Package or lockfile drift is not acceptable in this review scope.');
  }
  if (runnerVerify && runnerVerify.verify && runnerVerify.verify.fallback_regression && runnerVerify.verify.fallback_regression.passed === false) {
    findings.blockers.push('Fallback regression is still present in touched route files.');
  }
  if (runnerVerify && runnerVerify.verify && (runnerVerify.verify.untracked_files || []).some((file) => file.includes('__tests__'))) {
    findings.blockers.push('Untracked intended test files are present and must be staged intentionally.');
  }
  if ((classifications.route_families || []).length > 1) {
    findings.blockers.push(`Broad unrelated route changes detected: ${(classifications.route_families || []).join(', ')}`);
  }
  if (classifications.route_files.length > 0 && (classifications.scripts.length > 0 || classifications.unknown.length > 0)) {
    findings.blockers.push('Route hardening changes are mixed with unrelated scripts or unknown files.');
  }

  const externalReader = options.fileReader || defaultFileReader;
  const rootAwareReader = (filePath) => {
    const normalized = normalizePath(filePath);
    const absolute = path.isAbsolute(normalized) ? normalized : path.join(rootDir, normalized);
    return externalReader(absolute);
  };
  const testQuality = assessTestQuality(classifications.route_files, classifications.test_files, rootAwareReader);
  if (!testQuality.meaningful) {
    findings.major.push(`Focused test coverage is incomplete: ${testQuality.missing.join(', ')}`);
    feedbackForImplementer.push(`Expand focused tests to prove: ${testQuality.missing.join(', ')}.`);
  }

  if (!diff || diff.available === false) {
    findings.major.push('Git diff evidence was unavailable; review confidence is reduced.');
  }

  if (runnerVerify && runnerVerify.verify && classifications.route_files.length > 0 && !runnerVerify.verify.focused_tests.command) {
    findings.major.push('Runner verify did not infer a focused test command for the route changes.');
  }

  if (governorVerify && governorVerify.decision === 'APPROVE_STAGE' && classifications.route_files.length > 0) {
    feedbackForGovernor.push('Governor verify may need a stronger route-review explanation before recommending stage on route changes.');
  }

  if (findings.blockers.length > 0) {
    decision = 'REJECT';
    status = 'FAIL';
    confidence = 'high';
  } else if (findings.major.length > 0) {
    decision = 'REQUEST_CORRECTIONS';
    status = 'WARN';
    confidence = 'moderate';
  } else if ((governorVerify && governorVerify.status === 'WARN') || (runnerVerify && runnerVerify.status === 'WARN')) {
    decision = 'APPROVE_WITH_NOTES';
    status = 'WARN';
    confidence = 'moderate';
  } else if ((changedFiles || []).length === 0) {
    decision = 'APPROVE_WITH_NOTES';
    status = 'WARN';
    confidence = 'moderate';
    findings.advisory.push('Branch is already clean; there is no patch left for the Arbiter to examine directly.');
  }

  if (decision === 'REQUEST_CORRECTIONS') {
    requiredCorrections.push('Strengthen the focused tests and rerun verification before asking for approval again.');
  }
  if (decision === 'REJECT') {
    requiredCorrections.push('Resolve the blocking issues before any commit, push, or PR step.');
  }
  if (decision === 'ESCALATE_TO_HUMAN') {
    requiredCorrections.push('Human owner must inspect the malformed or missing review inputs.');
  }

  const toolingOnly = isToolingOnly(classifications);
  const stagedFiles = runnerVerify && runnerVerify.verify ? runnerVerify.verify.staged_files || [] : [];
  const cleanBranch = Boolean(runnerVerify && runnerVerify.repo && runnerVerify.repo.working_tree_clean);
  const commitRecommended = governorVerify && governorVerify.verify_decision ? Boolean(governorVerify.verify_decision.commit_message) : false;
  const planApproved = decision === 'APPROVE' || decision === 'APPROVE_WITH_NOTES';
  const implementationApproved = decision === 'APPROVE' || decision === 'APPROVE_WITH_NOTES';
  const stageAuthorized = implementationApproved && !cleanBranch && (governorVerify.decision === 'APPROVE_STAGE' || governorVerify.decision === 'APPROVE_COMMIT');
  const commitAuthorized = implementationApproved && (governorVerify.decision === 'APPROVE_COMMIT' || (stageAuthorized && stagedFiles.length > 0) || (toolingOnly && commitRecommended));
  const pushAuthorized = implementationApproved && toolingOnly;
  const prCreateAuthorized = implementationApproved && toolingOnly;

  const authorization = {
    plan_approved: planApproved,
    implementation_approved: implementationApproved,
    stage_authorized: stageAuthorized,
    commit_authorized: commitAuthorized,
    push_authorized: pushAuthorized,
    pr_create_authorized: prCreateAuthorized,
    merge_authorized: false,
    human_required: [],
  };

  if (!implementationApproved) {
    authorization.human_required.push('correction review');
  }
  if (reviewRisk === 'Critical' || reviewRisk === 'High') {
    authorization.push_authorized = false;
    authorization.pr_create_authorized = false;
    authorization.human_required.push('push approval', 'PR creation approval', 'merge approval');
  } else if (toolingOnly) {
    authorization.human_required.push('merge approval');
  } else {
    authorization.human_required.push('push approval', 'PR creation approval', 'merge approval');
  }

  const finalReleaseGate = {
    stage_allowed: stageAuthorized,
    commit_allowed: commitAuthorized,
    push_allowed: authorization.push_authorized,
    pr_allowed: authorization.pr_create_authorized,
    merge_recommended: false,
  };

  let humanAction = 'Hold for Arbiter review before taking the next step.';
  if (decision === 'APPROVE' || decision === 'APPROVE_WITH_NOTES') {
    if (cleanBranch) {
      humanAction = 'No changes remain to stage or commit. Keep push and PR creation behind explicit human approval.';
    } else if (commitAuthorized) {
      humanAction = 'Commit only the reviewed files, but do not push yet unless the Arbiter explicitly allows it.';
    } else if (stageAuthorized) {
      humanAction = 'Stage exactly the reviewed files, rerun verification if needed, and keep push/PR gated.';
    }
  } else if (decision === 'REQUEST_CORRECTIONS') {
    humanAction = 'Apply the required corrections, improve the tests or scope discipline, and rerun Runner/Governor verification.';
  } else if (decision === 'REJECT') {
    humanAction = 'Stop. Resolve the blocking issues before any stage, commit, push, or PR action.';
  } else if (decision === 'ESCALATE_TO_HUMAN') {
    humanAction = 'Escalate to the human owner because the review inputs are incomplete or unreliable.';
  }

  return {
    status,
    decision,
    confidence,
    risk: reviewRisk || 'Unknown',
    findings,
    required_corrections: requiredCorrections,
    feedback_for_governor: unique(feedbackForGovernor),
    feedback_for_implementer: unique(feedbackForImplementer),
    authorization,
    final_release_gate: finalReleaseGate,
    human_action: humanAction,
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    authority: AUTHORITY,
    label: LABEL,
    mode,
    status: data.status,
    decision: data.decision,
    confidence: data.confidence,
    risk: data.risk,
    summary: data.summary || '',
    inputs: data.inputs || {
      runner_available: false,
      governor_available: false,
      git_diff_available: false,
    },
    findings: data.findings || {
      blockers: [],
      major: [],
      minor: [],
      advisory: [],
    },
    required_corrections: data.required_corrections || [],
    feedback_for_governor: data.feedback_for_governor || [],
    feedback_for_implementer: data.feedback_for_implementer || [],
    authorization: data.authorization || {
      plan_approved: false,
      implementation_approved: false,
      stage_authorized: false,
      commit_authorized: false,
      push_authorized: false,
      pr_create_authorized: false,
      merge_authorized: false,
      human_required: [],
    },
    final_release_gate: data.final_release_gate || {
      stage_allowed: false,
      commit_allowed: false,
      push_allowed: false,
      pr_allowed: false,
      merge_recommended: false,
    },
    implementation_prompt: data.implementation_prompt || '',
    human_action: data.human_action || '',
  };
}

function summarizePlan(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: plan',
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `Risk: ${result.risk}`,
    `Confidence: ${result.confidence}`,
    `Next human action: ${result.human_action}`,
  ].join('\n');
}

function summarizeReview(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: review',
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `Risk: ${result.risk}`,
    `Confidence: ${result.confidence}`,
    `Next human action: ${result.human_action}`,
  ].join('\n');
}

function runPlanMode(rootDir, options = {}) {
  const runnerState = getToolResult(rootDir, {
    script: 'scripts/security-hardening-runner.cjs',
    fnName: 'runAuditMode',
    cliMode: 'audit',
  }, { api: options.runnerApi });
  const governorState = getToolResult(rootDir, {
    script: 'scripts/security-governor.cjs',
    fnName: 'runPlanMode',
    cliMode: 'plan',
  }, { api: options.governorApi });

  if (!runnerState.available || !governorState.available) {
    const result = buildOutput('plan', {
      status: 'FAIL',
      decision: 'ESCALATE_TO_HUMAN',
      confidence: 'low',
      risk: 'Unknown',
      inputs: {
        runner_available: runnerState.available,
        governor_available: governorState.available,
        git_diff_available: false,
      },
      findings: {
        blockers: [
          runnerState.available ? null : runnerState.error || 'Runner audit unavailable.',
          governorState.available ? null : governorState.error || 'Governor plan unavailable.',
        ].filter(Boolean),
        major: [],
        minor: [],
        advisory: [],
      },
      required_corrections: ['Repair the missing or malformed runner/governor plan inputs.'],
      feedback_for_governor: [],
      feedback_for_implementer: [],
      authorization: {
        plan_approved: false,
        implementation_approved: false,
        stage_authorized: false,
        commit_authorized: false,
        push_authorized: false,
        pr_create_authorized: false,
        merge_authorized: false,
        human_required: ['human owner review'],
      },
      final_release_gate: {
        stage_allowed: false,
        commit_allowed: false,
        push_allowed: false,
        pr_allowed: false,
        merge_recommended: false,
      },
      human_action: 'Escalate to the human owner because the Runner or Governor plan review input is unavailable.',
    });
    result.summary = summarizePlan(result);
    return result;
  }

  const reviewed = evaluatePlanReview(governorState.result, runnerState.result);
  const result = buildOutput('plan', {
    ...reviewed,
    inputs: {
      runner_available: true,
      governor_available: true,
      git_diff_available: false,
    },
    implementation_prompt: reviewed.implementation_prompt,
  });
  result.summary = summarizePlan(result);
  return result;
}

function runReviewMode(rootDir, options = {}) {
  const runnerState = getToolResult(rootDir, {
    script: 'scripts/security-hardening-runner.cjs',
    fnName: 'runVerifyMode',
    cliMode: 'verify',
  }, { api: options.runnerApi });
  const governorState = getToolResult(rootDir, {
    script: 'scripts/security-governor.cjs',
    fnName: 'runVerifyMode',
    cliMode: 'verify',
  }, { api: options.governorApi });
  const gitDiff = options.gitDiff || collectGitDiff(rootDir, options.commandRunner || runCommand);

  if (!runnerState.available || !governorState.available) {
    const result = buildOutput('review', {
      status: 'FAIL',
      decision: 'ESCALATE_TO_HUMAN',
      confidence: 'low',
      risk: 'Unknown',
      inputs: {
        runner_available: runnerState.available,
        governor_available: governorState.available,
        git_diff_available: gitDiff.available,
      },
      findings: {
        blockers: [
          runnerState.available ? null : runnerState.error || 'Runner verify unavailable.',
          governorState.available ? null : governorState.error || 'Governor verify unavailable.',
        ].filter(Boolean),
        major: [],
        minor: [],
        advisory: [],
      },
      required_corrections: ['Repair the missing or malformed runner/governor verify inputs.'],
      feedback_for_governor: [],
      feedback_for_implementer: [],
      authorization: {
        plan_approved: false,
        implementation_approved: false,
        stage_authorized: false,
        commit_authorized: false,
        push_authorized: false,
        pr_create_authorized: false,
        merge_authorized: false,
        human_required: ['human owner review'],
      },
      final_release_gate: {
        stage_allowed: false,
        commit_allowed: false,
        push_allowed: false,
        pr_allowed: false,
        merge_recommended: false,
      },
      human_action: 'Escalate to the human owner because the Runner or Governor verify input is unavailable.',
    });
    result.summary = summarizeReview(result);
    return result;
  }

  const reviewed = evaluatePatchReview(rootDir, {
    runner_verify: runnerState.result,
    governor_verify: governorState.result,
    git_diff: gitDiff,
  }, {
    fileReader: options.fileReader,
  });

  const result = buildOutput('review', {
    ...reviewed,
    inputs: {
      runner_available: true,
      governor_available: true,
      git_diff_available: gitDiff.available,
    },
  });
  result.summary = summarizeReview(result);
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

  if (mode === 'review') {
    return runReviewMode(rootDir);
  }

  return runPlanMode(rootDir);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  PLAN_DECISIONS,
  REVIEW_DECISIONS,
  assessTestQuality,
  buildArbiterPrompt,
  buildOutput,
  classifyChangedFiles,
  collectGitDiff,
  evaluatePatchReview,
  evaluatePlanReview,
  formatOutput,
  getToolResult,
  inferRiskFromFiles,
  isToolingOnly,
  loadApi,
  main,
  parseJsonWithSummary,
  runCommand,
  runPlanMode,
  runReviewMode,
  summarizePlan,
  summarizeReview,
};

if (require.main === module) {
  const result = main();
  process.stdout.write(formatOutput(result));
}
