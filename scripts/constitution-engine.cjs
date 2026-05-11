#!/usr/bin/env node
/**
 * constitution-engine.cjs
 * Machine-readable authority source of truth for Mission Control.
 *
 * Runtime API over config/mission-control-policy.json.
 * Answers: what is forbidden, what requires human approval, what is within
 * autonomous authority, what risk class does a task fall into.
 *
 * Observe-only. Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status           — Policy health, key rule counts
 *   check --action   — Is this action forbidden by policy?
 *   classify --task  — What risk class and approval chain?
 *   authority --risk — What is approved/blocked for this risk class?
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Constitution Engine v1';
const LABEL = 'MACHINE-READABLE AUTHORITY / OBSERVE ONLY';
const VALID_MODES = new Set(['status', 'check', 'classify', 'authority']);

const POLICY_PATH = path.join('config', 'mission-control-policy.json');

const FORBIDDEN_COMMAND_PATTERNS = [
  { id: 'git_add_dot', pattern: /^git add \.$/, description: 'Stage all files without review' },
  { id: 'force_push', pattern: /--force|-f\b/, description: 'Force push (history rewrite risk)' },
  { id: 'no_verify', pattern: /--no-verify/, description: 'Skip git hooks' },
  { id: 'test_disable', pattern: /skip.*test|disable.*test|test.*skip|--testPathIgnorePatterns/, description: 'Disable or skip tests' },
  { id: 'secret_exposure', pattern: /echo.*secret|cat.*\.env|print.*token|console\.log.*key/i, description: 'Potential secret exposure' },
  { id: 'history_rewrite', pattern: /git rebase.*-i|git filter-branch|git reset.*--hard.*HEAD~/, description: 'Git history rewrite' },
  { id: 'governance_bypass', pattern: /bypass.*governance|skip.*arbiter|ignore.*governor/, description: 'Governance bypass attempt' },
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function loadPolicy(rootDir, options = {}) {
  if (options.policy) return { ok: true, policy: options.policy };
  const policyPath = path.join(rootDir, POLICY_PATH);
  if (!fs.existsSync(policyPath)) {
    return { ok: false, error: `Policy file not found: ${normalizePath(policyPath)}` };
  }
  try {
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    return { ok: true, policy };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function loadBotSystemApi(rootDir) {
  const scriptPath = path.join(rootDir, 'scripts', 'mission-control-bot-system.cjs');
  if (!fs.existsSync(scriptPath)) return null;
  try {
    return require(scriptPath);
  } catch {
    return null;
  }
}

function checkForbiddenCommand(commandText) {
  const text = String(commandText || '');
  const violations = FORBIDDEN_COMMAND_PATTERNS.filter(({ pattern }) => pattern.test(text));
  return {
    forbidden: violations.length > 0,
    violations: violations.map(({ id, description }) => ({ id, description })),
  };
}

function checkPolicyHardBlock(actionText, policy) {
  const lower = String(actionText || '').toLowerCase();
  const blocks = Array.isArray(policy && policy.hard_blocks) ? policy.hard_blocks : [];
  const matched = blocks.filter((block) => {
    const blockLower = String(block).toLowerCase();
    if (blockLower.includes('git add .') && lower.includes('git add .')) return true;
    if (blockLower.includes('merge without human') && lower.includes('merge')) return true;
    if (blockLower.includes('lockfile drift') && lower.includes('lockfile')) return true;
    if (blockLower.includes('fallback regression') && (lower.includes('fallback') || lower.includes('workspace_id ?? 1'))) return true;
    if (blockLower.includes('raw internal error') && lower.includes('stack trace')) return true;
    if (blockLower.includes('failed validation') && lower.includes('failed')) return true;
    return false;
  });
  return { blocked: matched.length > 0, matched_blocks: matched };
}

function requiresHumanApproval(riskClass, action, policy) {
  const matrix = policy && policy.approval_matrix ? policy.approval_matrix : {};
  const riskEntry = matrix[riskClass];
  if (!riskEntry) return { required: true, reason: `Unknown risk class: ${riskClass}` };

  const humanRequired = Array.isArray(riskEntry.human_required_for) ? riskEntry.human_required_for : [];
  const actionLower = String(action || '').toLowerCase();
  const matchedExplicit = humanRequired.find((req) => actionLower.includes(req.toLowerCase()));

  const autoKey = `can_auto_${actionLower.replace(/\s+/g, '_')}`;
  const autoList = riskEntry[autoKey];
  const implicitlyRequired = Array.isArray(autoList) && autoList.length === 0;

  return {
    required: Boolean(matchedExplicit) || implicitlyRequired,
    matched_rule: matchedExplicit || (implicitlyRequired ? `${autoKey} is empty` : null),
    human_required_for: humanRequired,
  };
}

function canActAutonomously(riskClass, action, policy) {
  const matrix = policy && policy.approval_matrix ? policy.approval_matrix : {};
  const riskEntry = matrix[riskClass];
  if (!riskEntry) return { allowed: false, reason: `Unknown risk class: ${riskClass}` };

  const actionKey = `can_auto_${String(action).toLowerCase().replace(/\s+/g, '_')}`;
  const approvedBots = Array.isArray(riskEntry[actionKey]) ? riskEntry[actionKey] : null;
  if (!approvedBots) return { allowed: false, reason: `No autonomous rule for action "${action}" at risk "${riskClass}"` };

  return {
    allowed: approvedBots.length > 0,
    approved_bots: approvedBots,
    reason: approvedBots.length > 0
      ? `Autonomous action allowed for: ${approvedBots.join(', ')}`
      : `No bots authorized for autonomous "${action}" at risk "${riskClass}"`,
  };
}

function classifyTask(taskText, policy) {
  const botSystem = loadBotSystemApi(path.resolve(__dirname, '..'));
  if (!botSystem) {
    return {
      task: taskText,
      risk: 'Unknown',
      domain: 'unknown',
      governor: '',
      routing_available: false,
    };
  }
  try {
    const routing = botSystem.buildRoutingDecision(taskText, policy);
    return {
      task: taskText,
      risk: routing.risk,
      domain: routing.domain,
      governor: routing.governor,
      runner: routing.runner,
      executor: routing.executor,
      arbiter: routing.arbiter,
      blocked_actions: routing.blocked_actions || [],
      human_required_for: routing.human_required_for || [],
      routing_available: true,
    };
  } catch {
    return { task: taskText, risk: 'Unknown', domain: 'unknown', governor: '', routing_available: false };
  }
}

function getAuthorityRules(riskClass, policy) {
  const matrix = policy && policy.approval_matrix ? policy.approval_matrix : {};
  const entry = matrix[riskClass];
  if (!entry) return null;

  const humanOnlyActions = policy && policy.authority_rules
    ? (policy.authority_rules.human_only_actions || [])
    : [];

  return {
    risk_class: riskClass,
    can_auto_plan: entry.can_auto_plan || [],
    can_auto_approve_prompt: entry.can_auto_approve_prompt || [],
    can_auto_stage: entry.can_auto_stage || [],
    can_auto_commit: entry.can_auto_commit || [],
    can_auto_push: entry.can_auto_push || [],
    can_auto_create_pr: entry.can_auto_create_pr || [],
    can_auto_merge: entry.can_auto_merge || [],
    human_required_for: entry.human_required_for || [],
    human_only_actions: humanOnlyActions,
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    warnings: data.warnings || [],
    blocking_conditions: data.blocking_conditions || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode(rootDir, options = {}) {
  const loaded = loadPolicy(rootDir, options);
  if (!loaded.ok) {
    const result = buildOutput('status', {
      status: 'FAIL',
      blocking_conditions: [loaded.error],
      metadata: { policy_loaded: false },
    });
    result.summary = `${AGENT} | FAIL | Policy unavailable`;
    return result;
  }

  const policy = loaded.policy;
  const riskClasses = Array.isArray(policy.risk_classes) ? policy.risk_classes.map((r) => r.id) : [];
  const hardBlocks = Array.isArray(policy.hard_blocks) ? policy.hard_blocks : [];
  const protectedDomains = Array.isArray(policy.protected_domains) ? policy.protected_domains : [];
  const routingProfiles = Array.isArray(policy.routing_profiles) ? policy.routing_profiles : [];
  const humanOnlyActions = policy.authority_rules && policy.authority_rules.human_only_actions
    ? policy.authority_rules.human_only_actions
    : [];

  const warnings = [];
  if (riskClasses.length === 0) warnings.push('No risk classes defined in policy');
  if (hardBlocks.length === 0) warnings.push('No hard blocks defined in policy');
  if (protectedDomains.length === 0) warnings.push('No protected domains defined in policy');

  const result = buildOutput('status', {
    status: warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    metadata: {
      policy_loaded: true,
      policy_version: policy.version,
      risk_classes: riskClasses,
      hard_block_count: hardBlocks.length,
      protected_domain_count: protectedDomains.length,
      routing_profile_count: routingProfiles.length,
      human_only_actions: humanOnlyActions,
      forbidden_command_patterns: FORBIDDEN_COMMAND_PATTERNS.map((p) => ({ id: p.id, description: p.description })),
    },
  });
  result.summary = [
    `${AGENT} | ${result.status}`,
    `Risk classes: ${riskClasses.join(', ')}`,
    `Hard blocks: ${hardBlocks.length} | Protected domains: ${protectedDomains.length}`,
    `Human-only: ${humanOnlyActions.join(', ')}`,
  ].join(' | ');
  return result;
}

function buildCheckMode(rootDir, actionText, options = {}) {
  const loaded = loadPolicy(rootDir, options);
  const commandCheck = checkForbiddenCommand(actionText);
  const policyCheck = loaded.ok ? checkPolicyHardBlock(actionText, loaded.policy) : { blocked: false, matched_blocks: [] };

  const forbidden = commandCheck.forbidden || policyCheck.blocked;
  const reasons = [
    ...commandCheck.violations.map((v) => v.description),
    ...policyCheck.matched_blocks,
  ];

  const result = buildOutput('check', {
    status: forbidden ? 'FAIL' : 'PASS',
    blocking_conditions: reasons,
    metadata: {
      action: actionText,
      forbidden,
      command_violations: commandCheck.violations,
      policy_blocks_matched: policyCheck.matched_blocks,
      verdict: forbidden ? 'FORBIDDEN' : 'PERMITTED',
    },
  });
  result.summary = `${AGENT} | check | "${actionText.slice(0, 60)}" → ${result.metadata.verdict}`;
  return result;
}

function buildClassifyMode(rootDir, taskText, options = {}) {
  const loaded = loadPolicy(rootDir, options);
  if (!loaded.ok) {
    const result = buildOutput('classify', {
      status: 'FAIL',
      blocking_conditions: [loaded.error],
      metadata: { task: taskText, risk: 'Unknown' },
    });
    result.summary = `${AGENT} | classify | FAIL — policy unavailable`;
    return result;
  }

  const classification = classifyTask(taskText, loaded.policy);
  const authorityRules = getAuthorityRules(classification.risk, loaded.policy);

  const result = buildOutput('classify', {
    status: 'PASS',
    metadata: {
      ...classification,
      authority_rules: authorityRules,
    },
  });
  result.summary = `${AGENT} | classify | "${taskText.slice(0, 60)}" → ${classification.risk} / ${classification.domain}`;
  return result;
}

function buildAuthorityMode(rootDir, riskClass, options = {}) {
  const loaded = loadPolicy(rootDir, options);
  if (!loaded.ok) {
    const result = buildOutput('authority', {
      status: 'FAIL',
      blocking_conditions: [loaded.error],
      metadata: { risk_class: riskClass },
    });
    result.summary = `${AGENT} | authority | FAIL — policy unavailable`;
    return result;
  }

  if (!riskClass) {
    const result = buildOutput('authority', {
      status: 'FAIL',
      blocking_conditions: ['Missing required --risk argument'],
      metadata: { risk_class: '' },
    });
    result.summary = `${AGENT} | authority | FAIL — missing --risk`;
    return result;
  }

  const rules = getAuthorityRules(riskClass, loaded.policy);
  if (!rules) {
    const result = buildOutput('authority', {
      status: 'FAIL',
      blocking_conditions: [`Unknown risk class: "${riskClass}"`],
      metadata: { risk_class: riskClass },
    });
    result.summary = `${AGENT} | authority | FAIL — unknown risk class`;
    return result;
  }

  const result = buildOutput('authority', {
    status: 'PASS',
    metadata: rules,
  });
  result.summary = [
    `${AGENT} | authority | ${riskClass}`,
    `Auto stage/commit: ${rules.can_auto_stage.join(', ') || 'none'}`,
    `Human required for: ${rules.human_required_for.join(', ')}`,
  ].join(' | ');
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

  if (parsed.mode === 'check') return buildCheckMode(rootDir, parsed.options.action || '', options);
  if (parsed.mode === 'classify') return buildClassifyMode(rootDir, parsed.options.task || '', options);
  if (parsed.mode === 'authority') return buildAuthorityMode(rootDir, parsed.options.risk || '', options);
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  FORBIDDEN_COMMAND_PATTERNS,
  buildAuthorityMode,
  buildCheckMode,
  buildClassifyMode,
  buildOutput,
  buildStatusMode,
  canActAutonomously,
  checkForbiddenCommand,
  checkPolicyHardBlock,
  classifyTask,
  formatOutput,
  getAuthorityRules,
  loadPolicy,
  main,
  normalizePath,
  parseArgs,
  requiresHumanApproval,
  unique,
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
