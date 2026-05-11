#!/usr/bin/env node
/**
 * request-intake-pipeline.cjs
 * Observe-only entry point for all incoming work requests.
 * Ingests a user request, classifies it, risk-scores it, and routes it to
 * the correct bot/governor/executor. Produces a structured intake receipt.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const AGENT = 'Request Intake Pipeline v1';
const LABEL = 'OBSERVE ONLY / REQUEST CLASSIFIER';
const VALID_MODES = new Set(['status', 'intake']);
const VALID_SOURCES = new Set(['human', 'bot', 'scheduled']);

const INTENT_PATTERNS = {
  security: ['security', 'harden', 'hardening', 'vulnerability', 'cve', 'exploit', 'auth', 'authentication', 'authorization', 'token', 'tokens', 'key', 'keys', 'gateway', 'gateways', 'terminal', 'exec', 'approval', 'approvals', 'workspace fallback', 'workspace enforcement'],
  bug_fix: ['fix', 'bug', 'broken', 'crash', 'error', 'exception', 'regression', 'fail', 'failing', 'not working'],
  feature: ['add', 'implement', 'feature', 'new', 'create', 'build', 'introduce', 'support'],
  governance: ['policy', 'governance', 'rule', 'rules', 'authority', 'permission', 'bot registry', 'hierarchy', 'mandate', 'enforce'],
  docs: ['docs', 'documentation', 'readme', 'typo', 'guide', 'clarify', 'comment', 'comments'],
  tooling: ['tooling', 'script', 'scripts', 'lint', 'typecheck', 'build', 'vitest', 'test harness', 'config', 'ci', 'setup'],
  refactor: ['refactor', 'refactoring', 'restructure', 'reorganize', 'clean up', 'cleanup', 'rename', 'extract'],
  investigation: ['investigate', 'investigation', 'diagnose', 'audit', 'review', 'check', 'inspect', 'why', 'what is', 'understand', 'research'],
};

const HARD_BLOCK_PATTERNS = [
  { pattern: 'git add .', test: (lower) => lower.includes('git add .') },
  { pattern: 'lockfile drift unless explicitly approved', test: (lower) => lower.includes('lockfile') },
  { pattern: 'package drift unless explicitly approved', test: (lower) => lower.includes('package drift') || (lower.includes('package') && lower.includes('drift')) },
  { pattern: 'failed validation', test: (lower) => lower.includes('failed validation') || lower.includes('skip validation') || lower.includes('bypass validation') },
  { pattern: 'fallback regression', test: (lower) => lower.includes('workspace fallback') || lower.includes('fallback regression') },
  { pattern: 'helper/auth/workspace enforcement changes without explicit approval', test: (lower) => lower.includes('auth helper') || lower.includes('workspace enforcement') },
  { pattern: 'schema/database changes without explicit approval', test: (lower) => lower.includes('schema') && lower.includes('change') || lower.includes('database') && lower.includes('change') || lower.includes('schema migration') || lower.includes('alter table') },
  { pattern: 'merge without human approval', test: (lower) => lower.includes('merge') && (lower.includes('auto') || lower.includes('autonomous') || lower.includes('without')) },
  { pattern: 'client-supplied workspace ID trusted', test: (lower) => lower.includes('client-supplied workspace') || (lower.includes('workspace id') && lower.includes('trust')) },
  { pattern: 'broad unrelated route family changes', test: (lower) => lower.includes('all routes') || lower.includes('every route') || (lower.includes('route family') && lower.includes('all')) },
];

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function generateRequestId() {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xfffff).toString(16).padStart(5, '0');
  return `req-${ts}-${rand}`;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const rawMode = String(args[0] || '').toLowerCase();
  const mode = VALID_MODES.has(rawMode) ? args.shift() && rawMode : 'status';
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

function classifyIntent(requestText) {
  const lower = String(requestText || '').toLowerCase();
  const scores = {};

  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    scores[intent] = keywords.filter((kw) => lower.includes(kw)).length;
  }

  const sorted = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length > 0) return sorted[0][0];

  // Fallback heuristics
  if (lower.includes('fix') || lower.includes('bug')) return 'bug_fix';
  if (lower.includes('add') || lower.includes('new')) return 'feature';
  return 'investigation';
}

function computeRiskLevel(requestText, intent) {
  const lower = String(requestText || '').toLowerCase();

  const testOnlyKw = ['test only', 'test-only', 'spec only', 'coverage only'];
  const docKw = ['docs', 'documentation', 'readme', 'typo', 'guide'];
  const toolingKw = ['tooling', 'script', 'scripts', 'lint', 'typecheck', 'build', 'vitest', 'test harness', 'config'];
  const criticalKw = ['auth', 'token', 'tokens', 'key', 'keys', 'gateway', 'gateways', 'terminal', 'exec', 'approval', 'approvals', 'schema', 'database', 'lockfile', 'package.json', 'workspace enforcement', 'workspace fallback', 'security', 'vulnerability', 'exploit', 'cve'];
  const highKw = ['release', 'merge', 'pull request', 'pr ', 'deploy', 'delivery', 'workflow', 'pipeline', 'architecture drift'];

  if (testOnlyKw.some((k) => lower.includes(k))) return 'TestOnly';
  if (intent === 'docs' || (docKw.some((k) => lower.includes(k)) && !criticalKw.some((k) => lower.includes(k)))) return 'Docs';
  if (intent === 'tooling' || (toolingKw.some((k) => lower.includes(k)) && !criticalKw.some((k) => lower.includes(k)))) return 'Tooling';
  if (intent === 'security' || criticalKw.some((k) => lower.includes(k))) return 'Critical';
  if (highKw.some((k) => lower.includes(k))) return 'High';
  if (intent === 'feature' || intent === 'refactor') return 'Medium';
  if (intent === 'bug_fix') return 'Medium';
  return 'Low';
}

function detectHardBlocks(requestText) {
  const lower = String(requestText || '').toLowerCase();
  return HARD_BLOCK_PATTERNS
    .filter((block) => block.test(lower))
    .map((block) => block.pattern);
}

function tryLoadBotSystem(rootDir) {
  try {
    const botSystemPath = path.join(rootDir, 'scripts', 'mission-control-bot-system.cjs');
    if (fs.existsSync(botSystemPath)) {
      return { module: require(botSystemPath), available: true, error: '' };
    }
    return { module: null, available: false, error: 'mission-control-bot-system.cjs not found' };
  } catch (err) {
    return { module: null, available: false, error: err && err.message ? err.message : String(err) };
  }
}

function loadPolicyForRouting(rootDir, botSystem) {
  if (!botSystem || !botSystem.available || !botSystem.module) return null;
  try {
    return botSystem.module.loadPolicy(rootDir);
  } catch (_) {
    return null;
  }
}

function buildFallbackRouting(riskLevel, intent) {
  const routingMap = {
    security: { primary_bot: 'security-governor', secondary_bot: 'security-executor', arbiter: 'chief-arbiter' },
    bug_fix: { primary_bot: 'chief-arbiter', secondary_bot: '', arbiter: 'chief-arbiter' },
    feature: { primary_bot: 'chief-arbiter', secondary_bot: '', arbiter: 'chief-arbiter' },
    governance: { primary_bot: 'chief-arbiter', secondary_bot: 'bot-registry-inspector', arbiter: 'chief-arbiter' },
    docs: { primary_bot: 'documentation-governor', secondary_bot: 'documentation-executor', arbiter: 'chief-arbiter' },
    tooling: { primary_bot: 'chief-arbiter', secondary_bot: 'test-coverage-auditor', arbiter: 'chief-arbiter' },
    refactor: { primary_bot: 'architecture-governor', secondary_bot: 'route-family-migrator', arbiter: 'chief-arbiter' },
    investigation: { primary_bot: 'chief-arbiter', secondary_bot: '', arbiter: 'chief-arbiter' },
  };

  const base = routingMap[intent] || { primary_bot: 'chief-arbiter', secondary_bot: '', arbiter: 'chief-arbiter' };
  const arbiterRequired = riskLevel === 'Critical' || riskLevel === 'High';

  return {
    primary_bot: base.primary_bot,
    secondary_bot: base.secondary_bot,
    arbiter: base.arbiter,
    arbiter_required: arbiterRequired,
  };
}

function buildRouting(requestText, riskLevel, intent, policy) {
  if (!policy) {
    return buildFallbackRouting(riskLevel, intent);
  }

  try {
    const profiles = Array.isArray(policy.routing_profiles) ? policy.routing_profiles : [];
    const lower = String(requestText || '').toLowerCase();

    const scored = profiles
      .map((profile) => ({
        profile,
        score: (profile.keywords || []).filter((kw) => lower.includes(String(kw).toLowerCase())).length,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = scored[0] ? scored[0].profile : null;

    const arbiterRequired = riskLevel === 'Critical' || riskLevel === 'High';

    if (best) {
      return {
        primary_bot: best.governor || 'chief-arbiter',
        secondary_bot: best.executor || best.runner || '',
        arbiter: best.arbiter || 'chief-arbiter',
        arbiter_required: arbiterRequired,
      };
    }

    return buildFallbackRouting(riskLevel, intent);
  } catch (_) {
    return buildFallbackRouting(riskLevel, intent);
  }
}

function buildApprovalEnvelope(riskLevel, hardBlocks) {
  const autonomous_actions = [];
  const human_required_actions = [];

  // Always autonomous-safe for these risk levels
  if (riskLevel === 'Docs') {
    autonomous_actions.push('observe', 'classify', 'plan', 'validate', 'commit');
    human_required_actions.push('pr', 'merge');
  } else if (riskLevel === 'TestOnly') {
    autonomous_actions.push('observe', 'classify', 'plan', 'validate', 'commit');
    human_required_actions.push('pr', 'merge');
  } else if (riskLevel === 'Tooling') {
    autonomous_actions.push('observe', 'classify', 'plan', 'stage', 'commit');
    human_required_actions.push('pr', 'merge');
  } else if (riskLevel === 'Low') {
    autonomous_actions.push('observe', 'classify', 'plan', 'approve (arbiter)', 'stage', 'commit');
    human_required_actions.push('pr', 'merge');
  } else if (riskLevel === 'Medium') {
    autonomous_actions.push('observe', 'classify', 'plan', 'approve (arbiter)', 'stage', 'commit');
    human_required_actions.push('pr', 'merge');
  } else if (riskLevel === 'High') {
    autonomous_actions.push('observe', 'classify');
    human_required_actions.push('plan (requires governor)', 'approve (requires chief-arbiter)', 'push', 'pr', 'merge');
  } else if (riskLevel === 'Critical') {
    autonomous_actions.push('observe', 'classify');
    human_required_actions.push('plan (requires arbiter)', 'approve (requires chief-arbiter)', 'stage', 'commit', 'push', 'pr', 'merge');
  }

  // Hard blocks override
  if (hardBlocks && hardBlocks.length > 0) {
    human_required_actions.push(...hardBlocks.map((block) => `hard block review: ${block}`));
  }

  return {
    autonomous_actions: unique(autonomous_actions),
    human_required_actions: unique(human_required_actions),
  };
}

function determineLifecycleEntry(riskLevel, hardBlocks) {
  if (hardBlocks && hardBlocks.length > 0) return 'observe';
  if (riskLevel === 'Docs' || riskLevel === 'TestOnly') return 'observe';
  return 'observe';
}

function requiresHuman(riskLevel, hardBlocks, routing) {
  if (hardBlocks && hardBlocks.length > 0) return true;
  if (riskLevel === 'Critical' || riskLevel === 'High') return true;
  if (routing && routing.arbiter_required) return true;
  return false;
}

function buildIntakeReceipt(requestText, source, rootDir) {
  const safeSource = VALID_SOURCES.has(source) ? source : 'human';
  const intent = classifyIntent(requestText);
  const botSystem = tryLoadBotSystem(rootDir);
  const policy = loadPolicyForRouting(rootDir, botSystem);
  const riskLevel = computeRiskLevel(requestText, intent);
  const hardBlocks = detectHardBlocks(requestText);

  let policyHardBlocks = [];
  if (policy && botSystem && botSystem.module) {
    try {
      policyHardBlocks = botSystem.module.relevantHardBlocks(requestText, policy);
    } catch (_) {
      // ignore
    }
  }

  const allHardBlocks = unique([...hardBlocks, ...policyHardBlocks]);
  const routing = buildRouting(requestText, riskLevel, intent, policy);
  const approvalEnvelope = buildApprovalEnvelope(riskLevel, allHardBlocks);
  const lifecycleEntry = determineLifecycleEntry(riskLevel, allHardBlocks);
  const human_required = requiresHuman(riskLevel, allHardBlocks, routing);

  return {
    request_id: generateRequestId(),
    request: requestText,
    source: safeSource,
    intent,
    risk_level: riskLevel,
    hard_blocks: allHardBlocks,
    routing,
    approval_envelope: approvalEnvelope,
    lifecycle_entry: lifecycleEntry,
    requires_human: human_required,
    timestamp: new Date().toISOString(),
  };
}

function buildStatusMode(rootDir) {
  const botSystem = tryLoadBotSystem(rootDir);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'status',
    status: 'PASS',
    subsystems: {
      'bot-system': {
        available: botSystem.available,
        error: botSystem.error,
      },
    },
    valid_sources: [...VALID_SOURCES],
    intent_classes: Object.keys(INTENT_PATTERNS),
    hard_block_patterns: HARD_BLOCK_PATTERNS.map((b) => b.pattern),
    summary: `${AGENT} (${LABEL}) — observe-only request classifier. Bot-system: ${botSystem.available ? 'available' : 'unavailable'}.`,
  };
}

function buildIntakeMode(requestText, source, rootDir) {
  if (!requestText) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'intake',
      status: 'FAIL',
      error: 'Missing required --request value',
      receipt: null,
      summary: `${AGENT}: intake mode requires --request`,
    };
  }

  const receipt = buildIntakeReceipt(requestText, source, rootDir);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'intake',
    status: receipt.hard_blocks.length > 0 ? 'WARN' : 'PASS',
    receipt,
    summary: `${AGENT}: intake complete. request_id=${receipt.request_id} intent=${receipt.intent} risk=${receipt.risk_level} requires_human=${receipt.requires_human} hard_blocks=${receipt.hard_blocks.length}`,
  };
}

function main(argv, options) {
  const args = argv || process.argv.slice(2);
  const opts = options || {};
  const parsed = parseArgs(args);
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'intake') {
    return buildIntakeMode(
      parsed.options.request || '',
      parsed.options.source || 'human',
      rootDir,
    );
  }

  return buildStatusMode(rootDir);
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary || ''}\n`;
}

module.exports = {
  AGENT,
  LABEL,
  VALID_MODES,
  VALID_SOURCES,
  INTENT_PATTERNS,
  HARD_BLOCK_PATTERNS,
  buildApprovalEnvelope,
  buildFallbackRouting,
  buildIntakeMode,
  buildIntakeReceipt,
  buildRouting,
  buildStatusMode,
  classifyIntent,
  computeRiskLevel,
  detectHardBlocks,
  determineLifecycleEntry,
  formatOutput,
  generateRequestId,
  loadPolicyForRouting,
  main,
  parseArgs,
  requiresHuman,
  tryLoadBotSystem,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
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
