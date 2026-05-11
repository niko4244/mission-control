#!/usr/bin/env node
/**
 * correction-loop-manager.cjs
 * Manages correction loops after governor/arbiter requests changes.
 *
 * EXECUTOR / BOUNDED CORRECTIONS
 * may_mutate=true, may_stage=true, may_commit=true
 * push/PR/merge always human.
 *
 * Tracks correction records in .data/corrections.jsonl
 *
 * Modes:
 *   status  — Count corrections by status
 *   submit  — Create new correction record
 *   list    — Filter corrections [--status "open"] [--target "bot-id"]
 *   advance — Mark correction as addressed: --id "cor-xxx" --resolution "description"
 *   verify  — Mark correction as verified: --id "cor-xxx"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AGENT = 'Correction Loop Manager v1';
const LABEL = 'EXECUTOR / BOUNDED CORRECTIONS';
const BOT_ID = 'correction-loop-manager';
const AUTHORITY = 'BOUNDED_CORRECTIONS_EXECUTOR';
const VALID_MODES = new Set(['status', 'submit', 'list', 'advance', 'verify']);

const VALID_STATUSES = new Set(['open', 'addressed', 'verified', 'rejected']);

const DEFAULT_DATA_DIR = process.env.MISSION_CONTROL_DATA_DIR || '.data';
const CORRECTIONS_FILENAME = 'corrections.jsonl';

const ALWAYS_HUMAN_REQUIRED = ['push', 'create_pr', 'merge'];

function generateId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `cor-${ts}-${rand}`;
}

function resolveCorrectionsPath(rootDir, options = {}) {
  if (options.correctionsPath) return path.resolve(options.correctionsPath);
  const dataDir = options.dataDir
    ? path.resolve(rootDir, options.dataDir)
    : path.resolve(rootDir, DEFAULT_DATA_DIR);
  return path.join(dataDir, CORRECTIONS_FILENAME);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildCorrection(partial, now = new Date()) {
  return {
    id: partial.id || generateId(),
    timestamp: partial.timestamp || now.toISOString(),
    requester: String(partial.requester || 'human'),
    target_bot: String(partial.target_bot || ''),
    original_task: String(partial.original_task || ''),
    correction_requested: String(partial.correction_requested || ''),
    status: String(partial.status || 'open'),
    resolution: partial.resolution !== undefined ? partial.resolution : null,
    iterations: typeof partial.iterations === 'number' ? partial.iterations : 0,
    created_at: partial.created_at || now.toISOString(),
    updated_at: partial.updated_at || now.toISOString(),
  };
}

function readCorrections(correctionsPath, filter = {}) {
  if (!fs.existsSync(correctionsPath)) return [];
  let content;
  try {
    content = fs.readFileSync(correctionsPath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter(Boolean);
  const corrections = [];
  for (const line of lines) {
    try {
      corrections.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return corrections.filter((c) => {
    if (filter.status && c.status !== filter.status) return false;
    if (filter.target_bot && c.target_bot !== filter.target_bot) return false;
    if (filter.requester && c.requester !== filter.requester) return false;
    return true;
  });
}

function writeAllCorrections(correctionsPath, corrections) {
  ensureDir(correctionsPath);
  const content = corrections.map((c) => JSON.stringify(c)).join('\n') + '\n';
  fs.writeFileSync(correctionsPath, content, 'utf8');
}

function appendCorrection(correctionsPath, partial, options = {}) {
  const correction = buildCorrection(partial, options.now || new Date());
  ensureDir(correctionsPath);
  const line = JSON.stringify(correction) + '\n';
  try {
    fs.appendFileSync(correctionsPath, line, 'utf8');
    return { ok: true, correction };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      correction,
    };
  }
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
  const correctionsPath = resolveCorrectionsPath(rootDir, options);
  const all = readCorrections(correctionsPath);
  const byStatus = {};
  for (const c of all) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  }
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      bot_id: BOT_ID,
      corrections_path: correctionsPath.replace(/\\/g, '/'),
      total: all.length,
      by_status: byStatus,
      human_required_for: ALWAYS_HUMAN_REQUIRED,
    },
    summary: `${AGENT} (${LABEL}) | ${all.length} corrections total`,
  });
  result.summary = `${AGENT} (${LABEL}) | ${all.length} corrections total`;
  return result;
}

function buildSubmitMode(rootDir, partial, options = {}) {
  const correctionsPath = resolveCorrectionsPath(rootDir, options);
  if (!partial.requester || !partial.target_bot || !partial.original_task || !partial.correction_requested) {
    const result = buildOutput('submit', {
      status: 'FAIL',
      metadata: { error: 'Missing required fields: requester, target_bot, original_task, correction_requested' },
      summary: `${AGENT} | FAIL | Missing required fields`,
    });
    result.summary = `${AGENT} | FAIL | Missing required fields`;
    return result;
  }
  const writeResult = appendCorrection(correctionsPath, { ...partial, status: 'open' }, options);
  if (!writeResult.ok) {
    const result = buildOutput('submit', {
      status: 'FAIL',
      metadata: { error: writeResult.error },
      summary: `${AGENT} | FAIL | ${writeResult.error}`,
    });
    result.summary = `${AGENT} | FAIL | ${writeResult.error}`;
    return result;
  }
  const result = buildOutput('submit', {
    status: 'PASS',
    metadata: {
      correction: writeResult.correction,
      corrections_path: correctionsPath.replace(/\\/g, '/'),
    },
    summary: `${AGENT} | PASS | Correction ${writeResult.correction.id} submitted`,
  });
  result.summary = `${AGENT} | PASS | Correction ${writeResult.correction.id} submitted`;
  return result;
}

function buildListMode(rootDir, filter, options = {}) {
  const correctionsPath = resolveCorrectionsPath(rootDir, options);
  const corrections = readCorrections(correctionsPath, filter);
  const result = buildOutput('list', {
    status: 'PASS',
    metadata: { filter, count: corrections.length, corrections },
    summary: `${AGENT} | list | ${corrections.length} corrections matched`,
  });
  result.summary = `${AGENT} | list | ${corrections.length} corrections matched`;
  return result;
}

function buildAdvanceMode(rootDir, id, resolution, options = {}) {
  const correctionsPath = resolveCorrectionsPath(rootDir, options);
  if (!id) {
    const result = buildOutput('advance', {
      status: 'FAIL',
      metadata: { error: 'Missing required --id' },
      summary: `${AGENT} | FAIL | Missing --id`,
    });
    result.summary = `${AGENT} | FAIL | Missing --id`;
    return result;
  }
  const all = readCorrections(correctionsPath);
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) {
    const result = buildOutput('advance', {
      status: 'FAIL',
      metadata: { error: `Correction ${id} not found` },
      summary: `${AGENT} | FAIL | Correction ${id} not found`,
    });
    result.summary = `${AGENT} | FAIL | Correction ${id} not found`;
    return result;
  }
  const now = (options.now || new Date()).toISOString();
  all[idx] = {
    ...all[idx],
    status: 'addressed',
    resolution: resolution || all[idx].resolution,
    iterations: (all[idx].iterations || 0) + 1,
    updated_at: now,
  };
  writeAllCorrections(correctionsPath, all);
  const result = buildOutput('advance', {
    status: 'PASS',
    metadata: { correction: all[idx] },
    summary: `${AGENT} | PASS | Correction ${id} advanced to addressed`,
  });
  result.summary = `${AGENT} | PASS | Correction ${id} advanced to addressed`;
  return result;
}

function buildVerifyMode(rootDir, id, options = {}) {
  const correctionsPath = resolveCorrectionsPath(rootDir, options);
  if (!id) {
    const result = buildOutput('verify', {
      status: 'FAIL',
      metadata: { error: 'Missing required --id' },
      summary: `${AGENT} | FAIL | Missing --id`,
    });
    result.summary = `${AGENT} | FAIL | Missing --id`;
    return result;
  }
  const all = readCorrections(correctionsPath);
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) {
    const result = buildOutput('verify', {
      status: 'FAIL',
      metadata: { error: `Correction ${id} not found` },
      summary: `${AGENT} | FAIL | Correction ${id} not found`,
    });
    result.summary = `${AGENT} | FAIL | Correction ${id} not found`;
    return result;
  }
  const now = (options.now || new Date()).toISOString();
  all[idx] = {
    ...all[idx],
    status: 'verified',
    updated_at: now,
  };
  writeAllCorrections(correctionsPath, all);
  const result = buildOutput('verify', {
    status: 'PASS',
    metadata: { correction: all[idx] },
    summary: `${AGENT} | PASS | Correction ${id} verified`,
  });
  result.summary = `${AGENT} | PASS | Correction ${id} verified`;
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'submit') {
    const partial = {
      requester: parsed.options.requester || '',
      target_bot: parsed.options['targetBot'] || parsed.options.target || '',
      original_task: parsed.options.task || '',
      correction_requested: parsed.options.correction || '',
    };
    return buildSubmitMode(rootDir, partial, options);
  }
  if (parsed.mode === 'list') {
    const filter = {};
    if (parsed.options.status) filter.status = parsed.options.status;
    if (parsed.options.target) filter.target_bot = parsed.options.target;
    return buildListMode(rootDir, filter, options);
  }
  if (parsed.mode === 'advance') {
    return buildAdvanceMode(rootDir, parsed.options.id || '', parsed.options.resolution || '', options);
  }
  if (parsed.mode === 'verify') {
    return buildVerifyMode(rootDir, parsed.options.id || '', options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  BOT_ID,
  ALWAYS_HUMAN_REQUIRED,
  VALID_STATUSES,
  appendCorrection,
  buildAdvanceMode,
  buildCorrection,
  buildListMode,
  buildOutput,
  buildStatusMode,
  buildSubmitMode,
  buildVerifyMode,
  formatOutput,
  generateId,
  main,
  parseArgs,
  readCorrections,
  resolveCorrectionsPath,
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
