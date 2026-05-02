#!/usr/bin/env node
/**
 * skill-intake.cjs — Observe-only skill/repo candidate registry reader.
 * Reads data/mission-control/skill-intake.json, validates, and emits a JSON summary.
 * Never clones, installs, fetches, executes, or mutates anything.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'mission-control', 'skill-intake.json');

const REQUIRED_FIELDS = [
  'name',
  'repo_url',
  'category',
  'proposed_use',
  'integration_status',
  'risk_level',
  'allowed_actions',
  'forbidden_actions',
  'notes',
];

function validate(entries) {
  const errors = [];
  for (const [i, entry] of entries.entries()) {
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry) || entry[field] === null || entry[field] === undefined) {
        errors.push(`entry[${i}] (${entry.name || '?'}) missing required field: ${field}`);
      }
    }
    if (typeof entry.risk_level !== 'number' || ![0, 1, 2, 3].includes(entry.risk_level)) {
      errors.push(`entry[${i}] (${entry.name}) risk_level must be 0|1|2|3, got: ${entry.risk_level}`);
    }
    if (!Array.isArray(entry.allowed_actions)) {
      errors.push(`entry[${i}] (${entry.name}) allowed_actions must be an array`);
    }
    if (!Array.isArray(entry.forbidden_actions)) {
      errors.push(`entry[${i}] (${entry.name}) forbidden_actions must be an array`);
    }
  }
  return errors;
}

function summarize(entries) {
  const byCategory = {};
  const byRisk = { 0: 0, 1: 0, 2: 0, 3: 0 };

  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    byRisk[e.risk_level] = (byRisk[e.risk_level] || 0) + 1;
  }

  return { byCategory, byRisk };
}

let raw;
try {
  raw = fs.readFileSync(DATA_PATH, 'utf-8');
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: `Cannot read ${DATA_PATH}: ${e.message}` }));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid JSON in skill-intake.json: ${e.message}` }));
  process.exit(1);
}

const entries = data.entries || [];
const validationErrors = validate(entries);

if (validationErrors.length > 0) {
  console.log(JSON.stringify({ status: 'error', validation_errors: validationErrors }));
  process.exit(1);
}

const { byCategory, byRisk } = summarize(entries);

const candidates = entries
  .filter(e => e.integration_status === 'candidate')
  .map(e => ({
    name: e.name,
    repo_url: e.repo_url,
    category: e.category,
    risk_level: e.risk_level,
    proposed_use: e.proposed_use,
    allowed_actions: e.allowed_actions,
  }));

console.log(JSON.stringify({
  status: 'ok',
  label: 'OBSERVE ONLY',
  schema_version: data.schema_version || '1',
  total: entries.length,
  candidates: candidates.length,
  counts_by_category: byCategory,
  counts_by_risk: byRisk,
  candidate_list: candidates,
  validation_errors: [],
}, null, 2));
