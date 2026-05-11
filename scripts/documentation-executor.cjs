#!/usr/bin/env node
/**
 * documentation-executor.cjs
 * Bounded executor for docs-only and operator guidance changes.
 *
 * EXECUTOR / DOCS-ONLY CHANGES
 * Only operates after documentation-governor approval.
 * May mutate, stage, and commit docs files. Push/PR/merge are always human-only.
 *
 * Modes:
 *   status                                          — Agent identity
 *   prepare --files '["docs/guide.md"]' [--commit-message "…"]  — Prepare docs change plan
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Documentation Executor v1';
const LABEL = 'EXECUTOR / DOCS-ONLY CHANGES';
const BOT_ID = 'documentation-executor';
const AUTHORITY_LEVEL = 5;
const VALID_MODES = new Set(['status', 'prepare']);

const ALWAYS_HUMAN_REQUIRED = ['push', 'create_pr', 'merge'];

// Allowed doc file extensions and directory prefix
const ALLOWED_EXTENSIONS = ['.md', '.txt'];
const ALLOWED_DIRECTORY_PREFIX = 'docs/';

// Blocked patterns — auth/security/policy files
const BLOCKED_PATTERNS = [
  /auth/i,
  /security/i,
  /policy/i,
  /\.env/i,
  /secret/i,
  /credentials/i,
  /token/i,
];

// Blocked extensions — non-doc files
const BLOCKED_EXTENSIONS = ['.ts', '.tsx', '.cjs', '.mjs', '.js', '.json', '.yaml', '.yml'];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const rawMode = String(args[0] || '').toLowerCase().replace(/^--/, '');
  const mode = VALID_MODES.has(rawMode) ? args.shift().toLowerCase().replace(/^--/, '') : 'status';
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { mode, options };
}

function validateDocFiles(files) {
  const approved = [];
  const blocked = [];

  for (const rawFile of files) {
    const filePath = normalizePath(rawFile);
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();

    // Check for blocked auth/security/policy patterns
    const isBlocked = BLOCKED_PATTERNS.some((pattern) => pattern.test(filePath));
    if (isBlocked) {
      blocked.push({ file: filePath, reason: 'Matches blocked pattern (auth/security/policy/secret)' });
      continue;
    }

    // Check for blocked non-doc extensions
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      blocked.push({ file: filePath, reason: `Non-documentation file extension: ${ext}` });
      continue;
    }

    // Allow if it's in docs/ directory or has an allowed extension
    const inDocsDir = filePath.startsWith(ALLOWED_DIRECTORY_PREFIX) || filePath.includes('/docs/');
    const hasAllowedExt = ALLOWED_EXTENSIONS.includes(ext);

    if (inDocsDir || hasAllowedExt) {
      approved.push(filePath);
    } else {
      blocked.push({ file: filePath, reason: `File is not in docs/ directory and does not have an allowed extension (${ALLOWED_EXTENSIONS.join(', ')})` });
    }
  }

  return { approved, blocked };
}

function buildRecommendedCommands(approvedFiles, commitMessage) {
  const commands = [];
  for (const file of approvedFiles) {
    commands.push(`git add "${file}"`);
  }
  const msg = commitMessage || `docs: update documentation files`;
  commands.push(`git commit -m "${msg}"`);
  return commands;
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    bot_id: BOT_ID,
    authority_level: AUTHORITY_LEVEL,
    mode,
    ...data,
  };
}

function buildStatusMode(rootDir, options = {}) {
  return buildOutput('status', {
    status: 'PASS',
    reports_to: 'documentation-governor',
    may_mutate: true,
    may_stage: true,
    may_commit: true,
    may_push: false,
    may_create_pr: false,
    may_merge: false,
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
    documentation_governor_required: true,
    summary: `${AGENT} (${LABEL}) — bounded docs executor. Reports to documentation-governor. Push/PR/merge are always human-only.`,
  });
}

function buildPrepareMode(rootDir, filesArg, commitMessage, options = {}) {
  let files = [];
  if (filesArg) {
    try {
      files = JSON.parse(filesArg);
    } catch {
      return buildOutput('prepare', {
        status: 'FAIL',
        error: 'Invalid --files argument: must be a JSON array of file paths',
        approved_files: [],
        blocked_files: [],
        recommended_commands: [],
        commit_message: '',
        requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
        documentation_governor_required: true,
      });
    }
  }

  if (!Array.isArray(files) || files.length === 0) {
    return buildOutput('prepare', {
      status: 'FAIL',
      error: 'No files provided. Pass --files \'["path/to/file.md"]\'',
      approved_files: [],
      blocked_files: [],
      recommended_commands: [],
      commit_message: '',
      requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
      documentation_governor_required: true,
    });
  }

  const { approved, blocked } = validateDocFiles(files);
  const msg = commitMessage || 'docs: update documentation files';
  const recommendedCommands = approved.length > 0
    ? buildRecommendedCommands(approved, msg)
    : [];

  return buildOutput('prepare', {
    status: blocked.length > 0 && approved.length === 0 ? 'FAIL' : blocked.length > 0 ? 'WARN' : 'PASS',
    approved_files: approved,
    blocked_files: blocked.map((b) => b.file),
    blocked_files_detail: blocked,
    recommended_commands: recommendedCommands,
    commit_message: msg,
    requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
    documentation_governor_required: true,
    summary: approved.length > 0
      ? `${approved.length} file(s) approved for docs-only change. ${blocked.length} blocked.`
      : `All ${blocked.length} file(s) blocked — no docs-only files found.`,
  });
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'prepare') {
    const filesArg = parsed.options.files || null;
    const commitMsg = parsed.options.commitMessage || parsed.options['commit-message'] || '';
    return buildPrepareMode(rootDir, filesArg, commitMsg, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  ALWAYS_HUMAN_REQUIRED,
  ALLOWED_EXTENSIONS,
  ALLOWED_DIRECTORY_PREFIX,
  BLOCKED_EXTENSIONS,
  BLOCKED_PATTERNS,
  buildOutput,
  buildStatusMode,
  buildPrepareMode,
  main,
  normalizePath,
  parseArgs,
  validateDocFiles,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'status',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
