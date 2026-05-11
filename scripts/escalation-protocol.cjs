#!/usr/bin/env node
/**
 * escalation-protocol.cjs
 * Formal protocol for governors to request Chief Arbiter approval.
 * Documents the escalation chain, validates escalation requests,
 * and tracks pending escalations in .data/escalations.jsonl.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AGENT = 'Escalation Protocol v1';
const LABEL = 'OBSERVE ONLY / ESCALATION HANDLER';
const VALID_MODES = new Set(['status', 'submit', 'list', 'inspect']);

const VALID_REASONS = [
  'failed_validation',
  'broad_rewrite',
  'dependency_change',
  'policy_edit',
  'cross_domain',
  'authority_exceeded',
  'other',
];
const VALID_ESCALATION_STATUSES = ['pending', 'approved', 'rejected', 'human_required'];

// Bot cannot self-resolve. All submissions are always pending.
const SUBMIT_STATUS = 'pending';

function getDataDir() {
  return process.env.MISSION_CONTROL_DATA_DIR || '.data';
}

function getEscalationsFilePath(dataDir) {
  return path.join(dataDir, 'escalations.jsonl');
}

function ensureDataDir(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function generateEscalationId() {
  const ts = Date.now().toString(36);
  const hash = crypto.randomBytes(3).toString('hex');
  return `esc-${ts}-${hash}`;
}

function readEscalations(dataDir) {
  const filePath = getEscalationsFilePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendEscalation(record, dataDir) {
  ensureDataDir(dataDir);
  const filePath = getEscalationsFilePath(dataDir);
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function validateEscalation(fields) {
  const errors = [];

  if (!fields.governor || String(fields.governor).trim() === '') {
    errors.push('Missing required field: governor');
  }
  if (!fields.reason || !VALID_REASONS.includes(fields.reason)) {
    errors.push(`Invalid or missing reason. Must be one of: ${VALID_REASONS.join(', ')}`);
  }
  if (!fields.task || String(fields.task).trim() === '') {
    errors.push('Missing required field: task');
  }
  if (!fields.evidence || String(fields.evidence).trim() === '') {
    errors.push('Missing required field: evidence');
  }
  if (!fields.requested_action || String(fields.requested_action).trim() === '') {
    errors.push('Missing required field: requested_action');
  }

  return errors;
}

function submitEscalation(fields, dataDir) {
  const errors = validateEscalation(fields);
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  const now = new Date().toISOString();
  const record = {
    id: fields.id || generateEscalationId(),
    timestamp: now,
    governor: String(fields.governor).trim(),
    reason: fields.reason,
    task: String(fields.task).trim(),
    risk_level: String(fields.risk_level || 'Unknown').trim(),
    evidence: String(fields.evidence).trim(),
    requested_action: String(fields.requested_action).trim(),
    // Bot cannot self-resolve: always pending on submit
    status: SUBMIT_STATUS,
    arbiter_response: '',
    resolved_at: null,
  };

  appendEscalation(record, dataDir);

  return {
    ok: true,
    id: record.id,
    arbiter_required: true,
    record,
  };
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2).replace(/-/g, '_');
    const nextValue = args[index + 1];
    if (nextValue !== undefined && !nextValue.startsWith('--')) {
      options[key] = nextValue;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return { mode, options };
}

function buildStatusMode(dataDir) {
  const dir = dataDir || getDataDir();
  const escalations = readEscalations(dir);
  const byCounts = {};
  const pending = [];

  for (const esc of escalations) {
    const s = esc.status || 'unknown';
    byCounts[s] = (byCounts[s] || 0) + 1;
    if (s === 'pending') {
      pending.push({ id: esc.id, governor: esc.governor, reason: esc.reason, task: esc.task, timestamp: esc.timestamp });
    }
  }

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'status',
    status: 'PASS',
    total: escalations.length,
    by_status: byCounts,
    pending_count: pending.length,
    pending,
    arbiter_required: true,
    data_file: getEscalationsFilePath(dir),
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: status',
      `Total escalations: ${escalations.length}`,
      `Pending: ${pending.length}`,
      `By status: ${Object.entries(byCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    ].join('\n'),
  };
}

function buildSubmitMode(dataDir, options) {
  const dir = dataDir || getDataDir();

  const fields = {
    governor: options && options.governor ? String(options.governor) : '',
    reason: options && options.reason ? String(options.reason) : '',
    task: options && options.task ? String(options.task) : '',
    risk_level: options && options.risk_level ? String(options.risk_level) : 'Unknown',
    evidence: options && options.evidence ? String(options.evidence) : '',
    requested_action: options && options.requested_action ? String(options.requested_action) : '',
  };

  const errors = validateEscalation(fields);

  if (errors.length > 0) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'submit',
      status: 'FAIL',
      errors,
      arbiter_required: true,
      summary: [
        `${AGENT} (${LABEL})`,
        'Mode: submit',
        'Status: FAIL',
        `Validation errors: ${errors.join('; ')}`,
      ].join('\n'),
    };
  }

  const result = submitEscalation(fields, dir);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'submit',
    status: 'PASS',
    id: result.id,
    arbiter_required: true,
    escalation_status: SUBMIT_STATUS,
    record: result.record,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: submit',
      'Status: PASS',
      `Escalation ID: ${result.id}`,
      `Status: ${SUBMIT_STATUS} — Chief Arbiter must review before any action is authorized`,
      'Bot cannot self-resolve escalations',
    ].join('\n'),
  };
}

function buildListMode(dataDir, options) {
  const dir = dataDir || getDataDir();
  const escalations = readEscalations(dir);
  const statusFilter = options && options.status ? String(options.status) : null;
  const governorFilter = options && options.governor ? String(options.governor) : null;

  let filtered = escalations.slice();

  if (statusFilter) {
    filtered = filtered.filter((esc) => esc.status === statusFilter);
  }
  if (governorFilter) {
    filtered = filtered.filter((esc) => esc.governor === governorFilter);
  }

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'list',
    status: 'PASS',
    filters: { status: statusFilter, governor: governorFilter },
    count: filtered.length,
    escalations: filtered,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: list',
      `Escalations returned: ${filtered.length}`,
    ].join('\n'),
  };
}

function buildInspectMode(dataDir, escalationId) {
  const dir = dataDir || getDataDir();

  if (!escalationId) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'inspect',
      status: 'FAIL',
      error: 'Missing required --id option',
      summary: `${AGENT} (${LABEL})\nMode: inspect\nStatus: FAIL\nMissing required --id`,
    };
  }

  const escalations = readEscalations(dir);
  const found = escalations.find((esc) => esc.id === escalationId);

  if (!found) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'inspect',
      status: 'FAIL',
      error: `Escalation not found: ${escalationId}`,
      summary: `${AGENT} (${LABEL})\nMode: inspect\nStatus: FAIL\nNot found: ${escalationId}`,
    };
  }

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'inspect',
    status: 'PASS',
    escalation: found,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: inspect',
      `ID: ${found.id}`,
      `Governor: ${found.governor}`,
      `Reason: ${found.reason}`,
      `Status: ${found.status}`,
    ].join('\n'),
  };
}

function main(argv, options) {
  const args = argv || process.argv.slice(2);
  const opts = options || {};
  const parsed = parseArgs(args);
  const dataDir = opts.dataDir || getDataDir();

  if (parsed.mode === 'submit') {
    return buildSubmitMode(dataDir, parsed.options);
  }
  if (parsed.mode === 'list') {
    return buildListMode(dataDir, parsed.options);
  }
  if (parsed.mode === 'inspect') {
    return buildInspectMode(dataDir, parsed.options.id || '');
  }
  return buildStatusMode(dataDir);
}

module.exports = {
  AGENT,
  LABEL,
  VALID_REASONS,
  VALID_ESCALATION_STATUSES,
  SUBMIT_STATUS,
  appendEscalation,
  buildInspectMode,
  buildListMode,
  buildStatusMode,
  buildSubmitMode,
  generateEscalationId,
  getDataDir,
  getEscalationsFilePath,
  main,
  parseArgs,
  readEscalations,
  submitEscalation,
  validateEscalation,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'status',
      status: 'FAIL',
      error: error && error.message ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
