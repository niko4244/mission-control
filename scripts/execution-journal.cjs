#!/usr/bin/env node
/**
 * execution-journal.cjs
 * Provenance ledger for Mission Control autonomous actions.
 *
 * Records every autonomous action with actor, task, authority chain,
 * files changed, validation results, commit hash, and rollback path.
 * Provides schema validation, inspection, and audit queries.
 *
 * Writes to .data/execution-journal.jsonl (gitignored runtime data).
 * Never mutates source code or git state.
 *
 * Modes:
 *   status   — Journal health, entry count, recent activity
 *   append   — Add a new validated entry (via --entry '{"actor":...}')
 *   inspect  — Query entries by actor/action/risk/outcome
 *   verify   — Validate all entries against schema
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AGENT = 'Execution Journal v1';
const LABEL = 'PROVENANCE LEDGER / AUDIT TRAIL';
const VALID_MODES = new Set(['status', 'append', 'inspect', 'verify']);

const VALID_ACTIONS = new Set([
  'commit', 'stage', 'route', 'approve', 'reject', 'escalate',
  'plan', 'review', 'validate', 'scan', 'recommend', 'classify',
  'push', 'create_pr', 'merge', 'rollback', 'observe',
]);

const VALID_RISK_LEVELS = new Set(['Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs', 'TestOnly', 'Unknown']);
const VALID_OUTCOMES = new Set(['success', 'failure', 'pending', 'blocked', 'escalated', 'skipped']);

const REQUIRED_ENTRY_FIELDS = ['id', 'timestamp', 'actor', 'action', 'task', 'risk_level', 'outcome'];
const OPTIONAL_ENTRY_FIELDS = [
  'authority_chain', 'files_changed', 'validation', 'commit',
  'rollback_path', 'notes', 'approved_by', 'branch',
];
const ALL_ENTRY_FIELDS = new Set([...REQUIRED_ENTRY_FIELDS, ...OPTIONAL_ENTRY_FIELDS]);

const DEFAULT_DATA_DIR = path.join(process.env.MISSION_CONTROL_DATA_DIR || '.data');
const JOURNAL_FILENAME = 'execution-journal.jsonl';

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function generateId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `ej-${ts}-${rand}`;
}

function resolveJournalPath(rootDir, options = {}) {
  if (options.journalPath) return path.resolve(options.journalPath);
  const dataDir = options.dataDir
    ? path.resolve(rootDir, options.dataDir)
    : path.resolve(rootDir, DEFAULT_DATA_DIR);
  return path.join(dataDir, JOURNAL_FILENAME);
}

function ensureJournalDir(journalPath) {
  const dir = path.dirname(journalPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['Entry must be a plain object'];
  }

  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
      errors.push(`Required field missing or empty: ${field}`);
    }
  }

  if (entry.action && !VALID_ACTIONS.has(String(entry.action))) {
    errors.push(`Unknown action: "${entry.action}". Valid: ${[...VALID_ACTIONS].join(', ')}`);
  }
  if (entry.risk_level && !VALID_RISK_LEVELS.has(String(entry.risk_level))) {
    errors.push(`Unknown risk_level: "${entry.risk_level}"`);
  }
  if (entry.outcome && !VALID_OUTCOMES.has(String(entry.outcome))) {
    errors.push(`Unknown outcome: "${entry.outcome}". Valid: ${[...VALID_OUTCOMES].join(', ')}`);
  }
  if (entry.timestamp) {
    const d = new Date(entry.timestamp);
    if (isNaN(d.getTime())) errors.push('timestamp is not a valid ISO date string');
  }
  if (entry.authority_chain !== undefined && !Array.isArray(entry.authority_chain)) {
    errors.push('authority_chain must be an array');
  }
  if (entry.files_changed !== undefined && !Array.isArray(entry.files_changed)) {
    errors.push('files_changed must be an array');
  }
  if (entry.validation !== undefined && (typeof entry.validation !== 'object' || Array.isArray(entry.validation))) {
    errors.push('validation must be an object');
  }

  const unknownFields = Object.keys(entry).filter((k) => !ALL_ENTRY_FIELDS.has(k));
  if (unknownFields.length > 0) {
    errors.push(`Unknown fields: ${unknownFields.join(', ')}`);
  }

  return errors;
}

function buildEntry(partial, now = new Date()) {
  return {
    id: partial.id || generateId(),
    timestamp: partial.timestamp || now.toISOString(),
    actor: String(partial.actor || ''),
    action: String(partial.action || ''),
    task: String(partial.task || ''),
    risk_level: String(partial.risk_level || 'Unknown'),
    outcome: String(partial.outcome || 'pending'),
    ...(partial.authority_chain !== undefined ? { authority_chain: partial.authority_chain } : {}),
    ...(partial.files_changed !== undefined ? { files_changed: partial.files_changed } : {}),
    ...(partial.validation !== undefined ? { validation: partial.validation } : {}),
    ...(partial.commit !== undefined ? { commit: partial.commit } : {}),
    ...(partial.rollback_path !== undefined ? { rollback_path: partial.rollback_path } : {}),
    ...(partial.notes !== undefined ? { notes: partial.notes } : {}),
    ...(partial.approved_by !== undefined ? { approved_by: partial.approved_by } : {}),
    ...(partial.branch !== undefined ? { branch: partial.branch } : {}),
  };
}

function appendEntry(journalPath, partial, options = {}) {
  const entry = buildEntry(partial, options.now || new Date());
  const errors = validateEntry(entry);
  if (errors.length > 0) {
    return { ok: false, errors, entry: null };
  }

  ensureJournalDir(journalPath);
  const line = JSON.stringify(entry) + '\n';

  try {
    fs.appendFileSync(journalPath, line, 'utf8');
    return { ok: true, errors: [], entry };
  } catch (error) {
    return {
      ok: false,
      errors: [`Failed to write journal: ${error instanceof Error ? error.message : String(error)}`],
      entry,
    };
  }
}

function readEntries(journalPath, filter = {}) {
  if (!fs.existsSync(journalPath)) return [];
  let content;
  try {
    content = fs.readFileSync(journalPath, 'utf8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter(Boolean);
  const entries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  return entries.filter((entry) => {
    if (filter.actor && entry.actor !== filter.actor) return false;
    if (filter.action && entry.action !== filter.action) return false;
    if (filter.risk_level && entry.risk_level !== filter.risk_level) return false;
    if (filter.outcome && entry.outcome !== filter.outcome) return false;
    if (filter.since) {
      const since = new Date(filter.since);
      if (!isNaN(since.getTime()) && new Date(entry.timestamp) < since) return false;
    }
    return true;
  });
}

function verifyJournal(journalPath) {
  const entries = readEntries(journalPath);
  const results = entries.map((entry, index) => {
    const errors = validateEntry(entry);
    return { index, id: entry.id || `entry-${index}`, valid: errors.length === 0, errors };
  });

  return {
    total: results.length,
    valid: results.filter((r) => r.valid).length,
    invalid: results.filter((r) => !r.valid).length,
    results,
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    warnings: data.warnings || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode(rootDir, options = {}) {
  const journalPath = resolveJournalPath(rootDir, options);
  const exists = fs.existsSync(journalPath);
  const entries = exists ? readEntries(journalPath) : [];
  const recent = entries.slice(-5).reverse();
  const byOutcome = {};
  for (const e of entries) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
  }

  const warnings = [];
  if (!exists) warnings.push('Journal file does not exist yet — will be created on first append');

  const result = buildOutput('status', {
    status: warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    metadata: {
      journal_path: normalizePath(journalPath),
      journal_exists: exists,
      total_entries: entries.length,
      by_outcome: byOutcome,
      recent_entries: recent.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        actor: e.actor,
        action: e.action,
        risk_level: e.risk_level,
        outcome: e.outcome,
      })),
    },
  });
  result.summary = `${AGENT} | ${result.status} | ${entries.length} entries in journal`;
  return result;
}

function buildAppendMode(rootDir, entryPartial, options = {}) {
  const journalPath = resolveJournalPath(rootDir, options);
  const writeResult = appendEntry(journalPath, entryPartial, options);

  if (!writeResult.ok) {
    const result = buildOutput('append', {
      status: 'FAIL',
      warnings: writeResult.errors,
      metadata: { journal_path: normalizePath(journalPath), entry: null, errors: writeResult.errors },
    });
    result.summary = `${AGENT} | FAIL | Entry rejected: ${writeResult.errors[0]}`;
    return result;
  }

  const result = buildOutput('append', {
    status: 'PASS',
    metadata: { journal_path: normalizePath(journalPath), entry: writeResult.entry },
  });
  result.summary = `${AGENT} | PASS | Entry ${writeResult.entry.id} appended`;
  return result;
}

function buildInspectMode(rootDir, filter, options = {}) {
  const journalPath = resolveJournalPath(rootDir, options);
  const entries = readEntries(journalPath, filter);

  const result = buildOutput('inspect', {
    status: 'PASS',
    metadata: {
      journal_path: normalizePath(journalPath),
      filter,
      count: entries.length,
      entries,
    },
  });
  result.summary = `${AGENT} | PASS | ${entries.length} entries matched filter`;
  return result;
}

function buildVerifyMode(rootDir, options = {}) {
  const journalPath = resolveJournalPath(rootDir, options);
  const verification = verifyJournal(journalPath);
  const warnings = verification.invalid > 0
    ? [`${verification.invalid} of ${verification.total} journal entries failed schema validation`]
    : [];

  const result = buildOutput('verify', {
    status: verification.invalid > 0 ? 'FAIL' : 'PASS',
    warnings,
    metadata: {
      journal_path: normalizePath(journalPath),
      ...verification,
    },
  });
  result.summary = `${AGENT} | ${result.status} | ${verification.valid}/${verification.total} valid`;
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

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'append') {
    let entryPartial = {};
    if (parsed.options.entry) {
      try {
        entryPartial = JSON.parse(parsed.options.entry);
      } catch {
        const result = buildOutput('append', {
          status: 'FAIL',
          warnings: ['--entry value is not valid JSON'],
          metadata: { entry: null },
        });
        result.summary = `${AGENT} | FAIL | Invalid --entry JSON`;
        return result;
      }
    }
    return buildAppendMode(rootDir, entryPartial, options);
  }
  if (parsed.mode === 'inspect') {
    const filter = {};
    if (parsed.options.actor) filter.actor = parsed.options.actor;
    if (parsed.options.action) filter.action = parsed.options.action;
    if (parsed.options.risk_level) filter.risk_level = parsed.options.risk_level;
    if (parsed.options.outcome) filter.outcome = parsed.options.outcome;
    if (parsed.options.since) filter.since = parsed.options.since;
    return buildInspectMode(rootDir, filter, options);
  }
  if (parsed.mode === 'verify') {
    return buildVerifyMode(rootDir, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  VALID_ACTIONS,
  VALID_RISK_LEVELS,
  VALID_OUTCOMES,
  REQUIRED_ENTRY_FIELDS,
  appendEntry,
  buildAppendMode,
  buildEntry,
  buildInspectMode,
  buildOutput,
  buildStatusMode,
  buildVerifyMode,
  formatOutput,
  generateId,
  main,
  normalizePath,
  parseArgs,
  readEntries,
  resolveJournalPath,
  unique,
  validateEntry,
  verifyJournal,
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
