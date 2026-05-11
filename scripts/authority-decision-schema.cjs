#!/usr/bin/env node
/**
 * authority-decision-schema.cjs
 * Canonical decision schema for all Mission Control bots.
 *
 * Defines and validates the shared output shape every bot must return:
 *   decision, risk_level, authority_required, approved_by,
 *   blockers, validation_required, next_action
 *
 * Observe-only. Never mutates files, git state, or remote systems.
 *
 * Modes (CLI):
 *   status         — Schema health, field list
 *   validate       — Validate a decision JSON against the schema
 *   template       — Output an empty canonical decision template
 */

'use strict';

const AGENT = 'Authority Decision Schema v1';
const LABEL = 'SHARED DECISION CONTRACT / OBSERVE ONLY';
const SCHEMA_VERSION = 1;

const VALID_DECISIONS = new Set([
  'APPROVE',
  'APPROVE_WITH_NOTES',
  'PENDING_HUMAN',
  'REQUEST_CORRECTIONS',
  'REJECT',
  'ESCALATE_TO_HUMAN',
  'BLOCKED',
]);

const VALID_RISK_LEVELS = new Set([
  'Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs', 'TestOnly', 'Unknown',
]);

const VALID_AUTHORITY = new Set(['human', 'bot', 'chief-arbiter', 'domain-governor', 'executor']);

const REQUIRED_FIELDS = [
  'decision',
  'risk_level',
  'authority_required',
  'approved_by',
  'blockers',
  'validation_required',
  'next_action',
];

const OPTIONAL_FIELDS = [
  'actor',
  'warnings',
  'autonomous_allowed',
  'human_required',
  'timestamp',
  'notes',
  'schema_version',
];

