#!/usr/bin/env node
/**
 * mission-control-bot-system.cjs
 * Observe-only operating system view over Mission Control's multi-bot hierarchy.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Mission Control Bot System v1';
const LABEL = 'BOT OPERATING SYSTEM / OBSERVE ONLY';
const VALID_MODES = new Set(['status', 'registry', 'policy', 'route', 'authority']);
const REGISTRY_FILE = path.join('config', 'mission-control-bot-registry.json');
const POLICY_FILE = path.join('config', 'mission-control-policy.json');
const PERMISSION_FIELDS = [
  'may_mutate',
  'may_stage',
  'may_commit',
  'may_push',
  'may_create_pr',
  'may_merge',
  'may_authorize',
  'may_reject',
  'may_request_corrections',
];
const RISK_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs', 'TestOnly'];
const SCRIPT_ALIASES = {
  'mission-control-bot-system.cjs': 'task-router',
  'security-hardening-runner.cjs': 'security-hardening-runner',
  'security-governor.cjs': 'security-governor',
  'security-arbiter.cjs': 'security-arbiter',
  'security-executor.cjs': 'security-executor',
  'release-governor.cjs': 'release-governor',
  'release-manager.cjs': 'release-manager',
  'merge-steward.cjs': 'merge-steward',
  'ci-sentinel.cjs': 'ci-sentinel',
  'architecture-governor.cjs': 'architecture-governor',
  'architecture-critic.cjs': 'architecture-critic',
  'test-coverage-auditor.cjs': 'test-coverage-auditor',
  'route-family-migrator.cjs': 'route-family-migrator',
  'correction-loop-manager.cjs': 'correction-loop-manager',
  'lessons-curator.cjs': 'lessons-curator',
  'prompt-compiler.cjs': 'prompt-compiler',
  'operator-dashboard-bot.cjs': 'operator-dashboard-bot',
  'bot-registry-inspector.cjs': 'bot-registry-inspector',
  'documentation-governor.cjs': 'documentation-governor',
  'documentation-executor.cjs': 'documentation-executor',
  'appliance-knowledge-governor.cjs': 'appliance-knowledge-governor',
  'local-model-provider-governor.cjs': 'local-model-provider-governor',
  'ui-dashboard-governor.cjs': 'ui-dashboard-governor',
  'chief-arbiter.cjs': 'chief-arbiter',
};
const CRITICAL_KEYWORDS = [
  'auth',
  'token',
  'tokens',
  'key',
  'keys',
  'gateway',
  'gateways',
  'terminal',
  'exec',
  'approval',
  'approvals',
  'run ',
  ' runs',
  'workspace fallback',
  'workspace enforcement',
  'schema',
  'database',
  'lockfile',
  'package drift',
  'package.json',
];
const HIGH_KEYWORDS = [
  'release',
  'merge',
  'pull request',
  'pr ',
  'deploy',
  'delivery',
  'workflow',
  'pipeline',
  'architecture drift',
];
const TOOLING_KEYWORDS = [
  'tooling',
  'script',
  'scripts',
  'lint',
  'typecheck',
  'build',
  'vitest',
  'test harness',
  'config',
];
const DOC_KEYWORDS = ['docs', 'documentation', 'readme', 'typo', 'guide'];
const TEST_ONLY_KEYWORDS = ['test only', 'test-only', 'spec only', 'coverage only'];
const NEXT_BOT_PRIORITY = [
  'release-governor',
  'release-manager',
  'ci-sentinel',
  'merge-steward',
  'architecture-governor',
  'lessons-curator',
  'operator-dashboard-bot',
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadRegistry(rootDir) {
  return readJsonFile(path.join(rootDir, REGISTRY_FILE));
}

function loadPolicy(rootDir) {
  return readJsonFile(path.join(rootDir, POLICY_FILE));
}

function buildRegistryIndex(registry) {
  const bots = Array.isArray(registry && registry.bots) ? registry.bots : [];
  const byId = new Map();

  for (const bot of bots) {
    byId.set(bot.id, bot);
  }

  return {
    bots,
    byId,
  };
}

function authorityLabelForLevel(policy, level) {
  const rule = policy
    && policy.authority_rules
    && policy.authority_rules.levels
    && policy.authority_rules.levels[String(level)];

  return rule ? rule.label : 'unknown';
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const nextValue = args[index + 1];
    if (nextValue && !nextValue.startsWith('--')) {
      options[key] = nextValue;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return {
    mode,
    options,
  };
}

function listObservedBotScripts(rootDir, options = {}) {
  if (Array.isArray(options.observedScriptFiles) && options.observedScriptFiles.length > 0) {
    return unique(options.observedScriptFiles.map(normalizePath));
  }

  const scriptsDir = path.join(rootDir, 'scripts');
  if (!fs.existsSync(scriptsDir)) return [];

  return fs.readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cjs'))
    .map((entry) => normalizePath(path.join('scripts', entry.name)));
}

function inferBotIdFromScript(scriptPath, registryIndex) {
  const normalized = normalizePath(scriptPath);
  const basename = path.posix.basename(normalized);

  if (SCRIPT_ALIASES[basename]) {
    return SCRIPT_ALIASES[basename];
  }

  for (const bot of registryIndex.bots) {
    if (normalizePath(bot.implementation_script) === normalized) {
      return bot.id;
    }
  }

  return '';
}

function detectImplementedBots(rootDir, registry, options = {}) {
  const registryIndex = buildRegistryIndex(registry);
  const observedScripts = listObservedBotScripts(rootDir, options);
  const implemented = [];
  const unregisteredImplementedScripts = [];

  for (const scriptPath of observedScripts) {
    const botId = inferBotIdFromScript(scriptPath, registryIndex);
    if (!botId) continue;
    if (!registryIndex.byId.has(botId)) {
      unregisteredImplementedScripts.push({
        script: scriptPath,
        inferred_bot_id: botId,
      });
      continue;
    }
    implemented.push(botId);
  }

  const implementedIds = unique(implemented).sort();
  const nonScriptImplementations = registryIndex.bots
    .filter((bot) => bot.status === 'implemented' && bot.implementation_type !== 'script')
    .map((bot) => bot.id)
    .sort();
  const missingImplementedScripts = registryIndex.bots
    .filter((bot) => bot.status === 'implemented' && bot.implementation_type === 'script')
    .filter((bot) => !implementedIds.includes(bot.id))
    .map((bot) => bot.id)
    .sort();
  const missingPlannedBots = registryIndex.bots
    .filter((bot) => bot.implementation_type === 'script')
    .filter((bot) => bot.status !== 'implemented')
    .filter((bot) => !implementedIds.includes(bot.id))
    .map((bot) => bot.id)
    .sort();

  return {
    observed_scripts: observedScripts,
    implemented: implementedIds,
    non_script_implementations: nonScriptImplementations,
    missing_implemented_scripts: missingImplementedScripts,
    missing_planned_bots: missingPlannedBots,
    unregistered_implemented_scripts: unique(
      unregisteredImplementedScripts.map((item) => `${item.inferred_bot_id}:${item.script}`)
    ).map((value) => {
      const separator = value.indexOf(':');
      return {
        inferred_bot_id: value.slice(0, separator),
        script: value.slice(separator + 1),
      };
    }),
  };
}

function validateRequiredCoreBots(registry, policy) {
  const registryIndex = buildRegistryIndex(registry);
  const required = Array.isArray(policy && policy.required_core_bots) ? policy.required_core_bots : [];
  return required.filter((id) => !registryIndex.byId.has(id));
}

function validateHierarchy(registry, policy) {
  const registryIndex = buildRegistryIndex(registry);
  const warnings = [];
  const visiting = new Set();
  const visited = new Set();

  for (const bot of registryIndex.bots) {
    if (bot.reports_to) {
      const parent = registryIndex.byId.get(bot.reports_to);
      if (!parent) {
        warnings.push(`${bot.id} reports_to unknown bot ${bot.reports_to}`);
      } else if (typeof bot.authority_level === 'number' && typeof parent.authority_level === 'number' && bot.authority_level < parent.authority_level) {
        warnings.push(`${bot.id} outranks its reported parent ${parent.id}`);
      }
    }

    if (bot.reports_to === bot.id) {
      warnings.push(`${bot.id} reports to itself`);
    }

    for (const childId of bot.supervises || []) {
      const child = registryIndex.byId.get(childId);
      if (!child) {
        warnings.push(`${bot.id} supervises unknown bot ${childId}`);
        continue;
      }
      if (child.reports_to !== bot.id) {
        warnings.push(`${bot.id} supervises ${childId} but ${childId} reports_to ${child.reports_to || 'nobody'}`);
      }
      if (typeof bot.authority_level === 'number' && typeof child.authority_level === 'number' && child.authority_level < bot.authority_level) {
        warnings.push(`${childId} outranks supervisor ${bot.id}`);
      }
    }
  }

  function walk(botId) {
    if (visiting.has(botId)) {
      warnings.push(`Hierarchy cycle detected at ${botId}`);
      return;
    }
    if (visited.has(botId)) return;

    visiting.add(botId);
    visited.add(botId);
    const bot = registryIndex.byId.get(botId);
    if (bot && bot.reports_to) {
      walk(bot.reports_to);
    }
    visiting.delete(botId);
  }

  for (const bot of registryIndex.bots) {
    walk(bot.id);
  }

  const levels = Array.isArray(policy && policy.authority_rules && policy.authority_rules.levels)
    ? policy.authority_rules.levels
    : policy && policy.authority_rules && policy.authority_rules.levels;
  if (!levels) {
    warnings.push('Policy authority_rules.levels missing');
  }

  return unique(warnings);
}

function validateAuthorityClaims(registry, policy) {
  const violations = [];
  const registryIndex = buildRegistryIndex(registry);
  const levelRules = policy && policy.authority_rules && policy.authority_rules.levels
    ? policy.authority_rules.levels
    : {};
  const humanOnlyActions = unique(policy && policy.authority_rules ? policy.authority_rules.human_only_actions : []);

  for (const bot of registryIndex.bots) {
    const rule = levelRules[String(bot.authority_level)];
    if (!rule) {
      violations.push({
        bot_id: bot.id,
        issue: `No authority rule defined for level ${bot.authority_level}`,
      });
      continue;
    }

    for (const field of PERMISSION_FIELDS) {
      if (bot[field] === true && rule[field] !== true) {
        violations.push({
          bot_id: bot.id,
          issue: `${field} is not allowed for authority level ${bot.authority_level} (${rule.label})`,
        });
      }
    }

    if (humanOnlyActions.includes('merge') && bot.id !== 'human-owner' && bot.may_merge === true) {
      violations.push({
        bot_id: bot.id,
        issue: 'merge is human-only by policy',
      });
    }
  }

  return violations;
}

function buildHierarchyChains(registry, rootId = 'human-owner') {
  const registryIndex = buildRegistryIndex(registry);

  function descend(botId, stack, chains) {
    const bot = registryIndex.byId.get(botId);
    if (!bot) return;
    const nextStack = stack.concat(botId);
    const children = Array.isArray(bot.supervises) ? bot.supervises.filter((childId) => registryIndex.byId.has(childId)) : [];

    if (children.length === 0) {
      chains.push(nextStack);
      return;
    }

    for (const childId of children) {
      descend(childId, nextStack, chains);
    }
  }

  const chains = [];
  descend(rootId, [], chains);
  return chains;
}

function compareRisk(left, right) {
  return RISK_ORDER.indexOf(left) - RISK_ORDER.indexOf(right);
}

function keywordScore(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return (keywords || []).reduce((score, keyword) => (
    lower.includes(String(keyword).toLowerCase()) ? score + 1 : score
  ), 0);
}

function selectRoutingProfile(taskText, policy) {
  const profiles = Array.isArray(policy && policy.routing_profiles) ? policy.routing_profiles : [];
  const scored = profiles
    .map((profile) => ({
      profile,
      score: keywordScore(taskText, profile.keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareRisk(left.profile.default_risk, right.profile.default_risk));

  return scored[0] ? scored[0].profile : null;
}

function taskTouchesProtectedDomains(taskText, policy) {
  const protectedDomains = Array.isArray(policy && policy.protected_domains) ? policy.protected_domains : [];
  const lower = String(taskText || '').toLowerCase();

  return protectedDomains.filter((domain) => {
    const normalized = String(domain).toLowerCase();
    return lower.includes(normalized)
      || normalized.split(/[\/\s]+/).filter(Boolean).some((part) => lower.includes(part));
  });
}

function determineRisk(taskText, profile) {
  const lower = String(taskText || '').toLowerCase();

  if (TEST_ONLY_KEYWORDS.some((keyword) => lower.includes(keyword))) return 'TestOnly';
  if (DOC_KEYWORDS.some((keyword) => lower.includes(keyword)) && !CRITICAL_KEYWORDS.some((keyword) => lower.includes(keyword))) return 'Docs';
  if (TOOLING_KEYWORDS.some((keyword) => lower.includes(keyword)) && !CRITICAL_KEYWORDS.some((keyword) => lower.includes(keyword))) return 'Tooling';
  if (CRITICAL_KEYWORDS.some((keyword) => lower.includes(keyword))) return 'Critical';
  if (HIGH_KEYWORDS.some((keyword) => lower.includes(keyword))) return 'High';
  if (profile && profile.default_risk) return profile.default_risk;
  return 'Low';
}

function deriveDomain(taskText, profile) {
  const lower = String(taskText || '').toLowerCase();
  if (profile && profile.domain === 'security' && lower.includes('auth')) return 'security/auth';
  if (profile && profile.domain === 'security' && lower.includes('workspace')) return 'security/workspace';
  if (profile && profile.domain) return profile.domain;
  return 'general';
}

function relevantHardBlocks(taskText, policy) {
  const lower = String(taskText || '').toLowerCase();
  const blocks = Array.isArray(policy && policy.hard_blocks) ? policy.hard_blocks : [];

  return blocks.filter((block) => {
    const normalized = String(block).toLowerCase();
    if (normalized.includes('helper/auth/workspace enforcement') && (lower.includes('auth helper') || lower.includes('workspace enforcement'))) return true;
    if (normalized.includes('schema/database') && (lower.includes('schema') || lower.includes('database'))) return true;
    if (normalized.includes('lockfile') && lower.includes('lockfile')) return true;
    if (normalized.includes('package drift') && lower.includes('package')) return true;
    if (normalized.includes('fallback regression') && lower.includes('workspace fallback')) return true;
    if (normalized.includes('client-supplied workspace id') && lower.includes('workspace')) return true;
    if (normalized.includes('merge without human approval') && lower.includes('merge')) return true;
    return false;
  });
}

function buildRoutingDecision(taskText, policy) {
  const profile = selectRoutingProfile(taskText, policy);
  const risk = determineRisk(taskText, profile);
  const domain = deriveDomain(taskText, profile);
  const approval = policy && policy.approval_matrix ? policy.approval_matrix[risk] : null;
  const protectedHits = taskTouchesProtectedDomains(taskText, policy);
  const lower = String(taskText || '').toLowerCase();
  const humanRequiredFor = unique(approval && approval.human_required_for ? approval.human_required_for : []);
  const blockedActions = [];
  const hardBlockHits = relevantHardBlocks(taskText, policy);

  if (!approval || !profile) {
    return {
      task: taskText,
      domain,
      risk,
      governor: profile ? profile.governor : 'chief-arbiter',
      runner: profile ? profile.runner : '',
      executor: profile ? profile.executor : '',
      arbiter: 'chief-arbiter',
      arbiter_required: true,
      human_required_for: humanRequiredFor,
      blocked_actions: hardBlockHits,
    };
  }

  if ((protectedHits.length > 0)
    || lower.includes('auth helper')
    || lower.includes('workspace enforcement')
    || lower.includes('schema')
    || lower.includes('database')
    || lower.includes('package file')
    || lower.includes('lockfile')) {
    blockedActions.push('autonomous stage');
    blockedActions.push('autonomous commit');
    humanRequiredFor.push('stage', 'commit');
  }

  if ((approval.can_auto_push || []).length === 0) blockedActions.push('push');
  if ((approval.can_auto_create_pr || []).length === 0) blockedActions.push('create_pr');
  if ((approval.can_auto_merge || []).length === 0) blockedActions.push('merge');
  blockedActions.push(...hardBlockHits);

  return {
    task: taskText,
    domain,
    risk,
    governor: profile.governor || '',
    runner: profile.runner || '',
    executor: profile.executor || '',
    arbiter: profile.domain === 'security' && risk === 'Critical'
      ? 'security-arbiter -> chief-arbiter'
      : (profile.arbiter || 'chief-arbiter'),
    arbiter_required: true,
    human_required_for: unique(humanRequiredFor),
    blocked_actions: unique(blockedActions),
  };
}

function describePermissionField(field) {
  return field.replace(/^may_/, '').replace(/_/g, ' ');
}

function getOverrideChain(botId, registryIndex) {
  const overrides = [];
  const seen = new Set();
  let current = registryIndex.byId.get(botId);

  while (current && current.reports_to && !seen.has(current.reports_to)) {
    seen.add(current.reports_to);
    overrides.push(current.reports_to);
    current = registryIndex.byId.get(current.reports_to);
  }

  return overrides;
}

function getAuthorityView(botId, registry, policy) {
  const registryIndex = buildRegistryIndex(registry);
  const bot = registryIndex.byId.get(botId);

  if (!bot) {
    return null;
  }

  const mayDo = PERMISSION_FIELDS.filter((field) => bot[field] === true).map(describePermissionField);
  const mayNotDo = PERMISSION_FIELDS.filter((field) => bot[field] !== true).map(describePermissionField);
  const overrideChain = getOverrideChain(botId, registryIndex);

  return {
    bot_id: bot.id,
    name: bot.name,
    status: bot.status,
    category: bot.category,
    authority_level: bot.authority_level,
    authority_label: authorityLabelForLevel(policy, bot.authority_level),
    may_do: mayDo,
    may_not_do: mayNotDo,
    reports_to: bot.reports_to,
    supervises: bot.supervises || [],
    override_chain: overrideChain,
    human_approval_required_for: bot.human_approval_required_for || [],
    allowed_domains: bot.allowed_domains || [],
    blocked_domains: bot.blocked_domains || [],
    notes: bot.notes || '',
  };
}

function recommendNextBot(registry, implementedIds) {
  const registryIndex = buildRegistryIndex(registry);
  for (const botId of NEXT_BOT_PRIORITY) {
    const bot = registryIndex.byId.get(botId);
    if (!bot) continue;
    if (!implementedIds.includes(botId)) {
      return botId;
    }
  }
  return '';
}

function buildBaseOutput(mode) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: 'PASS',
    registry: {
      loaded: false,
      bot_count: 0,
      implemented: [],
      planned: [],
      authority_levels: [],
    },
    policy: {
      loaded: false,
      risk_classes: [],
      hard_blocks: [],
      protected_domains: [],
    },
    hierarchy: {
      root: 'human-owner',
      chief_bot_authority: 'chief-arbiter',
      chains: [],
    },
    routing: {
      task: '',
      domain: '',
      risk: '',
      governor: '',
      runner: '',
      executor: '',
      arbiter_required: true,
      human_required_for: [],
    },
    warnings: [],
    blocking_conditions: [],
    summary: '',
  };
}

function buildSharedState(rootDir, options = {}) {
  const registry = loadRegistry(rootDir);
  const policy = loadPolicy(rootDir);
  const detection = detectImplementedBots(rootDir, registry, options);
  const requiredCoreMissing = validateRequiredCoreBots(registry, policy);
  const hierarchyWarnings = validateHierarchy(registry, policy);
  const claimViolations = validateAuthorityClaims(registry, policy);
  const authorityLevels = Object.entries(policy.authority_rules && policy.authority_rules.levels ? policy.authority_rules.levels : {})
    .map(([level, rule]) => ({
      level: Number(level),
      label: rule.label,
    }))
    .sort((left, right) => left.level - right.level);

  return {
    registry,
    policy,
    detection,
    requiredCoreMissing,
    hierarchyWarnings,
    claimViolations,
    authorityLevels,
  };
}

function summarizeStatus(result) {
  const implementedText = result.registry.implemented.length > 0 ? result.registry.implemented.join(', ') : 'none';
  const pendingText = result.registry.missing_planned && result.registry.missing_planned.length > 0
    ? result.registry.missing_planned.slice(0, 5).join(', ')
    : 'none';
  const nextBot = result.recommended_next_bot_pr || 'none';

  return [
    `${AGENT} (${LABEL})`,
    'Mode: status',
    `Status: ${result.status}`,
    `Implemented bot scripts: ${implementedText}`,
    `Pending planned bots: ${pendingText}`,
    `Recommended next bot/tooling PR: ${nextBot}`,
  ].join('\n');
}

function summarizeRegistry(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: registry',
    `Status: ${result.status}`,
    `Registry bot count: ${result.registry.bot_count}`,
    `Implemented bot scripts: ${result.registry.implemented.length}`,
  ].join('\n');
}

function summarizePolicy(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: policy',
    `Status: ${result.status}`,
    `Risk classes: ${result.policy.risk_classes.join(', ')}`,
    `Protected domains: ${result.policy.protected_domains.join(', ')}`,
  ].join('\n');
}

function summarizeRoute(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: route',
    `Status: ${result.status}`,
    `Task: ${result.routing.task}`,
    `Route: ${result.routing.domain} -> ${result.routing.governor || 'chief-arbiter'} -> ${result.routing.executor || 'no executor yet'}`,
  ].join('\n');
}

function summarizeAuthority(result) {
  return [
    `${AGENT} (${LABEL})`,
    'Mode: authority',
    `Status: ${result.status}`,
    result.authority_view
      ? `Bot: ${result.authority_view.bot_id} (${result.authority_view.authority_label})`
      : 'Bot: unknown',
    result.authority_view
      ? `Reports to: ${result.authority_view.reports_to || 'nobody'}`
      : 'Reports to: unknown',
  ].join('\n');
}

function buildStatusMode(rootDir, options = {}) {
  const shared = buildSharedState(rootDir, options);
  const result = buildBaseOutput('status');
  const nextBot = recommendNextBot(shared.registry, shared.detection.implemented);
  const warnings = [];
  const blocking = [];

  warnings.push(...shared.hierarchyWarnings);
  if (shared.detection.missing_planned_bots.length > 0) {
    warnings.push(`Planned bots not yet implemented: ${shared.detection.missing_planned_bots.join(', ')}`);
  }
  if (shared.detection.missing_implemented_scripts.length > 0) {
    warnings.push(`Implemented registry bots missing scripts: ${shared.detection.missing_implemented_scripts.join(', ')}`);
  }

  if (shared.requiredCoreMissing.length > 0) {
    blocking.push(`Registry missing required core bots: ${shared.requiredCoreMissing.join(', ')}`);
  }
  if (shared.claimViolations.length > 0) {
    blocking.push(`Implemented bot claims disallowed authority: ${shared.claimViolations.map((entry) => `${entry.bot_id} -> ${entry.issue}`).join('; ')}`);
  }
  if (shared.detection.unregistered_implemented_scripts.length > 0) {
    blocking.push(`Implemented bot scripts missing from registry: ${shared.detection.unregistered_implemented_scripts.map((entry) => `${entry.inferred_bot_id} (${entry.script})`).join(', ')}`);
  }

  result.registry = {
    loaded: true,
    bot_count: shared.registry.bots.length,
    implemented: shared.detection.implemented,
    planned: shared.registry.bots.filter((bot) => bot.status !== 'implemented').map((bot) => bot.id),
    missing_planned: shared.detection.missing_planned_bots,
    non_script_implementations: shared.detection.non_script_implementations,
    authority_levels: shared.authorityLevels,
  };
  result.policy = {
    loaded: true,
    risk_classes: shared.policy.risk_classes.map((item) => item.id),
    hard_blocks: shared.policy.hard_blocks,
    protected_domains: shared.policy.protected_domains,
  };
  result.hierarchy = {
    root: 'human-owner',
    chief_bot_authority: 'chief-arbiter',
    chains: buildHierarchyChains(shared.registry),
  };
  result.authority_review = {
    warnings: shared.hierarchyWarnings,
    claim_violations: shared.claimViolations,
  };
  result.recommended_next_bot_pr = nextBot;
  result.warnings = unique(warnings);
  result.blocking_conditions = unique(blocking);
  result.status = result.blocking_conditions.length > 0
    ? 'FAIL'
    : result.warnings.length > 0
      ? 'WARN'
      : 'PASS';
  result.summary = summarizeStatus(result);
  return result;
}

function buildRegistryMode(rootDir, options = {}) {
  const shared = buildSharedState(rootDir, options);
  const result = buildBaseOutput('registry');
  const rows = shared.registry.bots
    .slice()
    .sort((left, right) => left.authority_level - right.authority_level || left.id.localeCompare(right.id))
    .map((bot) => ({
      id: bot.id,
      authority_level: bot.authority_level,
      reports_to: bot.reports_to,
      may_mutate: bot.may_mutate,
      may_authorize: bot.may_authorize,
      may_create_pr: bot.may_create_pr,
      may_merge: bot.may_merge,
      status: bot.status,
    }));

  result.registry = {
    loaded: true,
    bot_count: shared.registry.bots.length,
    implemented: shared.detection.implemented,
    planned: shared.registry.bots.filter((bot) => bot.status !== 'implemented').map((bot) => bot.id),
    authority_levels: shared.authorityLevels,
    summary_rows: rows,
  };
  result.policy = {
    loaded: true,
    risk_classes: shared.policy.risk_classes.map((item) => item.id),
    hard_blocks: shared.policy.hard_blocks,
    protected_domains: shared.policy.protected_domains,
  };
  result.hierarchy = {
    root: 'human-owner',
    chief_bot_authority: 'chief-arbiter',
    chains: buildHierarchyChains(shared.registry),
  };
  result.warnings = unique([
    ...shared.hierarchyWarnings,
    ...(shared.detection.missing_planned_bots.length > 0 ? [`Planned bots pending scripts: ${shared.detection.missing_planned_bots.join(', ')}`] : []),
  ]);
  result.blocking_conditions = unique(shared.claimViolations.map((entry) => `${entry.bot_id} -> ${entry.issue}`));
  result.status = result.blocking_conditions.length > 0
    ? 'FAIL'
    : result.warnings.length > 0
      ? 'WARN'
      : 'PASS';
  result.summary = summarizeRegistry(result);
  return result;
}

function buildPolicyMode(rootDir, options = {}) {
  const shared = buildSharedState(rootDir, options);
  const result = buildBaseOutput('policy');

  result.registry = {
    loaded: true,
    bot_count: shared.registry.bots.length,
    implemented: shared.detection.implemented,
    planned: shared.registry.bots.filter((bot) => bot.status !== 'implemented').map((bot) => bot.id),
    authority_levels: shared.authorityLevels,
  };
  result.policy = {
    loaded: true,
    risk_classes: shared.policy.risk_classes.map((item) => item.id),
    hard_blocks: shared.policy.hard_blocks,
    protected_domains: shared.policy.protected_domains,
    approval_matrix: shared.policy.approval_matrix,
    required_validation: shared.policy.required_validation,
  };
  result.hierarchy = {
    root: 'human-owner',
    chief_bot_authority: 'chief-arbiter',
    chains: buildHierarchyChains(shared.registry),
  };
  result.warnings = unique(shared.hierarchyWarnings);
  result.blocking_conditions = unique(shared.claimViolations.map((entry) => `${entry.bot_id} -> ${entry.issue}`));
  result.status = result.blocking_conditions.length > 0
    ? 'FAIL'
    : result.warnings.length > 0
      ? 'WARN'
      : 'PASS';
  result.summary = summarizePolicy(result);
  return result;
}

function buildRouteMode(rootDir, taskText, options = {}) {
  const shared = buildSharedState(rootDir, options);
  const result = buildBaseOutput('route');

  if (!taskText) {
    result.status = 'FAIL';
    result.blocking_conditions = ['Missing required --task value'];
    result.summary = summarizeRoute(result);
    return result;
  }

  const routing = buildRoutingDecision(taskText, shared.policy);
  result.registry = {
    loaded: true,
    bot_count: shared.registry.bots.length,
    implemented: shared.detection.implemented,
    planned: shared.registry.bots.filter((bot) => bot.status !== 'implemented').map((bot) => bot.id),
    authority_levels: shared.authorityLevels,
  };
  result.policy = {
    loaded: true,
    risk_classes: shared.policy.risk_classes.map((item) => item.id),
    hard_blocks: shared.policy.hard_blocks,
    protected_domains: shared.policy.protected_domains,
  };
  result.hierarchy = {
    root: 'human-owner',
    chief_bot_authority: 'chief-arbiter',
    chains: buildHierarchyChains(shared.registry),
  };
  result.routing = routing;
  result.warnings = unique(shared.hierarchyWarnings);
  result.blocking_conditions = unique(routing.blocked_actions || []);
  result.status = shared.claimViolations.length > 0
    ? 'FAIL'
    : result.warnings.length > 0 || result.blocking_conditions.length > 0
      ? 'WARN'
      : 'PASS';
  result.summary = summarizeRoute(result);
  return result;
}

function buildAuthorityMode(rootDir, botId, options = {}) {
  const shared = buildSharedState(rootDir, options);
  const result = buildBaseOutput('authority');
  const authorityView = getAuthorityView(botId, shared.registry, shared.policy);

  result.registry = {
    loaded: true,
    bot_count: shared.registry.bots.length,
    implemented: shared.detection.implemented,
    planned: shared.registry.bots.filter((bot) => bot.status !== 'implemented').map((bot) => bot.id),
    authority_levels: shared.authorityLevels,
  };
  result.policy = {
    loaded: true,
    risk_classes: shared.policy.risk_classes.map((item) => item.id),
    hard_blocks: shared.policy.hard_blocks,
    protected_domains: shared.policy.protected_domains,
  };
  result.hierarchy = {
    root: 'human-owner',
    chief_bot_authority: 'chief-arbiter',
    chains: buildHierarchyChains(shared.registry),
  };

  if (!botId) {
    result.status = 'FAIL';
    result.blocking_conditions = ['Missing required --bot value'];
    result.summary = summarizeAuthority(result);
    return result;
  }

  if (!authorityView) {
    result.status = 'FAIL';
    result.blocking_conditions = [`Unknown bot id: ${botId}`];
    result.summary = summarizeAuthority(result);
    return result;
  }

  result.authority_view = authorityView;
  result.routing = {
    task: '',
    domain: authorityView.allowed_domains.join(', '),
    risk: '',
    governor: authorityView.reports_to || '',
    runner: '',
    executor: authorityView.bot_id,
    arbiter_required: true,
    human_required_for: authorityView.human_approval_required_for,
  };
  result.warnings = unique(shared.hierarchyWarnings);
  result.blocking_conditions = unique(shared.claimViolations
    .filter((entry) => entry.bot_id === authorityView.bot_id)
    .map((entry) => entry.issue));
  result.status = result.blocking_conditions.length > 0
    ? 'FAIL'
    : result.warnings.length > 0
      ? 'WARN'
      : 'PASS';
  result.summary = summarizeAuthority(result);
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'registry') {
    return buildRegistryMode(rootDir, options);
  }
  if (parsed.mode === 'policy') {
    return buildPolicyMode(rootDir, options);
  }
  if (parsed.mode === 'route') {
    return buildRouteMode(rootDir, parsed.options.task || '', options);
  }
  if (parsed.mode === 'authority') {
    return buildAuthorityMode(rootDir, parsed.options.bot || '', options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  SCRIPT_ALIASES,
  REGISTRY_FILE,
  POLICY_FILE,
  PERMISSION_FIELDS,
  RISK_ORDER,
  authorityLabelForLevel,
  buildAuthorityMode,
  buildBaseOutput,
  buildHierarchyChains,
  buildPolicyMode,
  buildRegistryIndex,
  buildRegistryMode,
  buildRouteMode,
  buildRoutingDecision,
  buildSharedState,
  buildStatusMode,
  compareRisk,
  detectImplementedBots,
  determineRisk,
  formatOutput,
  getAuthorityView,
  getOverrideChain,
  inferBotIdFromScript,
  keywordScore,
  listObservedBotScripts,
  loadPolicy,
  loadRegistry,
  main,
  normalizePath,
  parseArgs,
  readJsonFile,
  recommendNextBot,
  relevantHardBlocks,
  selectRoutingProfile,
  taskTouchesProtectedDomains,
  validateAuthorityClaims,
  validateHierarchy,
  validateRequiredCoreBots,
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
