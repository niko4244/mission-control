#!/usr/bin/env node
/**
 * policy-enforcement-middleware.cjs
 * Shared policy enforcement logic for all Mission Control bots.
 *
 * Every bot can require() this module to enforce the same policy rules
 * without duplicating logic. Provides: hard block checks, approval chain
 * lookup, autonomy boundary checks, and canonical decision output building.
 *
 * Observe-only. Never mutates files, git state, or remote systems.
 *
 * Modes (CLI):
 *   status   — Middleware health, policy load status
 *   enforce  — Enforce policy against a proposed action + context JSON
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Policy Enforcement Middleware v1';
const LABEL = 'SHARED POLICY LAYER / OBSERVE ONLY';
const VERSION = 1;

const ALWAYS_BLOCKED_ACTIONS = new Set([
  'force_push',
  'rewrite_history',
  'bypass_governance',
  'disable_tests',
  'expose_secrets',
  'self_approve_escalation',
  'merge_without_human',
  'git_add_dot',
]);

const HUMAN_ONLY_ACTIONS = new Set([
  'push',
  'create_pr',
  'merge',
  'force_push',
  'rewrite_history',
  'governance_bypass',
  'production_destructive',
  'secret_rotation',
  'constitution_change',
]);

const RISK_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs', 'TestOnly'];
const AUTONOMOUS_STAGE_COMMIT = new Set(['Low', 'Tooling', 'Docs', 'TestOnly']);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function loadPolicy(rootDir, options = {}) {
  if (options.policy) return { ok: true, policy: options.policy };
  const policyPath = path.join(rootDir, 'config', 'mission-control-policy.json');
  if (!fs.existsSync(policyPath)) return { ok: false, error: 'Policy file not found' };
  try {
    return { ok: true, policy: JSON.parse(fs.readFileSync(policyPath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isAlwaysBlocked(action) {
  const normalized = String(action || '').toLowerCase().replace(/[^a-z_]/g, '_');
  return ALWAYS_BLOCKED_ACTIONS.has(normalized)
    || normalized.includes('force')
    || normalized.includes('bypass')
    || normalized.includes('rewrite');
}

function isHumanOnly(action) {
  const normalized = String(action || '').toLowerCase().replace(/[\s-]/g, '_');
  return HUMAN_ONLY_ACTIONS.has(normalized);
}

function compareRisk(a, b) {
  return RISK_ORDER.indexOf(a) - RISK_ORDER.indexOf(b);
}

function isHigherRisk(a, b) {
  return compareRisk(a, b) < 0;
}

function getApprovalChain(riskClass, action, policy) {
  const matrix = policy && policy.approval_matrix ? policy.approval_matrix : {};
  const entry = matrix[riskClass];
  if (!entry) return { found: false, bots: [], human_required: true };

  const actionKey = `can_auto_${String(action).toLowerCase().replace(/[\s-]/g, '_')}`;
  const bots = Array.isArray(entry[actionKey]) ? entry[actionKey] : [];
  const humanRequired = Array.isArray(entry.human_required_for)
    ? entry.human_required_for.some((r) => String(action).toLowerCase().includes(r.toLowerCase()))
    : false;

  const autoListExists = entry[actionKey] !== undefined;
  const implicitlyHuman = autoListExists && bots.length === 0;

  return {
    found: true,
    bots,
    human_required: humanRequired || implicitlyHuman,
    approved_bots: bots,
    human_required_for: entry.human_required_for || [],
  };
}

function checkHardBlocks(actionText, policy) {
  const lower = String(actionText || '').toLowerCase();
  const blocks = Array.isArray(policy && policy.hard_blocks) ? policy.hard_blocks : [];
  const matched = blocks.filter((block) => {
    const b = String(block).toLowerCase();
    if (b.includes('git add .') && lower.includes('git add .')) return true;
    if (b.includes('merge without human') && lower.includes('merge')) return true;
    if (b.includes('lockfile drift') && lower.includes('lockfile')) return true;
    if (b.includes('fallback regression') && lower.includes('fallback')) return true;
    if (b.includes('failed validation') && lower.includes('failed validation')) return true;
    return false;
  });
  return { blocked: matched.length > 0, matched };
}

function checkProtectedDomain(taskText, policy) {
  const lower = String(taskText || '').toLowerCase();
  const domains = Array.isArray(policy && policy.protected_domains) ? policy.protected_domains : [];
  const hit = domains.filter((d) => lower.includes(String(d).toLowerCase()));
  return { protected: hit.length > 0, domains: hit };
}

function buildDecision(options = {}) {
  const {
    action = '',
    risk = 'Unknown',
    actor = '',
    approved_by = [],
    blockers = [],
    warnings = [],
    validation_required = [],
    next_action = '',
    autonomous = false,
  } = options;

  const humanRequired = isHumanOnly(action)
    || blockers.length > 0
    || HUMAN_ONLY_ACTIONS.has(String(action).toLowerCase().replace(/[\s-]/g, '_'));

  return {
    decision: blockers.length > 0 ? 'REJECT' : autonomous ? 'APPROVE' : 'PENDING_HUMAN',
    risk_level: risk,
    authority_required: humanRequired ? 'human' : 'bot',
    actor,
    approved_by: unique(approved_by),
    blockers: unique(blockers),
    warnings: unique(warnings),
    validation_required: unique(validation_required),
    next_action: next_action || (blockers.length > 0 ? 'Resolve blockers before continuing' : 'Await authorization'),
    autonomous_allowed: autonomous && blockers.length === 0,
    human_required: humanRequired,
    timestamp: new Date().toISOString(),
  };
}

function enforce(proposedAction, context = {}, policy) {
  const blockers = [];
  const warnings = [];
  const riskClass = context.risk || 'Unknown';

  if (isAlwaysBlocked(proposedAction)) {
    blockers.push(`Action "${proposedAction}" is permanently blocked by governance policy`);
  }

  const hardBlockResult = checkHardBlocks(proposedAction, policy);
  blockers.push(...hardBlockResult.matched.map((b) => `Hard block: ${b}`));

  if (context.task) {
    const domainResult = checkProtectedDomain(context.task, policy);
    if (domainResult.protected && !context.governor) {
      warnings.push(`Task touches protected domains without named governor: ${domainResult.domains.join(', ')}`);
    }
  }

  const approvalChain = getApprovalChain(riskClass, proposedAction, policy);
  if (approvalChain.found && approvalChain.human_required) {
    if (!isAlwaysBlocked(proposedAction)) {
      warnings.push(`"${proposedAction}" at risk "${riskClass}" requires human approval`);
    }
  }

  const autonomous = blockers.length === 0
    && AUTONOMOUS_STAGE_COMMIT.has(riskClass)
    && !isHumanOnly(proposedAction)
    && approvalChain.bots.length > 0;

  const validationRequired = [];
  if (policy && policy.required_validation && policy.required_validation[riskClass]) {
    validationRequired.push(...policy.required_validation[riskClass]);
  }

  return buildDecision({
    action: proposedAction,
    risk: riskClass,
    actor: context.actor || '',
    approved_by: context.approved_by || [],
    blockers,
    warnings,
    validation_required: validationRequired,
    next_action: context.next_action || '',
    autonomous,
  });
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    version: VERSION,
    mode,
    status: data.status || 'PASS',
    observe_only: true,
    warnings: data.warnings || [],
    blocking_conditions: data.blocking_conditions || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode(rootDir, options = {}) {
  const loaded = loadPolicy(rootDir, options);
  const warnings = [];
  if (!loaded.ok) warnings.push(`Policy unavailable: ${loaded.error}`);

  const result = buildOutput('status', {
    status: loaded.ok ? 'PASS' : 'FAIL',
    warnings,
    metadata: {
      policy_loaded: loaded.ok,
      always_blocked_count: ALWAYS_BLOCKED_ACTIONS.size,
      human_only_count: HUMAN_ONLY_ACTIONS.size,
      autonomous_stage_commit_risks: [...AUTONOMOUS_STAGE_COMMIT],
      policy_hard_block_count: loaded.ok ? (loaded.policy.hard_blocks || []).length : 0,
    },
  });
  result.summary = `${AGENT} | ${result.status} | ${ALWAYS_BLOCKED_ACTIONS.size} blocked | ${HUMAN_ONLY_ACTIONS.size} human-only`;
  return result;
}

function buildEnforceMode(rootDir, actionText, contextText, options = {}) {
  const loaded = loadPolicy(rootDir, options);
  if (!loaded.ok) {
    const result = buildOutput('enforce', {
      status: 'FAIL',
      blocking_conditions: [`Policy unavailable: ${loaded.error}`],
      metadata: { action: actionText, decision: null },
    });
    result.summary = `${AGENT} | enforce | FAIL — policy unavailable`;
    return result;
  }

  let context = {};
  if (contextText) {
    try {
      context = JSON.parse(contextText);
    } catch {
      context = {};
    }
  }

  const decision = enforce(actionText, context, loaded.policy);
  const result = buildOutput('enforce', {
    status: decision.blockers.length > 0 ? 'FAIL' : decision.warnings.length > 0 ? 'WARN' : 'PASS',
    warnings: decision.warnings,
    blocking_conditions: decision.blockers,
    metadata: { action: actionText, context, decision },
  });
  result.summary = `${AGENT} | enforce | ${decision.decision} | ${actionText.slice(0, 60)}`;
  return result;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const validModes = new Set(['status', 'enforce']);
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

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  if (parsed.mode === 'enforce') {
    return buildEnforceMode(rootDir, parsed.options.action || '', parsed.options.context || '', options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT, LABEL, VERSION,
  ALWAYS_BLOCKED_ACTIONS, HUMAN_ONLY_ACTIONS, AUTONOMOUS_STAGE_COMMIT,
  buildDecision, buildEnforceMode, buildOutput, buildStatusMode,
  checkHardBlocks, checkProtectedDomain, compareRisk, enforce,
  formatOutput, getApprovalChain, isAlwaysBlocked, isHigherRisk, isHumanOnly,
  loadPolicy, main, normalizePath, parseArgs, unique,
};

if (require.main === module) {
  try {
    process.stdout.write(formatOutput(main()));
  } catch (error) {
    process.stderr.write(JSON.stringify({ agent: AGENT, status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
    process.exit(1);
  }
}
