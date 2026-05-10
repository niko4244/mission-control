#!/usr/bin/env node
/**
 * security-hardening-runner.cjs
 * Observe-only audit/verify runner for repeated workspace hardening workflows.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Security Hardening Runner v1';
const LABEL = 'OBSERVE ONLY';
const DEFAULT_SCAN_ROOT = 'src/app/api';
const VALID_MODES = new Set(['audit', 'verify']);
const DEFAULT_VALIDATION_COMMANDS = [
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm build',
];

const WORKSPACE_PATTERNS = [
  { label: 'workspace_id ?? 1', kind: 'fallback_to_one', regex: /workspace_id\s*\?\?\s*1/g },
  { label: 'workspaceId ?? 1', kind: 'fallback_to_one', regex: /workspaceId\s*\?\?\s*1/g },
  { label: 'auth.user.workspace_id', kind: 'workspace_reference', regex: /auth\.user\.workspace_id/g },
  { label: 'user.workspace_id', kind: 'workspace_reference', regex: /(?<!auth\.|current)user\.workspace_id/g },
  { label: 'currentUser.workspace_id', kind: 'workspace_reference', regex: /currentUser\.workspace_id/g },
  { label: 'workspace_id:', kind: 'workspace_property', regex: /workspace_id\s*:/g },
  { label: 'workspaceId:', kind: 'workspace_property', regex: /workspaceId\s*:/g },
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ROUTE_FILE_RE = /(^|\/)route\.(t|j)sx?$/i;
const TEST_FILE_RE = /(^|\/)(__tests__\/.*|.*\.(test|spec)\.(t|j)sx?)$/i;
const LOCKFILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const PACKAGE_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function commandValue(result) {
  return result && result.ok ? result.stdout.trim() : '';
}

function splitLines(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/);
}

function collectFilesRecursive(dirPath) {
  const results = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function isRouteFile(filePath) {
  return ROUTE_FILE_RE.test(normalizePath(filePath));
}

function isTestFile(filePath) {
  return TEST_FILE_RE.test(normalizePath(filePath));
}

function classifyFileKind(filePath) {
  if (isRouteFile(filePath)) return 'route';
  if (isTestFile(filePath)) return 'test';
  return 'non-route';
}

function detectExportedMethods(content) {
  const found = [];
  for (const method of HTTP_METHODS) {
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\s*\\(`).test(content)) {
      found.push(method);
    }
  }
  return found;
}

function findWorkspacePatterns(fileContents) {
  const matches = [];
  const lines = splitLines(fileContents);

  lines.forEach((line, index) => {
    for (const pattern of WORKSPACE_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      const lineMatches = line.match(regex);
      if (!lineMatches) continue;
      for (const match of lineMatches) {
        matches.push({
          label: pattern.label,
          kind: pattern.kind,
          match,
          line: index + 1,
          snippet: line.trim(),
        });
      }
    }
  });

  return matches;
}

function getRouteFamily(filePath) {
  const normalized = normalizePath(filePath);
  const prefix = `${DEFAULT_SCAN_ROOT}/`;
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  const parts = relative.split('/').filter(Boolean);
  const trimmed = parts.slice(0, -1).filter((part) => !part.startsWith('['));

  if (trimmed.length === 0) return 'root';
  if (trimmed[0] === 'v1' && trimmed[1]) return `v1/${trimmed[1]}`;
  return trimmed[0];
}

function getDomainName(filePath) {
  const family = getRouteFamily(filePath);
  const parts = family.split('/');
  return parts[parts.length - 1];
}

function riskFromLabel(label) {
  if (label === 'Critical') return 3;
  if (label === 'High') return 2;
  if (label === 'Medium') return 1;
  return 0;
}

function classifyRouteRisk(filePath, methods = [], matches = []) {
  const normalized = normalizePath(filePath).toLowerCase();
  const fallbackCount = matches.filter((match) => match.kind === 'fallback_to_one').length;
  const hasMutation = methods.some((method) => method !== 'GET');
  const methodSet = new Set(methods);

  if (isTestFile(normalized) || /\/(docs|examples)\//.test(normalized)) {
    return {
      risk: 'Low',
      risk_level: 0,
      reason: 'Docs/examples/tests are low-priority audit surfaces.',
      priority_score: 1,
    };
  }

  const keywordChecks = [
    { risk: 'Critical', reason: 'credential/key/token route', priority_score: 96, test: /(credential|credentials|secret|secrets|key|keys|token|tokens)/ },
    { risk: 'Critical', reason: 'approval route', priority_score: 94, test: /(approval|approvals)/ },
    { risk: 'Critical', reason: 'delivery or dispatch route', priority_score: 98, test: /(deliver|delivery|dispatch)/ },
    { risk: 'Critical', reason: 'execution/run route', priority_score: 99, test: /(^|\/)(run|runs)(\/|$)|execution|execute/ },
    { risk: 'Critical', reason: 'gateway/terminal/control-adjacent route', priority_score: 97, test: /(gateway|gateways|terminal|control)/ },
    { risk: 'High', reason: 'webhook or notification route', priority_score: 78, test: /(webhook|webhooks|notification|notifications)/ },
    { risk: 'High', reason: 'workflow or pipeline route', priority_score: 76, test: /(workflow|workflows|pipeline|pipelines)/ },
    { risk: 'High', reason: 'project management route', priority_score: 74, test: /(project|projects)/ },
    { risk: 'Medium', reason: 'workspace-scoped agent/chat/status/search surface', priority_score: 52, test: /(agent|agents|chat|status|search|activity|activities|alert|alerts|mention|mentions)/ },
  ];

  for (const check of keywordChecks) {
    if (check.test.test(normalized)) {
      return {
        risk: check.risk,
        risk_level: riskFromLabel(check.risk),
        reason: check.reason,
        priority_score: check.priority_score + Math.min(fallbackCount, 3),
      };
    }
  }

  if (hasMutation || methodSet.size > 1) {
    return {
      risk: 'High',
      risk_level: 2,
      reason: 'mutating or mixed-method API route',
      priority_score: 70 + Math.min(fallbackCount, 3),
    };
  }

  return {
    risk: 'Medium',
    risk_level: 1,
    reason: 'read-only workspace-scoped API route',
    priority_score: 45 + Math.min(fallbackCount, 3),
  };
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function scanFiles(rootDir, scanRoot = DEFAULT_SCAN_ROOT) {
  const absoluteRoot = path.join(rootDir, scanRoot);
  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`Scan root not found: ${scanRoot}`);
  }

  const allFiles = collectFilesRecursive(absoluteRoot);
  const routeFindings = [];
  const fileKinds = { route: 0, test: 0, 'non-route': 0 };
  let totalFindings = 0;
  let fallbackToOneFindings = 0;

  for (const filePath of allFiles) {
    const contents = readText(filePath);
    const relativePath = normalizePath(path.relative(rootDir, filePath));
    const fileKind = classifyFileKind(relativePath);
    fileKinds[fileKind] += 1;

    const matches = findWorkspacePatterns(contents);
    totalFindings += matches.length;
    fallbackToOneFindings += matches.filter((match) => match.kind === 'fallback_to_one').length;

    if (fileKind !== 'route' || matches.length === 0) {
      continue;
    }

    const methods = detectExportedMethods(contents);
    const risk = classifyRouteRisk(relativePath, methods, matches);
    routeFindings.push({
      file: relativePath,
      family: getRouteFamily(relativePath),
      methods,
      line_count: splitLines(contents).length,
      match_count: matches.length,
      fallback_count: matches.filter((match) => match.kind === 'fallback_to_one').length,
      workspace_reference_count: matches.filter((match) => match.kind !== 'fallback_to_one').length,
      patterns: unique(matches.map((match) => match.label)),
      matches,
      risk: risk.risk,
      risk_level: risk.risk_level,
      risk_reason: risk.reason,
      priority_score: risk.priority_score,
    });
  }

  routeFindings.sort((left, right) => (
    right.risk_level - left.risk_level
      || right.priority_score - left.priority_score
      || left.line_count - right.line_count
      || right.fallback_count - left.fallback_count
      || left.file.localeCompare(right.file)
  ));

  return {
    root: scanRoot,
    patterns: WORKSPACE_PATTERNS.map((pattern) => pattern.label),
    total_findings: totalFindings,
    fallback_to_one_findings: fallbackToOneFindings,
    file_counts: fileKinds,
    route_findings: routeFindings,
  };
}

function parseGitStatus(statusText) {
  const lines = splitLines(statusText).filter(Boolean);
  const entries = lines.map((line) => {
    const x = line[0] || ' ';
    const y = line[1] || ' ';
    const rawPath = line.slice(3).trim();
    const file = normalizePath(rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath);
    return {
      raw: line,
      x,
      y,
      file,
      untracked: x === '?' && y === '?',
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ',
    };
  });

  return {
    entries,
    lines,
    clean: entries.length === 0,
    dirty_files: entries.map((entry) => entry.file),
    untracked_files: entries.filter((entry) => entry.untracked).map((entry) => entry.file),
    staged_files: entries.filter((entry) => entry.staged).map((entry) => entry.file),
    unstaged_files: entries.filter((entry) => entry.unstaged).map((entry) => entry.file),
  };
}

function getRepoState(rootDir, commandRunner = runCommand) {
  const branchResult = commandRunner('git', ['branch', '--show-current'], { cwd: rootDir });
  const statusResult = commandRunner('git', ['status', '--short'], { cwd: rootDir });
  const headResult = commandRunner('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootDir });
  const originMainResult = commandRunner('git', ['rev-parse', '--short', 'origin/main'], { cwd: rootDir });
  const localMainResult = commandRunner('git', ['rev-parse', '--short', 'main'], { cwd: rootDir });
  const aheadBehindResult = commandRunner('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { cwd: rootDir });

  const branch = commandValue(branchResult);
  const detached = !branch;
  const status = parseGitStatus(statusResult.stdout || '');
  const head = commandValue(headResult);
  const originMain = commandValue(originMainResult) || null;
  const localMain = commandValue(localMainResult) || null;
  const aheadBehindRaw = commandValue(aheadBehindResult);

  let ahead = null;
  let behind = null;
  if (aheadBehindRaw) {
    const [aheadValue, behindValue] = aheadBehindRaw.split(/\s+/);
    ahead = Number.isFinite(Number(aheadValue)) ? Number(aheadValue) : null;
    behind = Number.isFinite(Number(behindValue)) ? Number(behindValue) : null;
  }

  const warnings = [];
  if (detached) warnings.push('Detached HEAD; branch-specific recommendations may be unreliable.');
  if (!status.clean) warnings.push('Working tree is dirty.');
  if (!originMain) warnings.push('origin/main unavailable; remote freshness cannot be confirmed.');
  if (branch && branch !== 'main') warnings.push(`Running from feature branch ${branch}; audit preconditions expect main before branching.`);
  if (behind !== null && behind > 0) warnings.push(`Current branch is behind origin/main by ${behind} commit(s).`);

  return {
    branch: branch || '(detached HEAD)',
    head,
    origin_main: originMain,
    local_main: localMain,
    working_tree_clean: status.clean,
    git_status_short: status.lines,
    is_main: branch === 'main',
    detached,
    local_main_current_with_origin: Boolean(localMain && originMain && localMain === originMain),
    current_branch_current_with_origin_main: Boolean(head && originMain && head === originMain),
    ahead,
    behind,
    dirty_files: status.dirty_files,
    untracked_files: status.untracked_files,
    staged_files: status.staged_files,
    unstaged_files: status.unstaged_files,
    warnings,
  };
}

function humanizeFamily(family) {
  return family
    .split('/')
    .map((part) => part.toUpperCase() === part ? part : part.replace(/-/g, ' '))
    .join(' ')
    .replace(/\bv1\b/gi, 'v1');
}

function inferFocusedTestCandidates(routeFile) {
  const family = getRouteFamily(routeFile);
  const slug = family.replace(/\//g, '-');
  const domain = getDomainName(routeFile);

  const candidates = [
    `src/lib/__tests__/${slug}-route-security.test.ts`,
    `src/lib/__tests__/${domain}-route-security.test.ts`,
    `src/lib/__tests__/${domain}-security.test.ts`,
  ];

  if (domain === 'notifications') {
    candidates.unshift('src/lib/__tests__/notifications-route-security.test.ts');
  } else if (domain === 'webhooks') {
    candidates.unshift('src/lib/__tests__/webhooks-route-security.test.ts');
  } else if (domain === 'pipelines') {
    candidates.unshift('src/lib/__tests__/pipeline-run-route-security.test.ts');
  } else if (domain === 'agents') {
    candidates.unshift('src/lib/__tests__/agent-route-security.test.ts');
  } else if (domain === 'requests') {
    candidates.unshift('src/lib/__tests__/request.test.ts', 'src/lib/__tests__/request-route-security.test.ts');
  }

  return unique(candidates);
}

function chooseNextRecommendation(scanResults) {
  const candidates = (scanResults.route_findings || []).filter((finding) => finding.fallback_count > 0);

  if (candidates.length === 0) {
    return {
      title: 'No remaining fallback-to-1 route hardening target detected',
      branch: '',
      risk: 'Low',
      scope_files: [],
      why_next: 'Audit scan did not find any remaining fallback-to-1 route file under src/app/api.',
      excluded: [],
      implementation_prompt: 'No implementation prompt generated because no fallback-to-1 route target was detected.',
    };
  }

  const chosen = candidates[0];
  const branch = `harden-${slugify(chosen.family)}-workspace-route`;
  const title = `Harden ${humanizeFamily(chosen.family)} workspace route`;
  const focusedTests = inferFocusedTestCandidates(chosen.file);
  const excluded = candidates
    .slice(1, 4)
    .map((candidate) => `Excluded ${candidate.file}: keep this PR narrower than the separate ${candidate.family} ${candidate.risk} surface.`);

  const whyNext =
    `${chosen.file} is a ${chosen.risk} ${chosen.risk_reason} with ${chosen.fallback_count} ` +
    `fallback-to-1 hit(s) in only ${chosen.line_count} line(s), which makes it the smallest safe next PR ` +
    'without broadening into unrelated route families.';

  const recommendation = {
    title,
    branch,
    risk: chosen.risk,
    scope_files: [chosen.file],
    why_next: whyNext,
    excluded,
    implementation_prompt: '',
  };

  recommendation.implementation_prompt = generateImplementationPrompt(recommendation, {
    routeFile: chosen.file,
    focusedTests,
  });

  return recommendation;
}

function generateImplementationPrompt(recommendation, context = {}) {
  const routeFile = context.routeFile || recommendation.scope_files[0] || 'src/app/api/.../route.ts';
  const focusedTests = Array.isArray(context.focusedTests) && context.focusedTests.length > 0
    ? context.focusedTests
    : ['src/lib/__tests__/route-security.test.ts'];

  const searchCommand = `rg -n "workspace_id \\?\\? 1|workspaceId \\?\\? 1|auth\\.user\\.workspace_id|user\\.workspace_id|currentUser\\.workspace_id" ${routeFile} src/lib/__tests__`;
  const focusedTestCommand = `pnpm test -- ${focusedTests[0]}`;

  return [
    'PROJECT: Mission Control',
    'LOCAL REPO: C:\\Users\\nikma\\mission-control',
    'CANONICAL REPO: https://github.com/niko4244/mission-control',
    '',
    'TASK TYPE:',
    'Focused workspace-route hardening PR.',
    '',
    'GOAL:',
    `Harden ${routeFile} by removing fallback-to-1 workspace resolution and preserving the smallest safe route-only scope.`,
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
    `Create from updated main:\n${recommendation.branch}`,
    '',
    'STRICT SCOPE:',
    '- audit first',
    `- prefer one route file only: ${routeFile}`,
    '- smallest safe scope only',
    '- no broad refactor',
    '- no repo-wide cleanup',
    '',
    'FILES TO INSPECT:',
    `- ${routeFile}`,
    ...focusedTests.map((file) => `- ${file}`),
    '',
    'FILES NOT TO TOUCH:',
    '- unrelated routes',
    '- auth helpers unless already required by existing hardening patterns',
    '- workspace enforcement helpers unless already required by existing hardening patterns',
    '- package-lock.json',
    '- pnpm-lock.yaml',
    '- docs unless absolutely necessary',
    '',
    'AUDIT / SEARCH COMMAND:',
    searchCommand,
    '',
    'IMPLEMENTATION REQUIREMENTS:',
    '- inspect the route first and identify every fallback-to-1 workspace path',
    '- replace implicit workspace fallback with fail-closed workspace enforcement using existing repo patterns',
    '- preserve existing route behavior outside the hardening change',
    '- keep the PR limited to the selected route and one focused security test file',
    '',
    'SECURITY REQUIREMENTS:',
    '- no workspace_id ?? 1',
    '- no workspaceId ?? 1',
    '- fail closed when workspace context is missing',
    '- do not allow cross-workspace access',
    '- keep existing auth/role checks intact or stricter',
    '',
    'TEST REQUIREMENTS:',
    '- add or update one focused route-security test',
    '- cover denied unauthenticated access where applicable',
    '- cover missing workspace context',
    '- cover workspace-scoped authorized access',
    '- assert the route source no longer contains fallback-to-1 patterns',
    '',
    'VALIDATION COMMANDS:',
    focusedTestCommand,
    'pnpm typecheck',
    'pnpm lint',
    'pnpm test',
    'pnpm build',
    '',
    'DIFF REVIEW BEFORE COMMIT:',
    'git status --short',
    'git diff --stat',
    'git diff --name-only',
    `git diff -- ${routeFile} ${focusedTests[0]}`,
    '',
    'GIT RULES:',
    '- do not use git add .',
    '- only stage exact changed files',
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

function classifyChangedFiles(files) {
  const categories = {
    route: [],
    test: [],
    docs: [],
    scripts: [],
    package: [],
    lockfiles: [],
    unknown: [],
  };

  for (const file of unique(files.map(normalizePath))) {
    const basename = path.posix.basename(file);

    if (isRouteFile(file)) {
      categories.route.push(file);
    } else if (isTestFile(file)) {
      categories.test.push(file);
    } else if (file.startsWith('scripts/')) {
      categories.scripts.push(file);
    } else if (LOCKFILE_NAMES.has(basename)) {
      categories.lockfiles.push(file);
    } else if (PACKAGE_FILES.has(basename)) {
      categories.package.push(file);
    } else if (/^(docs\/|README|CHANGELOG|.*\.md$)/i.test(file)) {
      categories.docs.push(file);
    } else {
      categories.unknown.push(file);
    }
  }

  return categories;
}

function routeFamiliesForFiles(routeFiles) {
  return unique(routeFiles.map(getRouteFamily));
}

function focusedTestRegexesForRoute(routeFile) {
  const family = getRouteFamily(routeFile);
  const domain = getDomainName(routeFile);
  const slug = family.replace(/\//g, '-');

  const regexes = [
    new RegExp(`${slug}.*(security|route).*\\.test\\.ts$`, 'i'),
    new RegExp(`${domain}.*(security|route).*\\.test\\.ts$`, 'i'),
  ];

  if (domain === 'notifications') {
    regexes.push(/notifications.*security.*\.test\.ts$/i);
  } else if (domain === 'webhooks') {
    regexes.push(/webhooks.*security.*\.test\.ts$/i);
  } else if (domain === 'pipelines') {
    regexes.push(/pipeline.*security.*\.test\.ts$/i);
  } else if (domain === 'agents') {
    regexes.push(/agent.*security.*\.test\.ts$/i);
  } else if (domain === 'requests') {
    regexes.push(/requests?.*test\.ts$/i, /request.*security.*\.test\.ts$/i);
  } else if (domain === 'runs') {
    regexes.push(/runs?.*security.*\.test\.ts$/i, /run.*security.*\.test\.ts$/i);
  }

  return regexes;
}

function findFocusedTests(routeFiles, changedTestFiles, untrackedFiles) {
  const found = [];
  const missing = [];
  const blockingUntracked = [];

  for (const routeFile of routeFiles) {
    const regexes = focusedTestRegexesForRoute(routeFile);
    const matchesChanged = changedTestFiles.filter((file) => regexes.some((regex) => regex.test(path.posix.basename(file))));
    const matchesUntracked = untrackedFiles.filter((file) => regexes.some((regex) => regex.test(path.posix.basename(file))));

    if (matchesUntracked.length > 0) {
      for (const file of [...matchesChanged, ...matchesUntracked]) {
        found.push(file);
      }
      for (const file of matchesUntracked) {
        blockingUntracked.push(file);
      }
      continue;
    }

    if (matchesChanged.length > 0) {
      for (const file of matchesChanged) {
        found.push(file);
      }
      continue;
    }

    missing.push(routeFile);
  }

  return {
    found: unique(found),
    missing: unique(missing),
    blocking_untracked: unique(blockingUntracked),
  };
}

function scanTouchedRouteFiles(rootDir, routeFiles) {
  const matches = [];

  for (const routeFile of routeFiles) {
    const absolute = path.join(rootDir, routeFile);
    if (!fs.existsSync(absolute)) continue;
    const contents = readText(absolute);
    const fileMatches = findWorkspacePatterns(contents)
      .filter((match) => match.kind === 'fallback_to_one')
      .map((match) => ({ file: routeFile, ...match }));
    matches.push(...fileMatches);
  }

  return matches;
}

function inferCommitMessage(changedCategories) {
  if (changedCategories.route.length > 0) {
    const families = routeFamiliesForFiles(changedCategories.route);
    if (families.length === 1) {
      return `Harden ${humanizeFamily(families[0])} workspace route`;
    }
    return 'Harden workspace routes';
  }

  if (changedCategories.scripts.length > 0 && changedCategories.test.length > 0) {
    return 'Add security hardening runner v1';
  }

  if (changedCategories.scripts.length > 0) {
    return 'Update local tooling';
  }

  return '';
}

function verifyCurrentBranchState(rootDir, repoState, options = {}) {
  const changedFiles = unique([
    ...repoState.dirty_files,
  ]);
  const changedCategories = classifyChangedFiles(changedFiles);
  const routeFamilies = routeFamiliesForFiles(changedCategories.route);
  const blockingConditions = [];
  const warnings = [];

  if (repoState.is_main && !repoState.working_tree_clean) {
    blockingConditions.push('Running on main with dirty files is not allowed.');
  } else if (repoState.is_main) {
    warnings.push('Running on main; stage/commit from a feature branch instead.');
  }

  if (changedCategories.lockfiles.length > 0) {
    blockingConditions.push(`Lockfile drift detected: ${changedCategories.lockfiles.join(', ')}`);
  }

  if (changedCategories.package.length > 0) {
    blockingConditions.push(`Unexpected package file change detected: ${changedCategories.package.join(', ')}`);
  }

  if (routeFamilies.length > 1) {
    blockingConditions.push(`Multiple unrelated route families changed: ${routeFamilies.join(', ')}`);
  }

  const extraProductionFiles = changedCategories.unknown.filter((file) => file.startsWith('src/') && !isTestFile(file));
  if (extraProductionFiles.length > 0) {
    blockingConditions.push(`Production runtime files outside strict route scope changed: ${extraProductionFiles.join(', ')}`);
  }

  const fallbackMatches = scanTouchedRouteFiles(rootDir, changedCategories.route);
  if (fallbackMatches.length > 0) {
    blockingConditions.push(
      `Fallback-to-1 pattern still present in touched route files: ${unique(fallbackMatches.map((match) => match.file)).join(', ')}`
    );
  }

  const focusedTests = findFocusedTests(
    changedCategories.route,
    changedCategories.test,
    repoState.untracked_files,
  );

  if (focusedTests.blocking_untracked.length > 0) {
    blockingConditions.push(`Untracked intended test files must be staged intentionally: ${focusedTests.blocking_untracked.join(', ')}`);
  }

  if (changedCategories.route.length > 0 && focusedTests.missing.length > 0) {
    blockingConditions.push(`Missing focused test coverage for route changes: ${focusedTests.missing.join(', ')}`);
  }

  if (!repoState.origin_main) {
    warnings.push('origin/main unavailable; cannot confirm freshness against remote main.');
  }

  if (changedCategories.docs.length > 0) {
    warnings.push(`Docs changed alongside implementation: ${changedCategories.docs.join(', ')}`);
  }

  if (changedCategories.route.length === 0 && changedCategories.test.length === 0 && changedCategories.scripts.length === 0 && changedFiles.length > 0) {
    warnings.push('Changed files do not match the expected route/test/tooling categories cleanly.');
  }

  const stageableFiles = changedFiles.filter((file) => !LOCKFILE_NAMES.has(path.posix.basename(file)));
  const stageRecommended = blockingConditions.length === 0 && stageableFiles.length > 0;
  const focusedTestCommand = focusedTests.found.length > 0 ? `pnpm test -- ${focusedTests.found.join(' ')}` : '';
  if (changedCategories.route.length > 0 && !focusedTestCommand) {
    blockingConditions.push('No clear focused test command could be inferred from the changed route scope.');
  }

  const commitMessage = blockingConditions.length === 0 ? inferCommitMessage(changedCategories) : '';

  return {
    changed_files: changedFiles,
    untracked_files: repoState.untracked_files,
    dirty_files: repoState.dirty_files,
    staged_files: repoState.staged_files,
    unstaged_files: repoState.unstaged_files,
    classifications: {
      route_files: changedCategories.route,
      test_files: changedCategories.test,
      docs: changedCategories.docs,
      scripts: changedCategories.scripts,
      package_files: changedCategories.package,
      lockfiles: changedCategories.lockfiles,
      unknown: changedCategories.unknown,
      route_families: routeFamilies,
    },
    blocking_conditions: unique(blockingConditions),
    warnings: unique(warnings),
    fallback_regression: {
      passed: fallbackMatches.length === 0,
      matches: fallbackMatches,
    },
    focused_tests: {
      found: focusedTests.found,
      missing: focusedTests.missing,
      command: focusedTestCommand,
    },
    stage_recommendation: {
      recommended: stageRecommended,
      files: stageRecommended ? stageableFiles : [],
    },
    commit_recommendation: {
      recommended: blockingConditions.length === 0 && Boolean(commitMessage),
      message: commitMessage,
    },
    push_recommendation: {
      recommended: false,
    },
  };
}

function summarizeAudit(repoState, scanResults, recommendation, status) {
  const topFinding = scanResults.route_findings[0];
  const topFindingText = topFinding
    ? `${topFinding.file} (${topFinding.risk}, ${topFinding.fallback_count} fallback hit(s))`
    : 'No route findings';

  return [
    `${AGENT} (${LABEL})`,
    `Mode: audit`,
    `Status: ${status}`,
    `Repo: branch=${repoState.branch}, head=${repoState.head || 'unknown'}, clean=${repoState.working_tree_clean}`,
    `Top finding: ${topFindingText}`,
    `Recommended next PR: ${recommendation.title}${recommendation.scope_files[0] ? ` -> ${recommendation.scope_files[0]}` : ''}`,
    `Next human action: review the generated implementation prompt and approve the single-route scope before coding.`,
  ].join('\n');
}

function summarizeVerify(repoState, verifyResult, status) {
  const topRisk = verifyResult.blocking_conditions[0] || verifyResult.warnings[0] || 'No blocking conditions detected.';
  const stageText = verifyResult.stage_recommendation.recommended
    ? verifyResult.stage_recommendation.files.join(', ')
    : 'Not recommended yet';

  return [
    `${AGENT} (${LABEL})`,
    `Mode: verify`,
    `Status: ${status}`,
    `Repo: branch=${repoState.branch}, head=${repoState.head || 'unknown'}, clean=${repoState.working_tree_clean}`,
    `Top risk: ${topRisk}`,
    `Stage recommendation: ${stageText}`,
    `Next human action: resolve blockers first, then stage only the exact recommended files once the scope is clean.`,
  ].join('\n');
}

function buildOutput(mode, data) {
  const emptyScan = {
    root: DEFAULT_SCAN_ROOT,
    patterns: WORKSPACE_PATTERNS.map((pattern) => pattern.label),
    total_findings: 0,
    fallback_to_one_findings: 0,
    route_findings: [],
  };
  const emptyRecommendation = {
    title: '',
    branch: '',
    risk: 'Low',
    scope_files: [],
    why_next: '',
    excluded: [],
    implementation_prompt: '',
  };
  const emptyVerify = {
    changed_files: [],
    untracked_files: [],
    blocking_conditions: [],
    warnings: [],
    fallback_regression: { passed: true, matches: [] },
    focused_tests: { found: [], missing: [] },
    stage_recommendation: { recommended: false, files: [] },
    commit_recommendation: { recommended: false, message: '' },
    push_recommendation: { recommended: false },
  };

  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status,
    risk_level: data.risk_level,
    repo: data.repo,
    scan: data.scan || emptyScan,
    recommendation: data.recommendation || emptyRecommendation,
    verify: data.verify || emptyVerify,
    summary: data.summary || '',
  };
}

function runAuditMode(rootDir, commandRunner = runCommand) {
  const repoState = getRepoState(rootDir, commandRunner);
  const scanResults = scanFiles(rootDir, DEFAULT_SCAN_ROOT);
  const recommendation = chooseNextRecommendation(scanResults);

  let status = 'PASS';
  if (!repoState.working_tree_clean || !repoState.is_main || !repoState.origin_main || repoState.detached) {
    status = 'WARN';
  }

  const topRiskLevel = Math.max(
    scanResults.route_findings[0] ? scanResults.route_findings[0].risk_level : 0,
    status === 'WARN' ? 1 : 0,
  );
  const summary = summarizeAudit(repoState, scanResults, recommendation, status);

  return buildOutput('audit', {
    status,
    risk_level: topRiskLevel,
    repo: repoState,
    scan: scanResults,
    recommendation,
    summary,
  });
}

function runVerifyMode(rootDir, commandRunner = runCommand) {
  const repoState = getRepoState(rootDir, commandRunner);
  const verify = verifyCurrentBranchState(rootDir, repoState);

  const status = verify.blocking_conditions.length > 0
    ? 'FAIL'
    : verify.warnings.length > 0
      ? 'WARN'
      : 'PASS';

  const summary = summarizeVerify(repoState, verify, status);

  return buildOutput('verify', {
    status,
    risk_level: verify.blocking_conditions.length > 0 ? 3 : verify.warnings.length > 0 ? 1 : 0,
    repo: repoState,
    verify,
    summary,
  });
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2)) {
  const mode = VALID_MODES.has(String(argv[0] || '').toLowerCase())
    ? String(argv[0]).toLowerCase()
    : 'audit';
  const rootDir = path.resolve(__dirname, '..');

  if (!fs.existsSync(rootDir)) {
    throw new Error(`Repository root not found: ${rootDir}`);
  }

  if (mode === 'verify') {
    return runVerifyMode(rootDir);
  }

  return runAuditMode(rootDir);
}

module.exports = {
  AGENT,
  LABEL,
  DEFAULT_SCAN_ROOT,
  DEFAULT_VALIDATION_COMMANDS,
  WORKSPACE_PATTERNS,
  buildOutput,
  chooseNextRecommendation,
  classifyChangedFiles,
  classifyRouteRisk,
  detectExportedMethods,
  findWorkspacePatterns,
  formatOutput,
  generateImplementationPrompt,
  getDomainName,
  getRepoState,
  getRouteFamily,
  inferFocusedTestCandidates,
  main,
  parseGitStatus,
  routeFamiliesForFiles,
  runAuditMode,
  runCommand,
  runVerifyMode,
  scanFiles,
  verifyCurrentBranchState,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
    process.exit(0);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'audit',
      status: 'FAIL',
      risk_level: 3,
      error: error && error.message ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
