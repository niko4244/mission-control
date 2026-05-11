#!/usr/bin/env node
/**
 * release-manager.cjs
 * Subordinate to Release Governor. Prepares bounded release actions after governor approval.
 * Can mutate, stage, commit — but NEVER push, PR, or merge autonomously.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Release Manager v1';
const LABEL = 'EXECUTOR / RELEASE-GOVERNOR-SUPERVISED';
const VALID_MODES = new Set(['status', 'prepare', 'verify']);
const REQUIRES_HUMAN_FOR = ['push', 'create_pr', 'merge'];
const BLOCKED_ACTIONS = ['push', 'create_pr', 'merge', 'autonomous push', 'autonomous pr creation', 'autonomous merge'];

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

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const nextValue = args[index + 1];
    if (nextValue && !nextValue.startsWith('--')) {
      options[key] = nextValue;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return { mode, options };
}

function getCurrentBranch(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['branch', '--show-current'], { cwd: rootDir });
  return result.ok ? result.stdout.trim() : '';
}

function getWorkingTreeStatus(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['status', '--short'], { cwd: rootDir });
  const lines = result.ok ? splitLines(result.stdout) : [];
  return {
    ok: result.ok,
    clean: lines.length === 0,
    lines,
    error: result.ok ? '' : (result.stderr || result.error || 'Unable to read git status'),
  };
}

function getDiffStats(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['diff', '--stat'], { cwd: rootDir });
  return {
    ok: result.ok,
    stat: result.ok ? result.stdout.trim() : '',
    error: result.ok ? '' : (result.stderr || result.error || 'Unable to read diff stats'),
  };
}

function getRecentCommits(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['--no-pager', 'log', '--oneline', '-5'], { cwd: rootDir });
  return result.ok ? splitLines(result.stdout) : [];
}

function checkGovernorAvailability(rootDir) {
  const scriptPath = path.join(rootDir, 'scripts', 'release-governor.cjs');
  return fs.existsSync(scriptPath);
}

function buildBaseOutput(mode) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: 'PASS',
    requires_human_for: REQUIRES_HUMAN_FOR.slice(),
    blocked_actions: BLOCKED_ACTIONS.slice(),
    observe_only: true,
    warnings: [],
    blockers: [],
    metadata: {},
    summary: '',
  };
}

function runStatusMode(rootDir, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const result = buildBaseOutput('status');
  const governorAvailable = checkGovernorAvailability(rootDir);
  const branch = getCurrentBranch(rootDir, commandRunner);
  const treeStatus = getWorkingTreeStatus(rootDir, commandRunner);
  const recentCommits = getRecentCommits(rootDir, commandRunner);

  result.governor_available = governorAvailable;
  result.branch = branch;
  result.working_tree_clean = treeStatus.clean;

  if (!governorAvailable) {
    result.warnings.push('Release Governor script not found at scripts/release-governor.cjs');
  }

  result.metadata = {
    root_dir: normalizePath(rootDir),
    governor_script: normalizePath(path.join('scripts', 'release-governor.cjs')),
    governor_available: governorAvailable,
    branch,
    working_tree_clean: treeStatus.clean,
    git_status_lines: treeStatus.lines,
    recent_commits: recentCommits,
    pending_actions: treeStatus.clean
      ? []
      : ['Working tree has uncommitted changes — review before preparing a release'],
  };

  result.status = result.blockers.length > 0 ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS';
  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: status',
    `Status: ${result.status}`,
    `Branch: ${branch || 'unknown'}`,
    `Governor available: ${governorAvailable}`,
    `Working tree clean: ${treeStatus.clean}`,
    `Requires human for: ${REQUIRES_HUMAN_FOR.join(', ')}`,
  ].join('\n');

  return result;
}

function validatePrepareInputs(branch, commitMessage) {
  const errors = [];

  if (!branch) {
    errors.push('Missing required --branch argument');
  } else if (branch === 'main' || branch === 'master') {
    errors.push(`Release preparation is not allowed from protected branch: ${branch}`);
  }

  if (!commitMessage) {
    errors.push('Missing required --commit-message argument');
  }

  return errors;
}

function buildRecommendedCommands(branch, commitMessage, stagedFiles) {
  const commands = [];

  if (stagedFiles && stagedFiles.length > 0) {
    for (const file of stagedFiles) {
      commands.push(`git add -- ${normalizePath(file)}`);
    }
  } else {
    commands.push('git add -- <specify exact files, not git add .>');
  }

  commands.push(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);

  return commands;
}

function runPrepareMode(rootDir, branch, commitMessage, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const result = buildBaseOutput('prepare');
  const validationErrors = validatePrepareInputs(branch, commitMessage);

  if (validationErrors.length > 0) {
    result.status = 'FAIL';
    result.blockers = validationErrors;
    result.recommended_commands = [];
    result.validation_steps = [];
    result.rollback_notes = [];
    result.metadata = {
      root_dir: normalizePath(rootDir),
      branch: branch || '',
      commit_message: commitMessage || '',
      validation_errors: validationErrors,
    };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: prepare',
      `Status: ${result.status}`,
      `Blockers: ${validationErrors.join('; ')}`,
      `Requires human for: ${REQUIRES_HUMAN_FOR.join(', ')}`,
    ].join('\n');
    return result;
  }

  const currentBranch = getCurrentBranch(rootDir, commandRunner);
  const treeStatus = getWorkingTreeStatus(rootDir, commandRunner);
  const recentCommits = getRecentCommits(rootDir, commandRunner);

  if (!treeStatus.ok) {
    result.status = 'FAIL';
    result.blockers.push(treeStatus.error || 'Unable to read working tree status');
  }

  if (treeStatus.ok && treeStatus.clean) {
    result.warnings.push('Working tree has no changes — nothing to stage or commit');
  }

  if (currentBranch && currentBranch !== branch) {
    result.warnings.push(`Current branch (${currentBranch}) does not match requested branch (${branch})`);
  }

  const recommendedCommands = buildRecommendedCommands(branch, commitMessage, null);

  const validationSteps = [
    {
      step: 'typecheck',
      command: 'pnpm typecheck',
      message: 'Run TypeScript type checks before committing',
    },
    {
      step: 'lint',
      command: 'pnpm lint',
      message: 'Run ESLint before committing',
    },
    {
      step: 'test',
      command: 'pnpm test',
      message: 'Run unit tests before committing',
    },
    {
      step: 'build',
      command: 'pnpm build',
      message: 'Verify build succeeds before requesting push',
    },
  ];

  const rollbackNotes = [
    `git checkout ${currentBranch || 'main'} -- to return to previous branch`,
    'git reset HEAD~1 -- to undo a mistaken commit (before push)',
    'git restore -- <file> -- to discard local changes to a specific file',
    'Push, PR, and merge require human authorization — no autonomous rollback needed for those steps',
  ];

  result.recommended_commands = recommendedCommands;
  result.validation_steps = validationSteps;
  result.rollback_notes = rollbackNotes;
  result.metadata = {
    root_dir: normalizePath(rootDir),
    branch,
    current_branch: currentBranch,
    commit_message: commitMessage,
    working_tree_clean: treeStatus.clean,
    git_status_lines: treeStatus.lines,
    recent_commits: recentCommits,
    observe_only: true,
    note: 'These commands are recommendations only. The Release Manager does not execute them without explicit governor token.',
  };

  result.status = result.blockers.length > 0 ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS';
  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: prepare',
    `Status: ${result.status}`,
    `Branch: ${branch}`,
    `Commit message: ${commitMessage}`,
    `Recommended commands: ${recommendedCommands.length}`,
    `Requires human for: ${REQUIRES_HUMAN_FOR.join(', ')}`,
  ].join('\n');

  return result;
}

function runVerifyMode(rootDir, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const result = buildBaseOutput('verify');
  const branch = getCurrentBranch(rootDir, commandRunner);
  const treeStatus = getWorkingTreeStatus(rootDir, commandRunner);
  const diffStats = getDiffStats(rootDir, commandRunner);
  const recentCommits = getRecentCommits(rootDir, commandRunner);

  if (!treeStatus.ok) {
    result.status = 'FAIL';
    result.blockers.push(treeStatus.error || 'Unable to read git working tree');
  }

  const releaseReady = treeStatus.ok && treeStatus.clean;

  if (!releaseReady && treeStatus.ok) {
    result.warnings.push('Working tree has uncommitted changes — not release-ready');
  }

  result.branch = branch;
  result.working_tree_clean = treeStatus.clean;
  result.release_ready = releaseReady;
  result.diff_stat = diffStats.stat;
  result.recent_commits = recentCommits;
  result.git_status_lines = treeStatus.lines;

  result.metadata = {
    root_dir: normalizePath(rootDir),
    branch,
    working_tree_clean: treeStatus.clean,
    release_ready: releaseReady,
    diff_stat: diffStats.stat,
    git_status_lines: treeStatus.lines,
    recent_commits: recentCommits,
    diff_stat_available: diffStats.ok,
  };

  result.status = result.blockers.length > 0 ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS';
  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: verify',
    `Status: ${result.status}`,
    `Branch: ${branch || 'unknown'}`,
    `Working tree clean: ${treeStatus.clean}`,
    `Release ready: ${releaseReady}`,
    `Requires human for: ${REQUIRES_HUMAN_FOR.join(', ')}`,
  ].join('\n');

  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'prepare') {
    const branch = parsed.options.branch || '';
    const commitMessage = parsed.options['commit-message'] || '';
    return runPrepareMode(rootDir, branch, commitMessage, options);
  }

  if (parsed.mode === 'verify') {
    return runVerifyMode(rootDir, options);
  }

  return runStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  REQUIRES_HUMAN_FOR,
  BLOCKED_ACTIONS,
  VALID_MODES,
  buildBaseOutput,
  buildRecommendedCommands,
  checkGovernorAvailability,
  formatOutput,
  getCurrentBranch,
  getDiffStats,
  getRecentCommits,
  getWorkingTreeStatus,
  main,
  normalizePath,
  parseArgs,
  runCommand,
  runPrepareMode,
  runStatusMode,
  runVerifyMode,
  splitLines,
  unique,
  validatePrepareInputs,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'unknown',
      status: 'FAIL',
      error: error && error.message ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
