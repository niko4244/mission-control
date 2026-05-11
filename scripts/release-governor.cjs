#!/usr/bin/env node
/**
 * release-governor.cjs
 * Observe-only release readiness gate for Mission Control PR lifecycle safety.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Release Governor v1';
const LABEL = 'OBSERVE ONLY';
const REQUIRED_JSON_FILES = [
  path.join('config', 'mission-control-bot-registry.json'),
  path.join('config', 'mission-control-policy.json'),
  'package.json',
];
const REQUIRED_VALIDATION_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];
const BLOCKED_ACTIONS = [
  'autonomous stage',
  'autonomous commit',
  'autonomous push',
  'autonomous pr creation',
  'autonomous merge',
  'autonomous deploy',
  'autonomous release',
];
const UNSAFE_OPTION_KEYS = [
  'allowExecution',
  'allowMutations',
  'allowStage',
  'allowCommit',
  'allowPush',
  'allowCreatePr',
  'allowMerge',
  'allowDeploy',
  'allowRelease',
  'execute',
  'stage',
  'commit',
  'push',
  'createPr',
  'merge',
  'deploy',
  'release',
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function isTruthyOption(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
  }
  return false;
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

function readJsonFile(filePath, readFile = (target) => fs.readFileSync(target, 'utf8')) {
  return JSON.parse(readFile(filePath));
}

function parseStatusPath(line) {
  const trimmed = String(line || '');
  if (!trimmed) return '';

  const pathText = trimmed.length > 3 ? trimmed.slice(3).trim() : trimmed.trim();
  if (pathText.includes(' -> ')) {
    const parts = pathText.split(' -> ');
    return normalizePath(parts[parts.length - 1]);
  }

  return normalizePath(pathText);
}

function parseStatusPaths(statusLines) {
  return unique((statusLines || []).map(parseStatusPath));
}

function matchesReleaseSensitivePattern(filePath) {
  const normalized = normalizePath(filePath);
  const basename = path.posix.basename(normalized);

  return normalized === 'package.json'
    || normalized === 'pnpm-lock.yaml'
    || normalized === 'package-lock.json'
    || basename.startsWith('next.config.')
    || normalized.startsWith('src/app/api/')
    || normalized.startsWith('src/lib/security/')
    || normalized.startsWith('src/lib/gateways/')
    || normalized.startsWith('scripts/')
    || normalized === 'config/mission-control-policy.json'
    || normalized === 'config/mission-control-bot-registry.json'
    || normalized.startsWith('.github/');
}

function findUnsafeOptionAttempts(options = {}) {
  const attempted = [];

  for (const key of UNSAFE_OPTION_KEYS) {
    if (isTruthyOption(options[key])) {
      attempted.push(key);
    }
  }

  return unique(attempted);
}

function inspectGitState(rootDir, commandRunner = runCommand) {
  const branchResult = commandRunner('git', ['branch', '--show-current'], { cwd: rootDir });
  const statusResult = commandRunner('git', ['status', '--short'], { cwd: rootDir });
  const logResult = commandRunner('git', ['--no-pager', 'log', '--oneline', '-5'], { cwd: rootDir });

  let diffResult = commandRunner('git', ['diff', '--name-only', 'main...HEAD'], { cwd: rootDir });
  let diffBase = 'main...HEAD';
  let diffAvailable = diffResult.ok;

  if (!diffResult.ok) {
    diffResult = commandRunner('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: rootDir });
    diffBase = 'origin/main...HEAD';
    diffAvailable = diffResult.ok;
  }

  return {
    branch: branchResult.ok ? branchResult.stdout.trim() : '',
    status_lines: statusResult.ok ? splitLines(statusResult.stdout) : [],
    working_tree_clean: statusResult.ok ? splitLines(statusResult.stdout).length === 0 : false,
    recent_commits: logResult.ok ? splitLines(logResult.stdout) : [],
    diff_available: diffAvailable,
    diff_base: diffBase,
    diff_files: diffAvailable ? splitLines(diffResult.stdout).map(normalizePath) : [],
    errors: {
      branch: branchResult.ok ? '' : (branchResult.stderr || branchResult.error || 'Unable to read current branch'),
      status: statusResult.ok ? '' : (statusResult.stderr || statusResult.error || 'Unable to read git status'),
      log: logResult.ok ? '' : (logResult.stderr || logResult.error || 'Unable to read git log'),
      diff: diffAvailable ? '' : (diffResult.stderr || diffResult.error || 'Unable to diff against main'),
    },
  };
}

function loadRequiredFiles(rootDir, options = {}) {
  const readFile = options.readFile || ((target) => fs.readFileSync(target, 'utf8'));
  const exists = options.exists || fs.existsSync;
  const loaded = {
    registry: null,
    policy: null,
    packageJson: null,
    errors: [],
  };

  const targets = {
    registry: path.join(rootDir, 'config', 'mission-control-bot-registry.json'),
    policy: path.join(rootDir, 'config', 'mission-control-policy.json'),
    packageJson: path.join(rootDir, 'package.json'),
  };

  for (const key of Object.keys(targets)) {
    const absolute = targets[key];
    if (!exists(absolute)) {
      loaded.errors.push(`Required file missing: ${normalizePath(path.relative(rootDir, absolute))}`);
      continue;
    }

    try {
      loaded[key] = readJsonFile(absolute, readFile);
    } catch (error) {
      loaded.errors.push(`Failed to parse ${normalizePath(path.relative(rootDir, absolute))}: ${error.message}`);
    }
  }

  return loaded;
}

function buildValidationSteps(packageJson) {
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};

  return REQUIRED_VALIDATION_SCRIPTS.map((step) => ({
    step,
    status: typeof scripts[step] === 'string' ? 'PASS' : 'WARN',
    command: typeof scripts[step] === 'string' ? scripts[step] : '',
    message: typeof scripts[step] === 'string'
      ? `Validation script available: ${step}`
      : `Validation script missing: ${step}`,
  }));
}

function buildCheck(name, status, message, details) {
  return {
    name,
    status,
    message,
    details: details || '',
  };
}

function determineRiskLevel(status, warnings, releaseSensitiveFiles) {
  if (status === 'FAIL') return 3;
  if ((releaseSensitiveFiles || []).length > 0) return 2;
  if ((warnings || []).length > 0) return 1;
  return 0;
}

function runReleaseGovernor(options = {}) {
  const rootDir = options.rootDir
    || process.env.MISSION_CONTROL_ROOT_DIR
    || path.resolve(__dirname, '..');
  const commandRunner = options.commandRunner || runCommand;
  const now = options.now instanceof Date ? options.now : new Date();
  const checks = [];
  const warnings = [];
  const blockers = [];
  const nextActions = [];

  const unsafeOptions = findUnsafeOptionAttempts(options);
  if (unsafeOptions.length > 0) {
    blockers.push(`Observe-only mode does not allow execution-enabling options: ${unsafeOptions.join(', ')}`);
    nextActions.push('Remove execution, merge, deploy, or release flags and rerun in observe-only mode');
  }

  const loadedFiles = loadRequiredFiles(rootDir, options);
  for (const error of loadedFiles.errors) {
    blockers.push(error);
  }

  const gitState = inspectGitState(rootDir, commandRunner);
  if (gitState.errors.branch) blockers.push(gitState.errors.branch);
  if (gitState.errors.status) blockers.push(gitState.errors.status);
  if (gitState.errors.log) warnings.push(gitState.errors.log);
  if (!gitState.diff_available) warnings.push('Diff against main was unavailable');

  const diffFiles = gitState.diff_available ? gitState.diff_files : [];
  const dirtyFiles = parseStatusPaths(gitState.status_lines);
  const changedFiles = unique([...diffFiles, ...dirtyFiles]);
  const releaseSensitiveFiles = changedFiles.filter(matchesReleaseSensitivePattern);

  if (!gitState.working_tree_clean) {
    warnings.push('Working tree has uncommitted changes');
    nextActions.push('Review or commit local changes before treating the branch as release-ready');
  }

  if (releaseSensitiveFiles.length > 0) {
    warnings.push(`Release-sensitive files changed: ${releaseSensitiveFiles.join(', ')}`);
    nextActions.push('Run focused human review for release-sensitive files before any PR or merge step');
  }

  const registryBots = Array.isArray(loadedFiles.registry && loadedFiles.registry.bots)
    ? loadedFiles.registry.bots
    : [];
  const plannedBots = registryBots.filter((bot) => bot.status !== 'implemented').map((bot) => bot.id);
  if (plannedBots.length > 0) {
    warnings.push(`Planned bots remain unimplemented: ${plannedBots.join(', ')}`);
    nextActions.push('Keep release governance human-supervised while planned bot layers remain unimplemented');
  }

  const validationSteps = loadedFiles.packageJson ? buildValidationSteps(loadedFiles.packageJson) : [];
  const missingValidationScripts = validationSteps.filter((step) => step.status !== 'PASS').map((step) => step.step);
  if (missingValidationScripts.length > 0) {
    warnings.push(`Missing validation scripts in package.json: ${missingValidationScripts.join(', ')}`);
    nextActions.push('Restore or add the expected validation scripts before automating release checks further');
  }

  checks.push(buildCheck(
    'observe-only',
    unsafeOptions.length === 0 ? 'PASS' : 'FAIL',
    unsafeOptions.length === 0
      ? 'Release Governor remained observe-only'
      : 'Execution-enabling options were rejected',
    unsafeOptions.join(', '),
  ));
  checks.push(buildCheck(
    'config:registry',
    loadedFiles.registry ? 'PASS' : 'FAIL',
    loadedFiles.registry
      ? 'Mission Control bot registry loaded'
      : 'Mission Control bot registry unavailable',
    'config/mission-control-bot-registry.json',
  ));
  checks.push(buildCheck(
    'config:policy',
    loadedFiles.policy ? 'PASS' : 'FAIL',
    loadedFiles.policy
      ? 'Mission Control policy loaded'
      : 'Mission Control policy unavailable',
    'config/mission-control-policy.json',
  ));
  checks.push(buildCheck(
    'config:package-json',
    loadedFiles.packageJson ? 'PASS' : 'FAIL',
    loadedFiles.packageJson ? 'package.json loaded' : 'package.json unavailable',
    'package.json',
  ));
  checks.push(buildCheck(
    'git:working-tree',
    gitState.working_tree_clean ? 'PASS' : 'WARN',
    gitState.working_tree_clean ? 'Working tree is clean' : 'Working tree has local changes',
    gitState.status_lines.join('; '),
  ));
  checks.push(buildCheck(
    'git:diff-main',
    gitState.diff_available ? 'PASS' : 'WARN',
    gitState.diff_available ? `Diff available against ${gitState.diff_base}` : 'Diff against main unavailable',
    gitState.diff_available ? changedFiles.join(', ') : gitState.errors.diff,
  ));
  checks.push(buildCheck(
    'release-sensitive-files',
    releaseSensitiveFiles.length === 0 ? 'PASS' : 'WARN',
    releaseSensitiveFiles.length === 0 ? 'No release-sensitive files changed' : 'Release-sensitive files changed',
    releaseSensitiveFiles.join(', '),
  ));
  checks.push(buildCheck(
    'validation-scripts',
    missingValidationScripts.length === 0 ? 'PASS' : 'WARN',
    missingValidationScripts.length === 0
      ? 'Validation scripts are available in package.json'
      : 'One or more validation scripts are missing from package.json',
    missingValidationScripts.join(', '),
  ));

  if (blockers.length === 0 && nextActions.length === 0) {
    nextActions.push('No release readiness blockers detected by the observe-only governor');
  }

  const status = blockers.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';
  const riskLevel = determineRiskLevel(status, warnings, releaseSensitiveFiles);

  return {
    agent: AGENT,
    label: LABEL,
    status,
    risk_level: riskLevel,
    checked_at: now.toISOString(),
    branch: gitState.branch,
    working_tree_clean: gitState.working_tree_clean,
    changed_files: changedFiles,
    release_sensitive_files: releaseSensitiveFiles,
    checks,
    blockers,
    failures: blockers.slice(),
    warnings: unique(warnings),
    blocked_actions: BLOCKED_ACTIONS.slice(),
    recommended_next_actions: unique(nextActions),
    next_actions: unique(nextActions),
    summary: {
      observe_only: true,
      branch: gitState.branch,
      diff_base: gitState.diff_available ? gitState.diff_base : '',
      changed_file_count: changedFiles.length,
      release_sensitive_file_count: releaseSensitiveFiles.length,
      planned_bot_count: plannedBots.length,
      working_tree_clean: gitState.working_tree_clean,
    },
    validation: {
      steps: validationSteps,
    },
    metadata: {
      root_dir: normalizePath(rootDir),
      required_files: REQUIRED_JSON_FILES.slice(),
      recent_commits: gitState.recent_commits,
      git_status_short: gitState.status_lines,
      diff_available: gitState.diff_available,
      diff_base: gitState.diff_available ? gitState.diff_base : '',
      package_scripts_present: loadedFiles.packageJson && loadedFiles.packageJson.scripts
        ? Object.keys(loadedFiles.packageJson.scripts).sort()
        : [],
      planned_bots: plannedBots,
    },
  };
}

function main() {
  return runReleaseGovernor();
}

module.exports = {
  AGENT,
  BLOCKED_ACTIONS,
  LABEL,
  REQUIRED_JSON_FILES,
  REQUIRED_VALIDATION_SCRIPTS,
  UNSAFE_OPTION_KEYS,
  buildCheck,
  buildValidationSteps,
  determineRiskLevel,
  findUnsafeOptionAttempts,
  inspectGitState,
  isTruthyOption,
  loadRequiredFiles,
  main,
  matchesReleaseSensitivePattern,
  normalizePath,
  parseStatusPath,
  parseStatusPaths,
  readJsonFile,
  runCommand,
  runReleaseGovernor,
  splitLines,
  unique,
};

if (require.main === module) {
  const result = main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
