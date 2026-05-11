#!/usr/bin/env node
/**
 * ci-sentinel.cjs
 * CI health verifier for release readiness.
 *
 * Observe-only. Checks whether validation commands are available and passing.
 * When gh CLI is present, checks GitHub Actions status for the current branch/repo.
 *
 * Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status          — Agent identity + validation script availability + gh CLI presence
 *   check [options] — Full CI readiness check with gh integration when available
 *     --branch "name"  Override the branch to check
 *     --pr 42          Check CI for a specific PR number
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'CI Sentinel v1';
const LABEL = 'OBSERVE ONLY / CI HEALTH VERIFIER';
const BOT_ID = 'ci-sentinel';
const VALID_MODES = new Set(['status', 'check']);
const REQUIRED_VALIDATION_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];
const HUMAN_REQUIRED_FOR = ['push', 'create_pr', 'merge'];

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

function checkValidationScripts(rootDir, options = {}) {
  let pkg = null;
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    pkg = null;
  }
  const scripts = pkg && pkg.scripts ? pkg.scripts : {};
  const available = {};
  for (const name of REQUIRED_VALIDATION_SCRIPTS) {
    available[name] = typeof scripts[name] === 'string';
  }
  return available;
}

function checkGhAvailable(commandRunner = runCommand) {
  const result = commandRunner('gh', ['--version'], {});
  return result.ok;
}

function parsePrChecksOutput(stdout) {
  const lines = splitLines(stdout);
  const checks = [];
  for (const line of lines) {
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length >= 2) {
      const name = String(parts[0] || '').trim();
      const rawStatus = String(parts[1] || '').trim().toLowerCase();
      if (!name) continue;
      let status = 'pending';
      if (rawStatus === 'pass' || rawStatus === 'success' || rawStatus === 'completed') {
        status = 'pass';
      } else if (rawStatus === 'fail' || rawStatus === 'failure' || rawStatus === 'error') {
        status = 'fail';
      } else if (rawStatus === 'pending' || rawStatus === 'queued' || rawStatus === 'in_progress') {
        status = 'pending';
      }
      checks.push({ name, status, required: true });
    }
  }
  return checks;
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    observe_only: true,
    requires_human_for: HUMAN_REQUIRED_FOR.slice(),
    warnings: data.warnings || [],
    blocking_conditions: data.blocking_conditions || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode(rootDir, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const warnings = [];
  const validationScripts = checkValidationScripts(rootDir, options);
  const ghAvailable = checkGhAvailable(commandRunner);
  const missingScripts = REQUIRED_VALIDATION_SCRIPTS.filter((s) => !validationScripts[s]);
  if (missingScripts.length > 0) {
    warnings.push(`Validation scripts missing from package.json: ${missingScripts.join(', ')}`);
  }
  if (!ghAvailable) {
    warnings.push('gh CLI is not available — GitHub Actions status cannot be checked');
  }

  const result = buildOutput('status', {
    status: warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      validation_scripts_available: validationScripts,
      gh_available: ghAvailable,
      observe_only: true,
      requires_human_for: HUMAN_REQUIRED_FOR.slice(),
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: status\nStatus: ${result.status}`;
  return result;
}

function buildCheckMode(rootDir, options = {}) {
  const commandRunner = options.commandRunner || runCommand;
  const warnings = [];
  const blockingConditions = [];

  const validationScripts = checkValidationScripts(rootDir, options);
  const ghAvailable = checkGhAvailable(commandRunner);

  const missingRequired = REQUIRED_VALIDATION_SCRIPTS.filter((s) => !validationScripts[s]);
  if (missingRequired.length > 0) {
    warnings.push(`Validation scripts missing: ${missingRequired.join(', ')}`);
  }

  let ciChecks = [];
  let branchName = options.branch || '';

  if (!branchName) {
    const branchResult = commandRunner('git', ['branch', '--show-current'], { cwd: rootDir });
    if (branchResult.ok) {
      branchName = branchResult.stdout.trim();
    }
  }

  const prNumber = options.pr ? String(options.pr) : null;

  if (ghAvailable && prNumber) {
    const checksResult = commandRunner('gh', ['pr', 'checks', prNumber], { cwd: rootDir });
    if (checksResult.ok) {
      ciChecks = parsePrChecksOutput(checksResult.stdout);
    } else {
      const errMsg = checksResult.stderr || checksResult.error || 'gh pr checks failed';
      warnings.push(`gh pr checks failed: ${errMsg.trim().split('\n')[0]}`);
      ciChecks = [{
        name: 'gh-pr-checks',
        status: 'unavailable',
        required: false,
      }];
    }
  } else if (!ghAvailable) {
    ciChecks = REQUIRED_VALIDATION_SCRIPTS.map((name) => ({
      name,
      status: validationScripts[name] ? 'pending' : 'unavailable',
      required: true,
    }));
  }

  const releaseBlocking = missingRequired.length > 0
    || ciChecks.some((c) => c.required && (c.status === 'fail' || c.status === 'unavailable'));

  if (releaseBlocking) {
    blockingConditions.push('One or more required CI checks are unavailable or failing');
  }

  const recommendedCommands = [];
  if (validationScripts.typecheck) recommendedCommands.push('pnpm typecheck');
  if (validationScripts.lint) recommendedCommands.push('pnpm lint');
  if (validationScripts.test) recommendedCommands.push('pnpm test');
  if (validationScripts.build) recommendedCommands.push('pnpm build');

  const result = buildOutput('check', {
    status: blockingConditions.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    blocking_conditions: blockingConditions,
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      branch: branchName,
      pr: prNumber,
      validation_scripts_available: validationScripts,
      gh_available: ghAvailable,
      ci_checks: ciChecks,
      release_blocking: releaseBlocking,
      recommended_commands: recommendedCommands,
      requires_human_for: HUMAN_REQUIRED_FOR.slice(),
      observe_only: true,
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: check\nStatus: ${result.status}`;
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

  if (parsed.mode === 'check') {
    return buildCheckMode(rootDir, mergedOptions);
  }
  return buildStatusMode(rootDir, mergedOptions);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  HUMAN_REQUIRED_FOR,
  REQUIRED_VALIDATION_SCRIPTS,
  buildCheckMode,
  buildOutput,
  buildStatusMode,
  checkGhAvailable,
  checkValidationScripts,
  main,
  normalizePath,
  parsePrChecksOutput,
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
