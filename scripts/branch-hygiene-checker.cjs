#!/usr/bin/env node
/**
 * branch-hygiene-checker.cjs
 * Observe-only branch hygiene gate for Mission Control. Prevents work on wrong
 * branch, detects dirty-tree contamination, validates branch naming.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Branch Hygiene Checker v1';
const LABEL = 'OBSERVE ONLY / BRANCH GATE';
const VALID_MODES = new Set(['status', 'check']);
const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'release', 'production'];
// Patterns that indicate a well-formed branch: <type>-<description>-v<N> or <type>/<description>
const BRANCH_NAME_RE = /^[a-z][a-z0-9-]+(-v\d+|\/[a-z0-9][a-z0-9-]*[a-z0-9])$/;
const DIVERGENCE_WARN_THRESHOLD = 15;
const UNTRACKED_EXTENSIONS = ['.ts', '.cjs'];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
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

function buildCheck(name, status, message, details) {
  return {
    name,
    status,
    message,
    details: details || '',
  };
}

function isProtectedBranch(branch) {
  if (!branch) return false;
  const lower = branch.toLowerCase();
  return PROTECTED_BRANCHES.some((p) => lower === p || lower.startsWith(`${p}/`));
}

function isBadlyNamedBranch(branch) {
  if (!branch) return { bad: false, reason: '' };
  // Numeric-only
  if (/^\d+$/.test(branch)) return { bad: true, reason: 'numeric-only branch name' };
  // Single word (no hyphen or slash)
  if (!/[-/]/.test(branch)) return { bad: true, reason: 'single-word branch name lacks type prefix or separator' };
  // Empty (already handled by !branch above)
  return { bad: false, reason: '' };
}

function matchesBranchConvention(branch) {
  return BRANCH_NAME_RE.test(branch);
}

function checkBranchHygiene(rootDir, commandRunner) {
  const runner = commandRunner || runCommand;
  const checks = [];

  // 1. not-on-protected-branch
  const branchResult = runner('git', ['branch', '--show-current'], { cwd: rootDir });
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  const onProtected = isProtectedBranch(branch);
  checks.push(buildCheck(
    'not-on-protected-branch',
    onProtected ? 'FAIL' : 'PASS',
    onProtected
      ? `Currently on protected branch: ${branch || '(unknown)'}. Work must happen on a feature branch.`
      : `Not on a protected branch (current: ${branch || '(unknown)'})`,
    branch,
  ));

  // 2. working-tree-clean (WARN, not FAIL)
  const statusResult = runner('git', ['status', '--short'], { cwd: rootDir });
  const statusLines = statusResult.ok ? splitLines(statusResult.stdout) : [];
  const workingTreeClean = statusResult.ok && statusLines.length === 0;
  checks.push(buildCheck(
    'working-tree-clean',
    workingTreeClean ? 'PASS' : 'WARN',
    workingTreeClean
      ? 'Working tree is clean'
      : `Working tree has ${statusLines.length} change(s) — ensure nothing unintended is staged`,
    statusLines.join('; '),
  ));

  // 3. branch-name-convention (WARN)
  const badName = isBadlyNamedBranch(branch);
  const followsConvention = branch ? matchesBranchConvention(branch) : false;
  let namingStatus = 'PASS';
  let namingMessage = `Branch name follows convention: ${branch}`;
  if (!branch) {
    namingStatus = 'WARN';
    namingMessage = 'Could not determine current branch name';
  } else if (badName.bad) {
    namingStatus = 'WARN';
    namingMessage = `Branch name issue: ${badName.reason} (${branch})`;
  } else if (!followsConvention) {
    namingStatus = 'WARN';
    namingMessage = `Branch name '${branch}' does not match expected pattern <type>-<description>-v<N> or <type>/<description>`;
  }
  checks.push(buildCheck(
    'branch-name-convention',
    namingStatus,
    namingMessage,
    branch,
  ));

  // 4. no-untracked-intended-files (WARN)
  const untrackedResult = runner('git', ['status', '--short'], { cwd: rootDir });
  const untrackedLines = untrackedResult.ok ? splitLines(untrackedResult.stdout) : [];
  const untrackedIntended = untrackedLines
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter((file) => UNTRACKED_EXTENSIONS.some((ext) => file.endsWith(ext)));
  checks.push(buildCheck(
    'no-untracked-intended-files',
    untrackedIntended.length > 0 ? 'WARN' : 'PASS',
    untrackedIntended.length > 0
      ? `${untrackedIntended.length} untracked file(s) with .ts/.cjs extension — should these be staged? ${untrackedIntended.join(', ')}`
      : 'No untracked .ts or .cjs files found',
    untrackedIntended.join(', '),
  ));

  // 5. branch-divergence (WARN if > 15 commits ahead)
  let divergeResult = runner('git', ['log', '--oneline', 'main...HEAD'], { cwd: rootDir });
  let divergeBase = 'main...HEAD';
  if (!divergeResult.ok) {
    divergeResult = runner('git', ['log', '--oneline', 'origin/main...HEAD'], { cwd: rootDir });
    divergeBase = 'origin/main...HEAD';
  }
  const aheadLines = divergeResult.ok ? splitLines(divergeResult.stdout) : [];
  const aheadCount = aheadLines.length;
  checks.push(buildCheck(
    'branch-divergence',
    aheadCount > DIVERGENCE_WARN_THRESHOLD ? 'WARN' : 'PASS',
    aheadCount > DIVERGENCE_WARN_THRESHOLD
      ? `Branch is ${aheadCount} commits ahead of ${divergeBase} — consider rebasing or splitting the work`
      : `Branch divergence is within limit: ${aheadCount} commit(s) ahead of ${divergeBase}`,
    `${aheadCount} commits ahead via ${divergeBase}`,
  ));

  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const warnCount = checks.filter((c) => c.status === 'WARN').length;
  const overallStatus = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'PASS';

  return {
    checks,
    branch,
    working_tree_clean: workingTreeClean,
    ahead_count: aheadCount,
    untracked_intended: untrackedIntended,
    fail_count: failCount,
    warn_count: warnCount,
    overall_status: overallStatus,
    summary: [
      `${AGENT} (${LABEL})`,
      `Status: ${overallStatus}`,
      `Branch: ${branch || '(unknown)'}`,
      `Working tree clean: ${workingTreeClean}`,
      `Commits ahead: ${aheadCount}`,
      `Untracked .ts/.cjs files: ${untrackedIntended.length}`,
      `Failures: ${failCount} | Warnings: ${warnCount}`,
    ].join('\n'),
  };
}

function buildOutput(rootDir, commandRunner, now) {
  const ts = (now instanceof Date ? now : new Date()).toISOString();
  const result = checkBranchHygiene(rootDir, commandRunner);

  return {
    agent: AGENT,
    label: LABEL,
    observe_only: true,
    mode: 'check',
    status: result.overall_status,
    checked_at: ts,
    branch: result.branch,
    working_tree_clean: result.working_tree_clean,
    ahead_count: result.ahead_count,
    untracked_intended: result.untracked_intended,
    checks: result.checks,
    fail_count: result.fail_count,
    warn_count: result.warn_count,
    summary: result.summary,
  };
}

function buildStatusOutput(rootDir) {
  return {
    agent: AGENT,
    label: LABEL,
    observe_only: true,
    mode: 'status',
    status: 'PASS',
    root_dir: normalizePath(rootDir),
    protected_branches: PROTECTED_BRANCHES,
    divergence_warn_threshold: DIVERGENCE_WARN_THRESHOLD,
    untracked_extensions: UNTRACKED_EXTENSIONS,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: status',
      'Self-report: operational',
      `Protected branches: ${PROTECTED_BRANCHES.join(', ')}`,
      `Divergence warn threshold: ${DIVERGENCE_WARN_THRESHOLD} commits`,
    ].join('\n'),
  };
}

function parseArgs(argv = []) {
  const args = argv.slice();
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  return { mode };
}

function main(argv, options) {
  const args = argv !== undefined ? argv : process.argv.slice(2);
  const opts = options || {};
  const { mode } = parseArgs(args);
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');
  const commandRunner = opts.commandRunner || runCommand;
  const now = opts.now instanceof Date ? opts.now : new Date();

  let result;
  if (mode === 'check') {
    result = buildOutput(rootDir, commandRunner, now);
  } else {
    result = buildStatusOutput(rootDir);
  }

  return result;
}

module.exports = {
  AGENT,
  LABEL,
  PROTECTED_BRANCHES,
  DIVERGENCE_WARN_THRESHOLD,
  UNTRACKED_EXTENSIONS,
  buildCheck,
  buildOutput,
  buildStatusOutput,
  checkBranchHygiene,
  isProtectedBranch,
  isBadlyNamedBranch,
  matchesBranchConvention,
  main,
  normalizePath,
  runCommand,
  splitLines,
  unique,
};

if (require.main === module) {
  const result = main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`);
}
