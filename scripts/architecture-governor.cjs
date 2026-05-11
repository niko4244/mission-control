#!/usr/bin/env node
/**
 * architecture-governor.cjs
 * Architecture drift review and import boundary guardrails.
 *
 * OBSERVE ONLY / ARCHITECTURE GUARDIAN
 * Reviews proposed changes for architectural concerns.
 * Approves/rejects architecture-adjacent plans.
 * Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status            — Agent identity, supervised bots, observe-only guarantee
 *   review --task "…" — Review architectural concerns in a proposed task
 *   check-boundaries --files '["path1","path2"]' — Check import boundary compliance
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architecture Governor v1';
const LABEL = 'OBSERVE ONLY / ARCHITECTURE GUARDIAN';
const BOT_ID = 'architecture-governor';
const AUTHORITY_LEVEL = 3;
const VALID_MODES = new Set(['status', 'review', 'check-boundaries']);

const ALWAYS_HUMAN_REQUIRED = ['push', 'create_pr', 'merge'];

const SUPERVISED_BOTS = ['architecture-critic', 'route-family-migrator'];

const ARCHITECTURE_KEYWORDS = [
  'architecture',
  'import',
  'boundary',
  'refactor',
  'rewrite',
  'module',
  'abstraction',
  'coupling',
  'dependency',
  'migration',
  'route',
  'api route',
  'folder structure',
  'directory structure',
  'layer',
];

const HIGH_RISK_PATTERNS = [
  'full rewrite',
  'broad rewrite',
  'rewrite all',
  'restructure all',
  'move all',
  'refactor all',
  'cross-boundary',
  'cross boundary',
];

// Import boundary rules
const BOUNDARY_RULES = [
  {
    id: 'app-no-scripts',
    description: 'src/app/ should not import from scripts/',
    pattern: /^src\/app\//,
    forbidden: /from ['"].*scripts\//,
    severity: 'high',
  },
  {
    id: 'components-no-api',
    description: 'src/components/ should not import directly from src/app/api/',
    pattern: /^src\/components\//,
    forbidden: /from ['"].*src\/app\/api\//,
    severity: 'medium',
  },
  {
    id: 'scripts-no-src',
    description: 'scripts/ should not import from src/',
    pattern: /^scripts\//,
    forbidden: /require\(['"].*\/src\/|from ['"].*\/src\//,
    severity: 'high',
  },
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const rawMode = String(args[0] || '').toLowerCase().replace(/^--/, '');
  const mode = VALID_MODES.has(rawMode) ? args.shift().toLowerCase().replace(/^--/, '') : 'status';
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { mode, options };
}

function loadBotSystemApi(rootDir) {
  const botSystemPath = path.join(rootDir, 'scripts', 'mission-control-bot-system.cjs');
  if (!fs.existsSync(botSystemPath)) {
    return { available: false, error: 'mission-control-bot-system.cjs not found' };
  }
  try {
    return { available: true, api: require(botSystemPath) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function classifyTask(taskText) {
  const lower = String(taskText || '').toLowerCase();

  const hasHighRisk = HIGH_RISK_PATTERNS.some((p) => lower.includes(p));
  const hasArchKeyword = ARCHITECTURE_KEYWORDS.some((k) => lower.includes(k));

  const architectureConcerns = [];
  if (lower.includes('rewrite') || lower.includes('restructure')) {
    architectureConcerns.push('Potential broad scope rewrite detected');
  }
  if (lower.includes('import') || lower.includes('boundary')) {
    architectureConcerns.push('Import boundary change may affect module isolation');
  }
  if (lower.includes('refactor') && (lower.includes('all') || lower.includes('entire'))) {
    architectureConcerns.push('Broad refactor scope requires architecture review');
  }
  if (lower.includes('dependency') || lower.includes('coupling')) {
    architectureConcerns.push('Dependency/coupling changes may introduce drift');
  }
  if (lower.includes('abstraction') || lower.includes('layer')) {
    architectureConcerns.push('Abstraction layer changes need boundary validation');
  }

  // Domain classification
  let domain = 'general';
  if (lower.includes('architecture') || lower.includes('boundary') || lower.includes('import')) {
    domain = 'architecture';
  } else if (lower.includes('route') || lower.includes('api')) {
    domain = 'routing';
  } else if (lower.includes('refactor') || lower.includes('rewrite')) {
    domain = 'refactoring';
  } else if (lower.includes('doc') || lower.includes('readme') || lower.includes('typo')) {
    domain = 'documentation';
  } else if (lower.includes('test') || lower.includes('spec')) {
    domain = 'testing';
  }

  // Risk level
  let riskLevel = 'Low';
  if (hasHighRisk) {
    riskLevel = 'High';
  } else if (hasArchKeyword) {
    riskLevel = 'Medium';
  } else if (domain === 'documentation' || lower.includes('typo')) {
    riskLevel = 'Docs';
  }

  const approved = !hasHighRisk;
  let decision;
  if (!approved) {
    decision = 'REQUEST_CORRECTIONS';
  } else if (architectureConcerns.length > 0) {
    decision = 'APPROVE_WITH_NOTES';
  } else {
    decision = 'APPROVE';
  }

  const requiresArchitectureCritic = lower.includes('boundary') || lower.includes('import') || lower.includes('migration');

  return {
    domain,
    risk_level: riskLevel,
    architecture_concerns: architectureConcerns,
    approved,
    decision,
    requires_architecture_critic: requiresArchitectureCritic,
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
  };
}

function checkBoundaries(files, rootDir) {
  const fileList = Array.isArray(files) ? files : [];
  const violations = [];

  for (const rawFile of fileList) {
    const filePath = normalizePath(rawFile);
    const absolutePath = path.isAbsolute(rawFile)
      ? rawFile
      : path.join(rootDir, rawFile);

    let content = '';
    try {
      if (fs.existsSync(absolutePath)) {
        content = fs.readFileSync(absolutePath, 'utf8');
      }
    } catch {
      // Cannot read file — skip content check, only check path rules
    }

    for (const rule of BOUNDARY_RULES) {
      if (!rule.pattern.test(filePath)) continue;
      if (content && rule.forbidden.test(content)) {
        violations.push({
          file: filePath,
          rule: rule.id,
          severity: rule.severity,
          description: rule.description,
        });
      }
    }
  }

  return {
    boundaries_ok: violations.length === 0,
    violations,
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    bot_id: BOT_ID,
    authority_level: AUTHORITY_LEVEL,
    mode,
    ...data,
  };
}

function buildStatusMode(rootDir, options = {}) {
  const botSystemState = loadBotSystemApi(rootDir);
  let selfView = null;

  if (botSystemState.available) {
    try {
      const sharedState = botSystemState.api.buildSharedState(rootDir, options);
      selfView = botSystemState.api.getAuthorityView(BOT_ID, sharedState.registry, sharedState.policy);
    } catch {
      selfView = null;
    }
  }

  return buildOutput('status', {
    status: 'PASS',
    observe_only: true,
    observe_only_guarantee: 'Architecture Governor never mutates files, git state, or remote systems.',
    supervised_bots: SUPERVISED_BOTS,
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
    reports_to: 'chief-arbiter',
    self_view: selfView,
    summary: `${AGENT} (${LABEL}) — observe-only. Supervises: ${SUPERVISED_BOTS.join(', ')}.`,
  });
}

function buildReviewMode(rootDir, taskText, options = {}) {
  if (!taskText) {
    return buildOutput('review', {
      status: 'FAIL',
      error: 'Missing required --task value',
      human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
    });
  }

  // Optionally use bot-system routing for domain classification
  let botSystemRouting = null;
  const botSystemState = loadBotSystemApi(rootDir);
  if (botSystemState.available) {
    try {
      const policy = botSystemState.api.loadPolicy(rootDir);
      if (policy) {
        botSystemRouting = botSystemState.api.buildRoutingDecision(taskText, policy);
      }
    } catch {
      botSystemRouting = null;
    }
  }

  const classification = classifyTask(taskText);
  const domain = botSystemRouting ? botSystemRouting.domain : classification.domain;
  const risk_level = botSystemRouting ? botSystemRouting.risk : classification.risk_level;

  return buildOutput('review', {
    status: classification.approved ? 'PASS' : 'WARN',
    task: taskText,
    domain,
    risk_level,
    architecture_concerns: classification.architecture_concerns,
    approved: classification.approved,
    decision: classification.decision,
    requires_architecture_critic: classification.requires_architecture_critic,
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
    summary: `${AGENT}: ${classification.decision} (risk=${risk_level}, domain=${domain})`,
  });
}

function buildCheckBoundariesMode(rootDir, filesArg, options = {}) {
  let files = [];
  if (filesArg) {
    try {
      files = JSON.parse(filesArg);
    } catch {
      return buildOutput('check-boundaries', {
        status: 'FAIL',
        error: 'Invalid --files argument: must be a JSON array of file paths',
        boundaries_ok: false,
        violations: [],
      });
    }
  }

  const result = checkBoundaries(files, rootDir);

  return buildOutput('check-boundaries', {
    status: result.boundaries_ok ? 'PASS' : 'WARN',
    boundaries_ok: result.boundaries_ok,
    violations: result.violations,
    files_checked: files.map(normalizePath),
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
    summary: result.boundaries_ok
      ? 'All checked files respect import boundaries.'
      : `${result.violations.length} boundary violation(s) detected.`,
  });
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'review') {
    return buildReviewMode(rootDir, parsed.options.task || '', options);
  }
  if (parsed.mode === 'check-boundaries') {
    return buildCheckBoundariesMode(rootDir, parsed.options.files || null, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  ALWAYS_HUMAN_REQUIRED,
  SUPERVISED_BOTS,
  BOUNDARY_RULES,
  buildOutput,
  buildStatusMode,
  buildReviewMode,
  buildCheckBoundariesMode,
  checkBoundaries,
  classifyTask,
  main,
  normalizePath,
  parseArgs,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'status',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
