#!/usr/bin/env node
/**
 * bot-registry-inspector.cjs
 * Bot registry consistency auditor for Mission Control.
 *
 * Observe-only. Audits bot registry for consistency. Checks that every
 * implemented bot has a script, every script is in the registry, supervision
 * chains are valid, authority claims match policy, and deferred bots have
 * deferred_reason fields.
 *
 * Modes:
 *   status  — Agent identity
 *   inspect — Full consistency audit
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Bot Registry Inspector v1';
const LABEL = 'OBSERVE ONLY / REGISTRY CONSISTENCY AUDITOR';
const BOT_ID = 'bot-registry-inspector';
const VALID_MODES = new Set(['status', 'inspect']);

const GOVERNANCE_PATTERNS = [
  'governor',
  'arbiter',
  'executor',
  'steward',
  'runner',
  'sentinel',
  'inspector',
  'curator',
  'migrator',
  'manager',
  'compiler',
  'engine',
  'lifecycle',
  'intake',
  'journal',
  'middleware',
  'schema',
  'filter',
  'checker',
  'classifier',
  'protocol',
  'reconciler',
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isGovernanceScript(name) {
  const stem = name.replace(/\.cjs$/, '').toLowerCase();
  return GOVERNANCE_PATTERNS.some((kw) => stem.includes(kw));
}

function loadBotSystem(rootDir) {
  const scriptPath = path.join(rootDir, 'scripts', 'mission-control-bot-system.cjs');
  if (!fileExists(scriptPath)) {
    return { available: false, error: 'mission-control-bot-system.cjs not found' };
  }
  try {
    return { available: true, api: require(scriptPath) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
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
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      observe_only: true,
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: status\nStatus: PASS`;
  return result;
}

function inspectRegistry(rootDir, options = {}) {
  const violations = [];
  const warnings = [];
  const stats = {};

  const botSystemState = loadBotSystem(rootDir);
  if (!botSystemState.available) {
    return {
      consistent: false,
      violations: [`Cannot load mission-control-bot-system.cjs: ${botSystemState.error}`],
      warnings: [],
      stats: {},
    };
  }

  const { loadRegistry, loadPolicy, validateAuthorityClaims } = botSystemState.api;

  let registry = null;
  let policy = null;

  try {
    registry = loadRegistry(rootDir);
  } catch (err) {
    return {
      consistent: false,
      violations: [`Cannot load registry: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      stats: {},
    };
  }

  try {
    policy = loadPolicy(rootDir);
  } catch (err) {
    warnings.push(`Cannot load policy: ${err instanceof Error ? err.message : String(err)}`);
  }

  const bots = Array.isArray(registry && registry.bots) ? registry.bots : [];
  stats.total_bots = bots.length;
  stats.implemented_count = bots.filter((b) => b.status === 'implemented').length;
  stats.planned_count = bots.filter((b) => b.status === 'planned').length;
  stats.deferred_count = bots.filter((b) => b.status === 'deferred').length;

  const botIds = new Set(bots.map((b) => b.id));

  // 1. script_exists: every bot with status=implemented and implementation_type=script has a real file
  const scriptBots = bots.filter(
    (b) => b.status === 'implemented' && b.implementation_type === 'script',
  );
  for (const bot of scriptBots) {
    const scriptPath = bot.implementation_script;
    if (!scriptPath) {
      violations.push(`${bot.id}: status=implemented, implementation_type=script, but no implementation_script field`);
      continue;
    }
    const absolutePath = path.join(rootDir, scriptPath);
    if (!fileExists(absolutePath)) {
      violations.push(`${bot.id}: implementation_script "${scriptPath}" does not exist on disk`);
    }
  }
  stats.script_bots_checked = scriptBots.length;

  // 2. script_registered: every governance .cjs in scripts/ is in the registry or noted as unregistered
  const scriptsDir = path.join(rootDir, 'scripts');
  let scriptFiles = [];
  try {
    if (fileExists(scriptsDir)) {
      scriptFiles = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
    }
  } catch {
    scriptFiles = [];
  }

  const governanceScripts = scriptFiles.filter(isGovernanceScript);
  const registeredScripts = new Set(
    bots
      .filter((b) => b.implementation_script)
      .map((b) => normalizePath(b.implementation_script)),
  );

  const unregisteredScripts = [];
  for (const scriptName of governanceScripts) {
    const scriptPath = normalizePath(`scripts/${scriptName}`);
    if (!registeredScripts.has(scriptPath)) {
      unregisteredScripts.push(scriptPath);
      warnings.push(`Governance script not in registry: ${scriptPath}`);
    }
  }
  stats.governance_scripts_on_disk = governanceScripts.length;
  stats.unregistered_scripts = unregisteredScripts.length;

  // 3. supervision_chains: every bot's reports_to exists, supervises only real bots
  for (const bot of bots) {
    if (bot.reports_to && !botIds.has(bot.reports_to)) {
      violations.push(`${bot.id}: reports_to "${bot.reports_to}" which does not exist in registry`);
    }
    if (Array.isArray(bot.supervises)) {
      for (const childId of bot.supervises) {
        if (!botIds.has(childId)) {
          violations.push(`${bot.id}: supervises "${childId}" which does not exist in registry`);
        }
      }
    }
  }

  // 4. authority_claims: call validateAuthorityClaims
  if (policy) {
    try {
      const claimViolations = validateAuthorityClaims(registry, policy);
      for (const v of claimViolations) {
        violations.push(`${v.bot_id}: authority claim violation — ${v.issue}`);
      }
      stats.authority_claim_violations = claimViolations.length;
    } catch (err) {
      warnings.push(`validateAuthorityClaims error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    warnings.push('Policy not loaded — authority claims not validated');
    stats.authority_claim_violations = 0;
  }

  // 5. deferred_valid: every deferred bot has a deferred_reason field
  const deferredBots = bots.filter((b) => b.status === 'deferred');
  for (const bot of deferredBots) {
    if (!bot.deferred_reason) {
      violations.push(`${bot.id}: status=deferred but has no deferred_reason field`);
    }
  }

  // 6. planned_count
  stats.planned_remaining = bots.filter((b) => b.status === 'planned').length;

  const consistent = violations.length === 0;

  return {
    consistent,
    violations: unique(violations),
    warnings: unique(warnings),
    stats,
  };
}

function buildInspectMode(rootDir, options = {}) {
  const inspectResult = inspectRegistry(rootDir, options);

  const result = buildOutput('inspect', {
    status: !inspectResult.consistent ? 'FAIL' : inspectResult.warnings.length > 0 ? 'WARN' : 'PASS',
    warnings: inspectResult.warnings,
    blocking_conditions: inspectResult.violations,
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      consistent: inspectResult.consistent,
      violations: inspectResult.violations,
      warnings: inspectResult.warnings,
      stats: inspectResult.stats,
      observe_only: true,
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: inspect\nStatus: ${result.status}\nViolations: ${inspectResult.violations.length}\nWarnings: ${inspectResult.warnings.length}`;
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

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const mergedOptions = Object.assign({}, options, parsed.options);

  if (parsed.mode === 'inspect') {
    return buildInspectMode(rootDir, mergedOptions);
  }
  return buildStatusMode(rootDir, mergedOptions);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  GOVERNANCE_PATTERNS,
  buildInspectMode,
  buildOutput,
  buildStatusMode,
  fileExists,
  inspectRegistry,
  isGovernanceScript,
  loadBotSystem,
  main,
  normalizePath,
  parseArgs,
  unique,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
