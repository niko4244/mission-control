#!/usr/bin/env node
/**
 * task-lifecycle-engine.cjs
 * Observe-only lifecycle orchestrator for Mission Control autonomous tasks.
 * Tracks the full lifecycle: observe → classify → plan → approve → implement
 *   → validate → commit → pr → audit
 * Does NOT execute tasks — produces lifecycle state maps and next-step guidance.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const AGENT = 'Task Lifecycle Engine v1';
const LABEL = 'OBSERVE ONLY / LIFECYCLE ORCHESTRATOR';
const VALID_MODES = new Set(['status', 'advance', 'map']);

const LIFECYCLE_STAGES = [
  'observe',
  'classify',
  'plan',
  'approve',
  'implement',
  'validate',
  'commit',
  'pr',
  'audit',
];

const STAGE_DEFINITIONS = {
  observe: {
    stage: 'observe',
    description: 'Read-only analysis of the task and its context.',
    autonomous_safe: true,
    requires_human: false,
    required_authority: 'any',
  },
  classify: {
    stage: 'classify',
    description: 'Risk classification of the task — assigns a risk level and domain.',
    autonomous_safe: true,
    requires_human: false,
    required_authority: 'any',
  },
  plan: {
    stage: 'plan',
    description: 'Create an implementation plan. Requires chief-arbiter or domain governor approval for High/Critical.',
    autonomous_safe: false,
    requires_human: false,
    required_authority: 'chief-arbiter or domain-governor for High/Critical',
  },
  approve: {
    stage: 'approve',
    description: 'Explicit approval gate. Requires chief-arbiter for Critical/High.',
    autonomous_safe: false,
    requires_human: false,
    required_authority: 'chief-arbiter for Critical/High',
  },
  implement: {
    stage: 'implement',
    description: 'Make changes. Requires executor-class bot and an approved plan.',
    autonomous_safe: false,
    requires_human: false,
    required_authority: 'executor-class bot + approved plan',
  },
  validate: {
    stage: 'validate',
    description: 'Run tests and validation steps. All required validation steps must pass.',
    autonomous_safe: false,
    requires_human: false,
    required_authority: 'runner or executor',
  },
  commit: {
    stage: 'commit',
    description: 'Stage and commit changes. Requires no outstanding blockers.',
    autonomous_safe: false,
    requires_human: false,
    required_authority: 'executor-class bot',
  },
  pr: {
    stage: 'pr',
    description: 'Create pull request. ALWAYS requires human authorization.',
    autonomous_safe: false,
    requires_human: true,
    required_authority: 'human-owner',
  },
  audit: {
    stage: 'audit',
    description: 'Record decision in the execution journal. Always safe after commit.',
    autonomous_safe: true,
    requires_human: false,
    required_authority: 'any',
  },
};

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
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

function tryLoadPolicyEnforcement(rootDir) {
  try {
    const policyPath = path.join(rootDir, 'scripts', 'policy-enforcement-middleware.cjs');
    if (fs.existsSync(policyPath)) {
      return { module: require(policyPath), available: true, error: '' };
    }
    return { module: null, available: false, error: 'policy-enforcement-middleware.cjs not found' };
  } catch (err) {
    return { module: null, available: false, error: err && err.message ? err.message : String(err) };
  }
}

function resolveRiskLevel(taskText, botSystem) {
  if (!botSystem || !botSystem.module) return 'Low';
  try {
    return botSystem.module.determineRisk(taskText, null);
  } catch (_) {
    return 'Low';
  }
}

function determineRiskForTask(taskText) {
  const lower = String(taskText || '').toLowerCase();
  const criticalKw = ['auth', 'token', 'tokens', 'key', 'keys', 'gateway', 'gateways', 'terminal', 'exec', 'approval', 'approvals', 'schema', 'database', 'lockfile', 'package.json'];
  const highKw = ['release', 'merge', 'pull request', 'pr ', 'deploy', 'delivery', 'workflow', 'pipeline', 'architecture drift'];
  const toolingKw = ['tooling', 'script', 'scripts', 'lint', 'typecheck', 'build', 'vitest', 'test harness', 'config'];
  const docKw = ['docs', 'documentation', 'readme', 'typo', 'guide'];
  const testOnlyKw = ['test only', 'test-only', 'spec only', 'coverage only'];

  if (testOnlyKw.some((k) => lower.includes(k))) return 'TestOnly';
  if (docKw.some((k) => lower.includes(k)) && !criticalKw.some((k) => lower.includes(k))) return 'Docs';
  if (toolingKw.some((k) => lower.includes(k)) && !criticalKw.some((k) => lower.includes(k))) return 'Tooling';
  if (criticalKw.some((k) => lower.includes(k))) return 'Critical';
  if (highKw.some((k) => lower.includes(k))) return 'High';
  return 'Low';
}

function computeStageBlockers(stage, riskLevel, approvedBy) {
  const blockers = [];

  if (stage === 'plan') {
    if ((riskLevel === 'High' || riskLevel === 'Critical') && !approvedBy) {
      blockers.push('Requires chief-arbiter or domain-governor authorization before planning can proceed');
    }
  }

  if (stage === 'approve') {
    if (riskLevel === 'Critical' || riskLevel === 'High') {
      if (!approvedBy) {
        blockers.push('Requires explicit chief-arbiter approval');
      }
    }
  }

  if (stage === 'implement') {
    if (!approvedBy) {
      blockers.push('Requires approved plan before implementation');
    }
    if (riskLevel === 'Critical' || riskLevel === 'High') {
      blockers.push('Executor-class bot required; human-supervised for Critical/High tasks');
    }
  }

  if (stage === 'commit') {
    if (riskLevel === 'Critical' || riskLevel === 'High') {
      blockers.push('No outstanding blockers permitted — verify all validation steps passed');
    }
  }

  if (stage === 'pr') {
    blockers.push('Human authorization required — PR creation is always a human gate');
  }

  return blockers;
}

function buildStageEntry(stageName, status, riskLevel, approvedBy) {
  const def = STAGE_DEFINITIONS[stageName];
  const blockers = (status === 'current' || status === 'pending' || status === 'blocked' || status === 'requires_human')
    ? computeStageBlockers(stageName, riskLevel, approvedBy)
    : [];

  let finalStatus = status;
  if (status === 'pending' || status === 'current') {
    if (stageName === 'pr') {
      finalStatus = 'requires_human';
    } else if (blockers.length > 0) {
      finalStatus = 'blocked';
    }
  }

  return {
    stage: def.stage,
    status: finalStatus,
    requires_human: def.requires_human,
    required_authority: def.required_authority,
    autonomous_safe: def.autonomous_safe,
    description: def.description,
    blockers,
  };
}

function buildLifecycleMap(taskText, currentStageArg, approvedBy) {
  const riskLevel = determineRiskForTask(taskText);
  const currentStage = LIFECYCLE_STAGES.includes(currentStageArg) ? currentStageArg : 'observe';
  const currentIndex = LIFECYCLE_STAGES.indexOf(currentStage);

  return LIFECYCLE_STAGES.map((stageName, index) => {
    let status;
    if (index < currentIndex) {
      status = 'completed';
    } else if (index === currentIndex) {
      status = 'current';
    } else {
      status = 'pending';
    }

    return buildStageEntry(stageName, status, riskLevel, approvedBy);
  });
}

function computeNextStage(currentStage, lifecycleMap) {
  const currentIndex = LIFECYCLE_STAGES.indexOf(currentStage);
  if (currentIndex === -1 || currentIndex >= LIFECYCLE_STAGES.length - 1) {
    return null;
  }

  const nextEntry = lifecycleMap[currentIndex + 1];
  if (!nextEntry) return null;
  return nextEntry;
}

function buildNextActionString(nextEntry) {
  if (!nextEntry) return 'Lifecycle complete — proceed to audit.';
  if (nextEntry.requires_human) return `Next stage "${nextEntry.stage}" requires human authorization before proceeding.`;
  if (nextEntry.status === 'blocked') return `Next stage "${nextEntry.stage}" is blocked: ${nextEntry.blockers.join('; ')}`;
  return `Advance to stage "${nextEntry.stage}": ${nextEntry.description}`;
}

function buildStatusMode(rootDir) {
  const botSystem = tryLoadBotSystem(rootDir);
  const policyEnforcement = tryLoadPolicyEnforcement(rootDir);

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
      'policy-enforcement-middleware': {
        available: policyEnforcement.available,
        error: policyEnforcement.error,
      },
    },
    lifecycle_stages: LIFECYCLE_STAGES,
    blocked_actions: [
      'autonomous pr creation',
      'autonomous merge',
      'autonomous deploy',
      'autonomous release',
    ],
    summary: `${AGENT} (${LABEL}) — observe-only lifecycle orchestrator. Subsystems: bot-system=${botSystem.available ? 'available' : 'unavailable'}, policy-enforcement=${policyEnforcement.available ? 'available' : 'unavailable'}.`,
  };
}

function buildMapMode(taskText) {
  if (!taskText) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'map',
      status: 'FAIL',
      error: 'Missing required --task value',
      lifecycle_map: [],
      summary: `${AGENT}: map mode requires --task`,
    };
  }

  const riskLevel = determineRiskForTask(taskText);
  const lifecycleMap = buildLifecycleMap(taskText, 'observe', null);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'map',
    status: 'PASS',
    task: taskText,
    risk_level: riskLevel,
    lifecycle_map: lifecycleMap,
    current_stage: 'observe',
    next_stage: lifecycleMap[1] ? lifecycleMap[1].stage : null,
    next_action: buildNextActionString(lifecycleMap[1] || null),
    summary: `${AGENT}: lifecycle map for task (risk=${riskLevel}). ${LIFECYCLE_STAGES.length} stages defined. pr stage always requires_human.`,
  };
}

function buildAdvanceMode(taskText, currentStageArg, approvedBy) {
  if (!taskText) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'advance',
      status: 'FAIL',
      error: 'Missing required --task value',
      lifecycle_map: [],
      current_stage: null,
      next_stage: null,
      next_action: '',
      summary: `${AGENT}: advance mode requires --task`,
    };
  }

  if (!currentStageArg || !LIFECYCLE_STAGES.includes(currentStageArg)) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'advance',
      status: 'FAIL',
      error: `Invalid or missing --current-stage. Valid stages: ${LIFECYCLE_STAGES.join(', ')}`,
      lifecycle_map: [],
      current_stage: currentStageArg || null,
      next_stage: null,
      next_action: '',
      summary: `${AGENT}: advance mode requires valid --current-stage`,
    };
  }

  const riskLevel = determineRiskForTask(taskText);
  const lifecycleMap = buildLifecycleMap(taskText, currentStageArg, approvedBy || null);
  const nextEntry = computeNextStage(currentStageArg, lifecycleMap);
  const nextStageName = nextEntry ? nextEntry.stage : null;
  const nextAction = buildNextActionString(nextEntry);

  const currentEntry = lifecycleMap.find((entry) => entry.stage === currentStageArg);
  const warnings = [];
  if (currentEntry && currentEntry.blockers.length > 0) {
    warnings.push(...currentEntry.blockers.map((b) => `Current stage blocker: ${b}`));
  }

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'advance',
    status: warnings.length > 0 ? 'WARN' : 'PASS',
    task: taskText,
    risk_level: riskLevel,
    approved_by: approvedBy || null,
    lifecycle_map: lifecycleMap,
    current_stage: currentStageArg,
    next_stage: nextStageName,
    next_action: nextAction,
    warnings,
    summary: `${AGENT}: task at stage "${currentStageArg}" (risk=${riskLevel}). Next: ${nextStageName || 'none'}. ${nextAction}`,
  };
}

function main(argv, options) {
  const args = argv || process.argv.slice(2);
  const opts = options || {};
  const parsed = parseArgs(args);
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'map') {
    return buildMapMode(parsed.options.task || '');
  }

  if (parsed.mode === 'advance') {
    return buildAdvanceMode(
      parsed.options.task || '',
      parsed.options['current-stage'] || '',
      parsed.options['approved-by'] || '',
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
  LIFECYCLE_STAGES,
  STAGE_DEFINITIONS,
  VALID_MODES,
  buildAdvanceMode,
  buildLifecycleMap,
  buildMapMode,
  buildNextActionString,
  buildStatusMode,
  buildStageEntry,
  computeNextStage,
  computeStageBlockers,
  determineRiskForTask,
  formatOutput,
  main,
  parseArgs,
  tryLoadBotSystem,
  tryLoadPolicyEnforcement,
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
