#!/usr/bin/env node
/**
 * command-safety-filter.cjs
 * Shared safety filter that every bot can use to check commands before execution.
 * Observe only — never executes commands, only classifies them.
 */

'use strict';

const path = require('node:path');

const AGENT = 'Command Safety Filter v1';
const LABEL = 'OBSERVE ONLY / COMMAND GATE';
const VALID_MODES = new Set(['status', 'check', 'filter']);

/**
 * Safety rules: each has a pattern (RegExp or function), a reason string,
 * and an optional safe_alternative string.
 */
const SAFETY_RULES = [
  {
    id: 'git-add-dot',
    reason: 'git add . stages all files indiscriminately — use explicit file paths instead',
    safe_alternative: 'git add -- <specific file paths>',
    test: (cmd) => /^\s*git\s+add\s+\.\s*$/.test(cmd) || /^\s*git\s+add\s+-[A-Za-z]*\s*\.\s*$/.test(cmd),
  },
  {
    id: 'git-push-force',
    reason: 'Force push can destroy remote history and is never authorized autonomously',
    safe_alternative: 'git push (without --force) after human review',
    test: (cmd) => /^\s*git\s+push\b.*(?:--force|-f)\b/.test(cmd),
  },
  {
    id: 'git-push-force-with-lease-combined',
    reason: '--force-with-lease combined with push is not authorized autonomously',
    safe_alternative: 'Obtain human authorization before pushing',
    test: (cmd) => /^\s*git\s+push\b.*--force-with-lease/.test(cmd),
  },
  {
    id: 'git-commit-no-verify',
    reason: '--no-verify skips pre-commit hooks which enforce code quality and safety gates',
    safe_alternative: 'Fix the hook failure instead of bypassing it',
    test: (cmd) => /^\s*git\s+commit\b.*--no-verify\b/.test(cmd),
  },
  {
    id: 'git-reset-hard',
    reason: 'git reset --hard destroys uncommitted work and can lose data',
    safe_alternative: 'git stash or git reset --soft to preserve staged changes',
    test: (cmd) => /^\s*git\s+reset\b.*--hard\b/.test(cmd),
  },
  {
    id: 'git-rebase-interactive',
    reason: 'Interactive rebase requires human oversight and rewrites commit history',
    safe_alternative: 'Use non-interactive rebase or cherry-pick with human review',
    test: (cmd) => /^\s*git\s+rebase\b.*-i\b/.test(cmd) || /^\s*git\s+rebase\b.*--interactive\b/.test(cmd),
  },
  {
    id: 'git-filter-branch',
    reason: 'git filter-branch rewrites history and is irreversible without backup',
    safe_alternative: 'Use git filter-repo (safer) with explicit human authorization',
    test: (cmd) => /^\s*git\s+filter-branch\b/.test(cmd),
  },
  {
    id: 'rm-rf-slash',
    reason: 'Destructive filesystem command targeting root or broad paths',
    safe_alternative: 'Specify exact files or directories to remove',
    test: (cmd) => /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-rf|-fr)\s+(?:\/\s*$|\*|~\/)/.test(cmd)
      || /\brm\s+(?:-rf|-fr)\s+\//.test(cmd),
  },
  {
    id: 'no-verify-flag',
    reason: '--no-verify bypasses safety hooks in any git command',
    safe_alternative: 'Fix the underlying hook failure',
    test: (cmd) => /--no-verify/.test(cmd),
  },
  {
    id: 'drop-table',
    reason: 'DROP TABLE is a destructive SQL operation that permanently destroys data',
    safe_alternative: 'Use database migrations with explicit human authorization and backup',
    test: (cmd) => /\bDROP\s+TABLE\b/i.test(cmd),
  },
  {
    id: 'drop-database',
    reason: 'DROP DATABASE is a destructive SQL operation that permanently destroys all data',
    safe_alternative: 'Use database migrations with explicit human authorization and backup',
    test: (cmd) => /\bDROP\s+DATABASE\b/i.test(cmd),
  },
  {
    id: 'test-skip-xtest',
    reason: 'xit/xtest/xdescribe silently disables tests, hiding regressions',
    safe_alternative: 'Fix the failing test or use a focused test skip with explicit justification',
    test: (cmd) => /\b(?:x(?:it|test|describe))\s*\(/.test(cmd),
  },
  {
    id: 'test-skip-todo',
    reason: 'test.skip or it.skip silently disables tests, hiding regressions',
    safe_alternative: 'Fix the failing test or mark with a tracked TODO comment',
    test: (cmd) => /\b(?:test|it|describe)\.skip\s*\(/.test(cmd),
  },
  {
    id: 'test-skip-only',
    reason: 'test.only or it.only can accidentally exclude the full test suite from CI',
    safe_alternative: 'Run the full suite and identify the failing test separately',
    test: (cmd) => /\b(?:test|it|describe)\.only\s*\(/.test(cmd),
  },
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
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

/**
 * Check a single command against all safety rules.
 * Returns { allowed, blocked_rules, verdict, safe_alternative }
 */
function checkCommand(command) {
  const cmd = String(command || '');
  const blockedRules = [];
  let firstAlternative = null;

  for (const rule of SAFETY_RULES) {
    try {
      if (rule.test(cmd)) {
        blockedRules.push(rule.id);
        if (!firstAlternative && rule.safe_alternative) {
          firstAlternative = rule.safe_alternative;
        }
      }
    } catch {
      // Never throw from a safety check — if rule errors, skip it
    }
  }

  const allowed = blockedRules.length === 0;
  return {
    allowed,
    blocked_rules: blockedRules,
    verdict: allowed ? 'ALLOWED' : 'BLOCKED',
    safe_alternative: firstAlternative,
  };
}

/**
 * Check a single command. Returns boolean.
 */
function isCommandSafe(command) {
  return checkCommand(command).allowed;
}

/**
 * Check an array of commands. Returns { safe: boolean, results: [...] }
 */
function filterCommands(commands) {
  const cmds = Array.isArray(commands) ? commands : [];
  const results = cmds.map((cmd) => ({
    command: cmd,
    ...checkCommand(cmd),
  }));

  const safe = results.every((r) => r.allowed);
  return { safe, results };
}

function buildBaseOutput(mode) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: 'PASS',
    warnings: [],
    blockers: [],
    metadata: {},
    summary: '',
  };
}

function runStatusMode() {
  const result = buildBaseOutput('status');

  result.filter_rules_count = SAFETY_RULES.length;
  result.rule_ids = SAFETY_RULES.map((r) => r.id);

  result.metadata = {
    filter_rules_count: SAFETY_RULES.length,
    rule_ids: SAFETY_RULES.map((r) => r.id),
    observe_only: true,
  };

  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: status',
    `Status: ${result.status}`,
    `Filter rules: ${SAFETY_RULES.length}`,
    `Rule IDs: ${SAFETY_RULES.map((r) => r.id).join(', ')}`,
  ].join('\n');

  return result;
}

