#!/usr/bin/env node
/**
 * pr-readiness-checker.cjs
 * Observe-only PR readiness gate for Mission Control. Confirms a branch is
 * ready for PR creation. Checks all preconditions before any push/PR action.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'PR Readiness Checker v1';
const LABEL = 'OBSERVE ONLY / PR GATE';
const VALID_MODES = new Set(['status', 'check']);
const PROTECTED_BRANCHES = ['main', 'master'];
const REQUIRED_CONFIG_FILES = [
  path.join('config', 'mission-control-bot-registry.json'),
  path.join('config', 'mission-control-policy.json'),
];
const REQUIRED_VALIDATION_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];
const DIFF_WARN_THRESHOLD = 8;
const DIFF_FAIL_THRESHOLD = 20;

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

function checkPRReadiness(rootDir, commandRunner) {
  const runner = commandRunner || runCommand;
  const checks = [];

  // 1. branch-not-main
  const branchResult = runner('git', ['branch', '--show-current'], { cwd: rootDir });
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  const isProtectedBranch = PROTECTED_BRANCHES.includes(branch);
  checks.push(buildCheck(
    'branch-not-main',
    isProtectedBranch ? 'FAIL' : 'PASS',
    isProtectedBranch
      ? `Current branch is protected: ${branch || '(unknown)'}. PRs must come from a feature branch.`
      : `Branch is safe for PR: ${branch || '(unknown)'}`,
    branch,
  ));

  // 2. working-tree-clean
  const statusResult = runner('git', ['status', '--short'], { cwd: rootDir });
  const statusLines = statusResult.ok ? splitLines(statusResult.stdout) : [];
  const workingTreeClean = statusResult.ok && statusLines.length === 0;
  checks.push(buildCheck(
    'working-tree-clean',
    workingTreeClean ? 'PASS' : 'FAIL',
    workingTreeClean
      ? 'Working tree is clean'
      : `Working tree has ${statusLines.length} uncommitted change(s)`,
    statusLines.join('; '),
  ));

  // 3. has-commits-ahead
  let logResult = runner('git', ['log', '--oneline', 'main...HEAD'], { cwd: rootDir });
  let logBase = 'main...HEAD';
  if (!logResult.ok) {
    logResult = runner('git', ['log', '--oneline', 'origin/main...HEAD'], { cwd: rootDir });
    logBase = 'origin/main...HEAD';
  }
  const commitLines = logResult.ok ? splitLines(logResult.stdout) : [];
  const commitCount = commitLines.length;
  checks.push(buildCheck(
    'has-commits-ahead',
    commitCount >= 1 ? 'PASS' : 'FAIL',
    commitCount >= 1
      ? `Branch has ${commitCount} commit(s) ahead of ${logBase}`
      : `No commits ahead of ${logBase}. Nothing to PR.`,
    `${commitCount} commit(s) via ${logBase}`,
  ));

  // 4. config-files-present
  const missingConfigFiles = REQUIRED_CONFIG_FILES.filter(
    (relative) => !fs.existsSync(path.join(rootDir, relative))
  );
  checks.push(buildCheck(
    'config-files-present',
    missingConfigFiles.length === 0 ? 'PASS' : 'FAIL',
    missingConfigFiles.length === 0
      ? 'All required config files are present'
      : `Missing config file(s): ${missingConfigFiles.join(', ')}`,
    missingConfigFiles.join(', '),
  ));

  // 5. validation-scripts-present
  let packageJson = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch (_) {
    packageJson = null;
  }
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};
  const missingScripts = REQUIRED_VALIDATION_SCRIPTS.filter((s) => typeof scripts[s] !== 'string');
  checks.push(buildCheck(
    'validation-scripts-present',
    missingScripts.length === 0 ? 'PASS' : 'FAIL',
    missingScripts.length === 0
      ? 'All required validation scripts are present in package.json'
      : `package.json missing script(s): ${missingScripts.join(', ')}`,
    missingScripts.join(', '),
  ));

  // 6. no-lockfile-drift (WARN only)
  const statusAllResult = runner('git', ['status', '--short'], { cwd: rootDir });
  const statusAllLines = statusAllResult.ok ? splitLines(statusAllResult.stdout) : [];
  const modifiedFiles = statusAllLines.map((line) => line.slice(3).trim());
  const lockfileDirty = modifiedFiles.some((f) => f === 'pnpm-lock.yaml' || f.endsWith('pnpm-lock.yaml'));
  const packageJsonDirty = modifiedFiles.some((f) => f === 'package.json' || f.endsWith('package.json'));
  const lockfileDrift = lockfileDirty && packageJsonDirty;
  checks.push(buildCheck(
    'no-lockfile-drift',
    lockfileDrift ? 'WARN' : 'PASS',
    lockfileDrift
      ? 'Both pnpm-lock.yaml and package.json are modified — verify dependency changes are intentional'
      : 'No lockfile drift detected',
    lockfileDrift ? 'pnpm-lock.yaml and package.json both modified' : '',
  ));

  // 7. diff-bounded
  let diffResult = runner('git', ['diff', '--name-only', 'main...HEAD'], { cwd: rootDir });
  let diffBase = 'main...HEAD';
  if (!diffResult.ok) {
    diffResult = runner('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: rootDir });
    diffBase = 'origin/main...HEAD';
  }
  const diffFiles = diffResult.ok ? splitLines(diffResult.stdout).map(normalizePath) : [];
  const changedFileCount = diffFiles.length;
  let diffStatus = 'PASS';
  let diffMessage = `${changedFileCount} file(s) changed (within safe limit of ${DIFF_WARN_THRESHOLD})`;
  if (changedFileCount > DIFF_FAIL_THRESHOLD) {
    diffStatus = 'FAIL';
    diffMessage = `${changedFileCount} files changed — exceeds maximum of ${DIFF_FAIL_THRESHOLD}. Scope must be reduced before PR.`;
  } else if (changedFileCount > DIFF_WARN_THRESHOLD) {
    diffStatus = 'WARN';
    diffMessage = `${changedFileCount} files changed — exceeds warning threshold of ${DIFF_WARN_THRESHOLD}. Consider splitting the PR.`;
  }
  checks.push(buildCheck(
    'diff-bounded',
    diffStatus,
    diffMessage,
    `${changedFileCount} file(s) via ${diffBase}`,
  ));

  const failChecks = checks.filter((c) => c.status === 'FAIL');
  const warnChecks = checks.filter((c) => c.status === 'WARN');
  const ready = failChecks.length === 0;

  return {
    checks,
    ready,
    branch,
    changed_file_count: changedFileCount,
    commit_count: commitCount,
    requires_human_for: ['push', 'create_pr', 'merge'],
    fail_count: failChecks.length,
    warn_count: warnChecks.length,
  };
}

function buildOutput(rootDir, commandRunner, now) {
  const ts = (now instanceof Date ? now : new Date()).toISOString();
  const result = checkPRReadiness(rootDir, commandRunner);
  const overallStatus = result.fail_count > 0 ? 'FAIL' : result.warn_count > 0 ? 'WARN' : 'PASS';

  const output = {
    agent: AGENT,
    label: LABEL,
    observe_only: true,
    mode: 'check',
    status: overallStatus,
    checked_at: ts,
    branch: result.branch,
    ready: result.ready,
    changed_file_count: result.changed_file_count,
    commit_count: result.commit_count,
    requires_human_for: result.requires_human_for,
    checks: result.checks,
    summary: [
      `${AGENT} (${LABEL})`,
      `Status: ${overallStatus}`,
      `Branch: ${result.branch || '(unknown)'}`,
      `Ready for PR: ${result.ready}`,
      `Changed files: ${result.changed_file_count}`,
      `Commits ahead: ${result.commit_count}`,
      `Failures: ${result.fail_count} | Warnings: ${result.warn_count}`,
      `Human required for: ${result.requires_human_for.join(', ')}`,
    ].join('\n'),
  };

  return output;
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
    required_config_files: REQUIRED_CONFIG_FILES.map(normalizePath),
    required_validation_scripts: REQUIRED_VALIDATION_SCRIPTS,
    diff_warn_threshold: DIFF_WARN_THRESHOLD,
    diff_fail_threshold: DIFF_FAIL_THRESHOLD,
    requires_human_for: ['push', 'create_pr', 'merge'],
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: status',
      'Self-report: operational',
      `Protected branches: ${PROTECTED_BRANCHES.join(', ')}`,
      `Diff warn threshold: ${DIFF_WARN_THRESHOLD} | Diff fail threshold: ${DIFF_FAIL_THRESHOLD}`,
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
  REQUIRED_CONFIG_FILES,
  REQUIRED_VALIDATION_SCRIPTS,
  DIFF_WARN_THRESHOLD,
  DIFF_FAIL_THRESHOLD,
  buildCheck,
  buildOutput,
  buildStatusOutput,
  checkPRReadiness,
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
