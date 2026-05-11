#!/usr/bin/env node
/**
 * prompt-compiler.cjs
 * Compiles structured implementation prompts from policy-approved plans.
 *
 * OBSERVE ONLY / PROMPT GENERATOR
 * may_mutate=true — generates prompts but does NOT write files autonomously.
 *
 * Modes:
 *   status  — Agent identity
 *   compile — Compile a prompt: --task "..." --approved-by "chief-arbiter" [--risk "High"] [--executor "security-executor"]
 */

'use strict';

const path = require('node:path');

const AGENT = 'Prompt Compiler v1';
const LABEL = 'OBSERVE ONLY / PROMPT GENERATOR';
const BOT_ID = 'prompt-compiler';
const AUTHORITY = 'PROMPT_GENERATOR';
const VALID_MODES = new Set(['status', 'compile']);

const RECOGNIZED_AUTHORITY_BOTS = [
  'chief-arbiter',
  'security-arbiter',
  'security-governor',
  'release-governor',
  'architecture-governor',
  'documentation-governor',
  'ui-dashboard-governor',
  'human-owner',
];

const ALWAYS_HUMAN_REQUIRED = ['push', 'create_pr', 'merge'];

const VALIDATION_BY_RISK = {
  High: ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build'],
  Medium: ['pnpm lint', 'pnpm typecheck', 'pnpm test'],
  Low: ['pnpm lint', 'pnpm typecheck'],
  Tooling: ['pnpm lint'],
  Docs: ['pnpm lint', 'pnpm typecheck'],
  TestOnly: ['pnpm test'],
  Critical: ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build'],
};

function validateAuthority(approvedBy) {
  if (!approvedBy || typeof approvedBy !== 'string' || approvedBy.trim() === '') {
    return { valid: false, reason: 'approved_by is required and must be a non-empty string' };
  }
  const normalized = approvedBy.trim().toLowerCase();
  if (!RECOGNIZED_AUTHORITY_BOTS.includes(normalized)) {
    return {
      valid: false,
      reason: `"${approvedBy}" is not a recognized authority bot. Valid: ${RECOGNIZED_AUTHORITY_BOTS.join(', ')}`,
    };
  }
  return { valid: true, reason: '' };
}

function compilePrompt(task, approvedBy, riskLevel, executor) {
  const risk = riskLevel || 'Medium';
  const executorName = executor || 'unspecified-executor';
  const validationCommands = VALIDATION_BY_RISK[risk] || VALIDATION_BY_RISK['Medium'];

  const prompt_text = [
    '=== MISSION CONTROL IMPLEMENTATION PROMPT ===',
    '',
    `TASK: ${task}`,
    '',
    `APPROVED_BY: ${approvedBy}`,
    '',
    `RISK_LEVEL: ${risk}`,
    '',
    `EXECUTOR: ${executorName}`,
    '',
    'PRECONDITIONS:',
    '  A. git checkout <correct-branch>',
    '  B. git pull origin <branch>',
    '  C. Verify clean working tree (git status must show nothing modified)',
    '',
    'STRICT_SCOPE:',
    '  - Implementation is bounded to approved files only',
    '  - No changes outside the approved scope',
    '  - No new dependencies without governor approval',
    '  - No refactoring beyond the approved change',
    '',
    'VALIDATION_COMMANDS:',
    ...validationCommands.map((cmd) => `  - ${cmd}`),
    '',
    'GIT_RULES:',
    '  - FORBIDDEN: git add . (use exact file paths only)',
    '  - Stage only files explicitly approved in scope',
    '  - No push until human approves',
    '  - No force push under any circumstances',
    '  - Commit message must reference task and approval',
    '',
    'REQUIRED_OUTPUT_FORMAT:',
    '  A. TASK_SUMMARY: one-sentence description of what was implemented',
    '  B. FILES_CHANGED: list of exact file paths modified',
    '  C. VALIDATION_RESULTS: pass/fail for each validation command',
    '  D. SCOPE_CONFIRMED: statement that no out-of-scope changes were made',
    '  E. BLOCKERS_HIT: any hard blocks encountered (or "none")',
    '  F. GIT_STATUS: output of git status after staging',
    '  G. COMMIT_HASH: hash after commit (or "pending")',
    '  H. HUMAN_REQUIRED_FOR: push, create_pr, merge',
    '  I. READY_FOR_HUMAN_REVIEW: yes/no with reason',
    '',
    '=== END PROMPT ===',
  ].join('\n');

  return {
    prompt_text,
    approved_by: approvedBy,
    risk_level: risk,
    executor: executorName,
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
  };
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
    const key = current.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    authority: AUTHORITY,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    metadata: data.metadata || {},
    summary: data.summary || '',
  };
}

function buildStatusMode(rootDir, options = {}) {
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      bot_id: BOT_ID,
      agent: AGENT,
      label: LABEL,
      authority_level: 6,
      category: 'implementer',
      reports_to: 'chief-arbiter',
      recognized_authority_bots: RECOGNIZED_AUTHORITY_BOTS,
      human_required_for: ALWAYS_HUMAN_REQUIRED,
    },
    summary: `${AGENT} (${LABEL}) | Status: PASS`,
  });
  result.summary = `${AGENT} (${LABEL}) | Status: PASS`;
  return result;
}

function buildCompileMode(rootDir, task, approvedBy, riskLevel, executor, options = {}) {
  if (!task) {
    const result = buildOutput('compile', {
      status: 'FAIL',
      metadata: { error: 'Missing required --task value' },
      summary: `${AGENT} | FAIL | Missing --task`,
    });
    result.summary = `${AGENT} | FAIL | Missing --task`;
    return result;
  }

  const authorityCheck = validateAuthority(approvedBy);
  if (!authorityCheck.valid) {
    const result = buildOutput('compile', {
      status: 'FAIL',
      metadata: {
        error: authorityCheck.reason,
        recognized_authority_bots: RECOGNIZED_AUTHORITY_BOTS,
      },
      summary: `${AGENT} | FAIL | ${authorityCheck.reason}`,
    });
    result.summary = `${AGENT} | FAIL | ${authorityCheck.reason}`;
    return result;
  }

  const compiled = compilePrompt(task, approvedBy.trim(), riskLevel, executor);
  const result = buildOutput('compile', {
    status: 'PASS',
    metadata: {
      task,
      ...compiled,
    },
    summary: `${AGENT} | PASS | Prompt compiled | risk=${compiled.risk_level} | executor=${compiled.executor}`,
  });
  result.summary = `${AGENT} | PASS | Prompt compiled | risk=${compiled.risk_level} | executor=${compiled.executor}`;
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'compile') {
    return buildCompileMode(
      rootDir,
      parsed.options.task || '',
      parsed.options.approvedBy || parsed.options['approved-by'] || '',
      parsed.options.risk || '',
      parsed.options.executor || '',
      options,
    );
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  BOT_ID,
  ALWAYS_HUMAN_REQUIRED,
  RECOGNIZED_AUTHORITY_BOTS,
  VALIDATION_BY_RISK,
  buildCompileMode,
  buildOutput,
  buildStatusMode,
  compilePrompt,
  formatOutput,
  main,
  parseArgs,
  validateAuthority,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
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