function runCheckMode(command) {
  const result = buildBaseOutput('check');

  if (!command) {
    result.status = 'FAIL';
    result.blockers.push('Missing required --command argument');
    result.metadata = { observe_only: true };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: check',
      'Status: FAIL',
      'Blockers: Missing --command argument',
    ].join('\n');
    return result;
  }

  const check = checkCommand(command);

  result.command = command;
  result.allowed = check.allowed;
  result.blocked_rules = check.blocked_rules;
  result.verdict = check.verdict;
  result.safe_alternative = check.safe_alternative;

  result.metadata = {
    command,
    allowed: check.allowed,
    blocked_rules: check.blocked_rules,
    verdict: check.verdict,
    safe_alternative: check.safe_alternative,
    observe_only: true,
  };

  // Populate reason details for blocked rules
  result.rule_details = check.blocked_rules.map((ruleId) => {
    const rule = SAFETY_RULES.find((r) => r.id === ruleId);
    return rule ? { id: rule.id, reason: rule.reason, safe_alternative: rule.safe_alternative } : { id: ruleId };
  });

  result.status = check.allowed ? 'PASS' : 'FAIL';
  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: check',
    `Status: ${result.status}`,
    `Command: ${command}`,
    `Verdict: ${check.verdict}`,
    check.blocked_rules.length > 0 ? `Blocked by: ${check.blocked_rules.join(', ')}` : '',
    check.safe_alternative ? `Safe alternative: ${check.safe_alternative}` : '',
  ].filter(Boolean).join('\n');

  return result;
}

function runFilterMode(commandsJson) {
  const result = buildBaseOutput('filter');

  if (!commandsJson) {
    result.status = 'FAIL';
    result.blockers.push('Missing required --commands argument (JSON array of command strings)');
    result.metadata = { observe_only: true };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: filter',
      'Status: FAIL',
      'Blockers: Missing --commands argument',
    ].join('\n');
    return result;
  }

  let commands;
  try {
    commands = JSON.parse(commandsJson);
    if (!Array.isArray(commands)) {
      throw new Error('Commands must be a JSON array');
    }
  } catch (error) {
    result.status = 'FAIL';
    result.blockers.push(`Invalid JSON for --commands: ${error.message}`);
    result.metadata = { observe_only: true };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: filter',
      'Status: FAIL',
      `Blockers: Invalid JSON: ${error.message}`,
    ].join('\n');
    return result;
  }

  const filtered = filterCommands(commands);

  result.safe = filtered.safe;
  result.results = filtered.results;
  result.blocked_count = filtered.results.filter((r) => !r.allowed).length;
  result.allowed_count = filtered.results.filter((r) => r.allowed).length;

  result.metadata = {
    command_count: commands.length,
    blocked_count: result.blocked_count,
    allowed_count: result.allowed_count,
    safe: filtered.safe,
    observe_only: true,
  };

  result.status = filtered.safe ? 'PASS' : 'FAIL';
  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: filter',
    `Status: ${result.status}`,
    `Commands checked: ${commands.length}`,
    `Allowed: ${result.allowed_count}`,
    `Blocked: ${result.blocked_count}`,
    `Safe: ${filtered.safe}`,
  ].join('\n');

  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);

  if (parsed.mode === 'check') {
    const command = parsed.options.command || '';
    return runCheckMode(command);
  }

  if (parsed.mode === 'filter') {
    const commandsJson = parsed.options.commands || '';
    return runFilterMode(commandsJson);
  }

  return runStatusMode();
}

module.exports = {
  AGENT,
  LABEL,
  SAFETY_RULES,
  VALID_MODES,
  buildBaseOutput,
  checkCommand,
  filterCommands,
  formatOutput,
  isCommandSafe,
  main,
  normalizePath,
  parseArgs,
  runCheckMode,
  runFilterMode,
  runStatusMode,
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