const ALL_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function validateDecision(decision) {
  const errors = [];
  const warnings = [];

  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { valid: false, errors: ['Decision must be a plain object'], warnings: [] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (decision[field] === undefined || decision[field] === null) {
      errors.push(`Required field missing: ${field}`);
    }
  }

  if (decision.decision !== undefined && !VALID_DECISIONS.has(String(decision.decision))) {
    errors.push(`Invalid decision value: "${decision.decision}". Valid: ${[...VALID_DECISIONS].join(', ')}`);
  }
  if (decision.risk_level !== undefined && !VALID_RISK_LEVELS.has(String(decision.risk_level))) {
    errors.push(`Invalid risk_level: "${decision.risk_level}"`);
  }
  if (decision.authority_required !== undefined && !VALID_AUTHORITY.has(String(decision.authority_required))) {
    warnings.push(`Unusual authority_required value: "${decision.authority_required}"`);
  }
  if (decision.approved_by !== undefined && !Array.isArray(decision.approved_by)) {
    errors.push('approved_by must be an array');
  }
  if (decision.blockers !== undefined && !Array.isArray(decision.blockers)) {
    errors.push('blockers must be an array');
  }
  if (decision.validation_required !== undefined && !Array.isArray(decision.validation_required)) {
    errors.push('validation_required must be an array');
  }
  if (decision.next_action !== undefined && typeof decision.next_action !== 'string') {
    errors.push('next_action must be a string');
  }

  const unknownFields = Object.keys(decision).filter((k) => !ALL_FIELDS.has(k));
  if (unknownFields.length > 0) {
    warnings.push(`Unknown fields (consider adding to schema): ${unknownFields.join(', ')}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function buildTemplate(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    decision: overrides.decision || 'PENDING_HUMAN',
    risk_level: overrides.risk_level || 'Unknown',
    authority_required: overrides.authority_required || 'human',
    actor: overrides.actor || '',
    approved_by: overrides.approved_by || [],
    blockers: overrides.blockers || [],
    warnings: overrides.warnings || [],
    validation_required: overrides.validation_required || [],
    next_action: overrides.next_action || '',
    autonomous_allowed: overrides.autonomous_allowed || false,
    human_required: overrides.human_required !== undefined ? overrides.human_required : true,
    timestamp: overrides.timestamp || new Date().toISOString(),
    notes: overrides.notes || '',
  };
}

function normalizeDecision(raw) {
  if (!raw || typeof raw !== 'object') return buildTemplate();
  return {
    schema_version: raw.schema_version || SCHEMA_VERSION,
    decision: VALID_DECISIONS.has(String(raw.decision || '')) ? raw.decision : 'PENDING_HUMAN',
    risk_level: VALID_RISK_LEVELS.has(String(raw.risk_level || '')) ? raw.risk_level : 'Unknown',
    authority_required: String(raw.authority_required || 'human'),
    actor: String(raw.actor || ''),
    approved_by: Array.isArray(raw.approved_by) ? unique(raw.approved_by) : [],
    blockers: Array.isArray(raw.blockers) ? unique(raw.blockers) : [],
    warnings: Array.isArray(raw.warnings) ? unique(raw.warnings) : [],
    validation_required: Array.isArray(raw.validation_required) ? unique(raw.validation_required) : [],
    next_action: typeof raw.next_action === 'string' ? raw.next_action : '',
    autonomous_allowed: Boolean(raw.autonomous_allowed),
    human_required: raw.human_required !== false,
    timestamp: raw.timestamp || new Date().toISOString(),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    schema_version: SCHEMA_VERSION,
    mode,
    status: data.status || 'PASS',
    observe_only: true,
    warnings: data.warnings || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode() {
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      schema_version: SCHEMA_VERSION,
      required_fields: REQUIRED_FIELDS,
      optional_fields: OPTIONAL_FIELDS,
      valid_decisions: [...VALID_DECISIONS],
      valid_risk_levels: [...VALID_RISK_LEVELS],
      valid_authority: [...VALID_AUTHORITY],
    },
  });
  result.summary = `${AGENT} | PASS | ${REQUIRED_FIELDS.length} required fields | ${VALID_DECISIONS.size} valid decisions`;
  return result;
}

function buildValidateMode(decisionText) {
  let decision;
  try {
    decision = typeof decisionText === 'object' ? decisionText : JSON.parse(decisionText);
  } catch {
    const result = buildOutput('validate', {
      status: 'FAIL',
      warnings: ['Input is not valid JSON'],
      metadata: { valid: false, errors: ['Input is not valid JSON'], warnings: [] },
    });
    result.summary = `${AGENT} | validate | FAIL — invalid JSON`;
    return result;
  }

  const validation = validateDecision(decision);
  const result = buildOutput('validate', {
    status: validation.valid ? (validation.warnings.length > 0 ? 'WARN' : 'PASS') : 'FAIL',
    warnings: validation.warnings,
    metadata: { ...validation, decision },
  });
  result.summary = `${AGENT} | validate | ${validation.valid ? 'VALID' : 'INVALID'} — ${validation.errors.length} errors, ${validation.warnings.length} warnings`;
  return result;
}

function buildTemplateMode(overrides = {}) {
  const template = buildTemplate(overrides);
  const result = buildOutput('template', {
    status: 'PASS',
    metadata: { template },
  });
  result.summary = `${AGENT} | template | Canonical decision template`;
  return result;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const validModes = new Set(['status', 'validate', 'template']);
  const mode = validModes.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i];
    if (!cur || !cur.startsWith('--')) continue;
    const key = cur.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { options[key] = next; i += 1; }
    else options[key] = true;
  }
  return { mode, options };
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.mode === 'validate') return buildValidateMode(parsed.options.decision || '{}');
  if (parsed.mode === 'template') return buildTemplateMode();
  return buildStatusMode();
}

module.exports = {
  AGENT, LABEL, SCHEMA_VERSION,
  VALID_DECISIONS, VALID_RISK_LEVELS, VALID_AUTHORITY,
  REQUIRED_FIELDS, OPTIONAL_FIELDS,
  buildDecision: buildTemplate,
  buildOutput, buildStatusMode, buildTemplateMode, buildValidateMode,
  buildTemplate, formatOutput, main, normalizeDecision, parseArgs,
  unique, validateDecision,
};

if (require.main === module) {
  try {
    process.stdout.write(formatOutput(main()));
  } catch (error) {
    process.stderr.write(JSON.stringify({ agent: AGENT, status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
    process.exit(1);
  }
}
