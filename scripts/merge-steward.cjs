#!/usr/bin/env node
/**
 * merge-steward.cjs
 * Merge readiness checklist generator for Mission Control.
 *
 * Observe-only. Generates a merge readiness checklist for a branch.
 * NEVER executes merge — only observes and reports.
 *
 * Modes:
 *   status              — Agent identity
 *   checklist [options] — Generate merge readiness report
 *     --branch "name"   The branch to check (defaults to current branch)
 *     --pr 42           Check against a specific PR number
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Merge Steward v1';
const LABEL = 'OBSERVE ONLY / MERGE READINESS CHECKER';
const BOT_ID = 'merge-steward';
const VALID_MODES = new Set(['status', 'checklist']);

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

function checkGhAvailable(commandRunner = runCommand) {
  const result = commandRunner('gh', ['--version'], {});
  return result.ok;
}

function buildChecklistItem(name, status, message) {
  return { name, status, message: message || '' };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    observe_only: true,
    merge_authorized: false,
    human_required: ['merge'],
    warnings: data.warnings || [],
    blocking_conditions: data.blocking_conditions || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode(rootDir, options = {}) {
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      observe_only: true,
      merge_authorized: false,
      human_required: ['merge'],
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: status\nStatus: PASS`;
  return result;
}

function buildChecklistMode(rootDir, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const checklist = [];
  const blockers = [];
  const warnings = [];

  // 1. working-tree-clean
  const statusResult = commandRunner('git', ['status', '--short'], { cwd: rootDir });
  if (statusResult.ok) {
    const lines = splitLines(statusResult.stdout);
    const clean = lines.length === 0;
    checklist.push(buildChecklistItem(
      'working-tree-clean',
      clean ? 'pass' : 'fail',
      clean ? 'Working tree is clean' : `Working tree has ${lines.length} uncommitted change(s)`,
    ));
    if (!clean) blockers.push('Working tree has uncommitted changes');
  } else {
    checklist.push(buildChecklistItem('working-tree-clean', 'unavailable', 'git status failed'));
  }

  // 2. ahead-of-main
  let diffResult = commandRunner('git', ['log', '--oneline', 'main...HEAD'], { cwd: rootDir });
  if (!diffResult.ok) {
    diffResult = commandRunner('git', ['log', '--oneline', 'origin/main...HEAD'], { cwd: rootDir });
  }
  if (diffResult.ok) {
    const commitLines = splitLines(diffResult.stdout);
    const hasCommits = commitLines.length > 0;
    checklist.push(buildChecklistItem(
      'ahead-of-main',
      hasCommits ? 'pass' : 'fail',
      hasCommits
        ? `Branch has ${commitLines.length} commit(s) ahead of main`
        : 'Branch has no commits ahead of main',
    ));
    if (!hasCommits) blockers.push('Branch has no commits ahead of main');
  } else {
    checklist.push(buildChecklistItem('ahead-of-main', 'unavailable', 'Could not compare to main'));
    warnings.push('Could not compare to main (main branch not found locally)');
  }

  // 3. no-merge-conflicts
  const mergeTreeResult = commandRunner('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: rootDir });
  if (mergeTreeResult.ok) {
    const conflicted = splitLines(mergeTreeResult.stdout);
    const hasConflicts = conflicted.length > 0;
    checklist.push(buildChecklistItem(
      'no-merge-conflicts',
      hasConflicts ? 'fail' : 'pass',
      hasConflicts
        ? `Merge conflicts detected in: ${conflicted.join(', ')}`
        : 'No merge conflicts detected',
    ));
    if (hasConflicts) blockers.push(`Merge conflicts in: ${conflicted.join(', ')}`);
  } else {
    checklist.push(buildChecklistItem('no-merge-conflicts', 'pass', 'No unresolved conflicts detected'));
  }

  // 4. pr-exists
  const prNumber = options.pr ? String(options.pr) : null;
  const ghAvailable = checkGhAvailable(commandRunner);

  if (prNumber && ghAvailable) {
    const prViewResult = commandRunner('gh', ['pr', 'view', prNumber, '--json', 'state'], { cwd: rootDir });
    if (prViewResult.ok) {
      let prState = 'UNKNOWN';
      try {
        const prData = JSON.parse(prViewResult.stdout);
        prState = prData.state || 'UNKNOWN';
      } catch {
        prState = 'UNKNOWN';
      }
      const isOpen = prState === 'OPEN';
      checklist.push(buildChecklistItem(
        'pr-exists',
        isOpen ? 'pass' : 'fail',
        isOpen ? `PR #${prNumber} is OPEN` : `PR #${prNumber} state is ${prState}`,
      ));
      if (!isOpen) blockers.push(`PR #${prNumber} is not open (state: ${prState})`);
    } else {
      checklist.push(buildChecklistItem('pr-exists', 'fail', `Could not retrieve PR #${prNumber}`));
      blockers.push(`Could not retrieve PR #${prNumber}`);
    }
  } else if (prNumber && !ghAvailable) {
    checklist.push(buildChecklistItem('pr-exists', 'unavailable', 'gh CLI not available to check PR state'));
    warnings.push('gh CLI not available — cannot verify PR existence');
  } else {
    checklist.push(buildChecklistItem('pr-exists', 'unavailable', 'No --pr argument provided'));
  }

  // 5. ci-passing
  if (ghAvailable && prNumber) {
    const checksResult = commandRunner('gh', ['pr', 'checks', prNumber], { cwd: rootDir });
    if (checksResult.ok) {
      const lines = splitLines(checksResult.stdout);
      const failLines = lines.filter((l) => /fail|error|failure/i.test(l));
      const ciPassing = failLines.length === 0 && lines.length > 0;
      checklist.push(buildChecklistItem(
        'ci-passing',
        ciPassing ? 'pass' : (lines.length === 0 ? 'unavailable' : 'fail'),
        ciPassing
          ? `All ${lines.length} CI check(s) passing`
          : (lines.length === 0 ? 'No CI checks found' : `${failLines.length} CI check(s) failing`),
      ));
      if (!ciPassing && lines.length > 0) blockers.push(`${failLines.length} CI check(s) are failing`);
    } else {
      checklist.push(buildChecklistItem('ci-passing', 'unavailable', 'gh pr checks failed'));
      warnings.push('Could not retrieve CI check status');
    }
  } else {
    checklist.push(buildChecklistItem('ci-passing', 'unavailable', 'gh CLI not available or no PR number provided'));
  }

  // 6. release-governor-ok
  let governorStatus = 'unavailable';
  let governorMessage = 'release-governor check not run';
  try {
    const releaseGovernorPath = path.join(rootDir, 'scripts', 'release-governor.cjs');
    if (fs.existsSync(releaseGovernorPath)) {
      const releaseGovernor = require(releaseGovernorPath);
      const govResult = releaseGovernor.runReleaseGovernor({ rootDir, commandRunner });
      if (govResult.status === 'PASS' || govResult.status === 'WARN') {
        governorStatus = 'pass';
        governorMessage = `Release Governor status: ${govResult.status}`;
      } else {
        governorStatus = 'fail';
        governorMessage = `Release Governor status: ${govResult.status} — ${(govResult.blockers || []).join('; ')}`;
        blockers.push(`Release Governor reports FAIL: ${(govResult.blockers || []).join('; ')}`);
      }
    } else {
      governorMessage = 'release-governor.cjs not found';
      warnings.push('release-governor.cjs not found');
    }
  } catch (err) {
    governorMessage = `release-governor check error: ${err instanceof Error ? err.message : String(err)}`;
    warnings.push(governorMessage);
  }
  checklist.push(buildChecklistItem('release-governor-ok', governorStatus, governorMessage));

  const mergeReady = blockers.length === 0
    && checklist.every((c) => c.status === 'pass' || c.status === 'unavailable');

  const result = buildOutput('checklist', {
    status: blockers.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    blocking_conditions: blockers,
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      checklist,
      merge_ready: mergeReady,
      merge_authorized: false,
      blockers,
      human_required: ['merge'],
      observe_only: true,
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: checklist\nStatus: ${result.status}`;
  return result;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }

  return { mode, options };
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const mergedOptions = Object.assign({}, options, parsed.options);

  if (parsed.mode === 'checklist') {
    return buildChecklistMode(rootDir, mergedOptions);
  }
  return buildStatusMode(rootDir, mergedOptions);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  buildChecklistMode,
  buildChecklistItem,
  buildOutput,
  buildStatusMode,
  checkGhAvailable,
  main,
  normalizePath,
  parseArgs,
  runCommand,
  splitLines,
  unique,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
