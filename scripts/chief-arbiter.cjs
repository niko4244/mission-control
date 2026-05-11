#!/usr/bin/env node
/**
 * chief-arbiter.cjs
 * Highest bot-level authority. Cross-domain plan reviewer and authorization gatekeeper.
 *
 * Observe-only. Never mutates files, git state, or remote systems.
 * Reviews plans from domain governors, authorizes bounded work under policy,
 * and escalates to human-owner when decisions exceed bot authority.
 *
 * Never overrides an explicit human stop.
 *
 * Modes:
 *   status   — System health, registry/policy state, supervised bot map
 *   review   — Cross-domain plan review: --task "..." [--governor "id"]
 *   escalate — List decisions that require human-owner action
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Chief Arbiter v1';
const AUTHORITY = 'CROSS_DOMAIN_FINAL_BOT_REVIEW';
const LABEL = 'NON-MUTATING / HIGHEST BOT AUTHORITY';
const BOT_ID = 'chief-arbiter';
const VALID_MODES = new Set(['status', 'review', 'escalate']);

const REVIEW_DECISIONS = new Set([
  'APPROVE',
  'APPROVE_WITH_NOTES',
  'REQUEST_CORRECTIONS',
  'REJECT',
  'ESCALATE_TO_HUMAN',
]);

const ALWAYS_HUMAN_REQUIRED = [
  'push',
  'create_pr',
  'merge',
  'override explicit human block',
  'protected-domain policy exceptions',
];

const AUTONOMOUS_STAGE_COMMIT_RISKS = ['Low', 'Tooling', 'Docs', 'TestOnly'];

const CRITICAL_HARD_BLOCK_PATTERNS = [
  'git add .',
  'merge without human approval',
  'lockfile drift',
  'package drift',
  'client-supplied workspace id',
  'raw internal error leakage',
  'failed validation',
  'fallback regression',
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
  });
  return {
    ok: !result.error && result.status === 0,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : '',
  };
}

function loadSubsystemApi(rootDir, scriptFile) {
  const absolute = path.join(rootDir, scriptFile);
  if (!fs.existsSync(absolute)) {
    return { available: false, error: `Script not found: ${scriptFile}` };
  }
  try {
    return { available: true, api: require(absolute) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function loadBotSystem(rootDir, options = {}) {
  if (options.botSystemApi) return { available: true, api: options.botSystemApi };
  return loadSubsystemApi(rootDir, 'scripts/mission-control-bot-system.cjs');
}

function loadReleaseGovernorApi(rootDir, options = {}) {
  if (options.releaseGovernorApi) return { available: true, api: options.releaseGovernorApi };
  return loadSubsystemApi(rootDir, 'scripts/release-governor.cjs');
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

function isCriticalHardBlock(block) {
  const lower = String(block || '').toLowerCase();
  return CRITICAL_HARD_BLOCK_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function buildEmptyAuthorization() {
  return {
    plan_approved: false,
    implementation_approved: false,
    stage_authorized: false,
    commit_authorized: false,
    push_authorized: false,
    pr_create_authorized: false,
    merge_authorized: false,
    human_required: ALWAYS_HUMAN_REQUIRED.slice(),
  };
}

function buildEmptyReleaseGate() {
  return {
    stage_allowed: false,
    commit_allowed: false,
    push_allowed: false,
    pr_allowed: false,
    merge_recommended: false,
  };
}

function evaluateReview(taskText, claimedGovernor, policy) {
  const botSystemPath = path.resolve(__dirname, 'mission-control-bot-system.cjs');
  const taskLower = String(taskText || '').toLowerCase();
  let routing = null;
  let policyBlockHits = [];
  let protectedHits = [];

  if (fs.existsSync(botSystemPath)) {
    try {
      const botSystem = require(botSystemPath);
      routing = botSystem.buildRoutingDecision(taskText, policy);
      policyBlockHits = botSystem.relevantHardBlocks(taskText, policy);
      const allProtected = Array.isArray(policy && policy.protected_domains) ? policy.protected_domains : [];
      protectedHits = allProtected.filter((domain) => taskLower.includes(String(domain).toLowerCase()));
    } catch {
      routing = null;
    }
  }

  // Direct violations: task text itself requests a forbidden action.
  // Policy domain hits (policyBlockHits) are advisory constraints, not task violations.
  const criticalBlocks = unique(
    CRITICAL_HARD_BLOCK_PATTERNS.filter((pattern) => taskLower.includes(pattern.toLowerCase())),
  );

  const findings = { blockers: [], major: [], minor: [], advisory: [] };
  for (const block of policyBlockHits) {
    findings.advisory.push(`Policy constraint in scope: "${block}"`);
  }
  let decision = 'APPROVE';
  let status = 'PASS';
  let confidence = 'high';

  for (const block of criticalBlocks) {
    findings.blockers.push(`Hard block triggered: "${block}"`);
  }
  if (criticalBlocks.length > 0) {
    decision = 'REJECT';
    status = 'FAIL';
    confidence = 'high';
  }

  if (protectedHits.length > 0) {
    if (!claimedGovernor) {
      findings.major.push(
        `Task touches protected domain(s) without a domain governor: ${protectedHits.join(', ')}`,
      );
    } else {
      findings.advisory.push(
        `Protected domain(s) touched under governor ${claimedGovernor}: ${protectedHits.join(', ')}`,
      );
    }
  }

  const expectedGovernor = routing ? routing.governor : '';
  if (claimedGovernor && expectedGovernor && claimedGovernor !== expectedGovernor) {
    findings.major.push(
      `Authority chain mismatch: task routes to "${expectedGovernor}" but claimed governor is "${claimedGovernor}"`,
    );
  }

  if (findings.blockers.length === 0 && findings.major.length > 0) {
    if (decision === 'APPROVE') {
      decision = protectedHits.length > 0 && !claimedGovernor
        ? 'ESCALATE_TO_HUMAN'
        : 'REQUEST_CORRECTIONS';
      status = 'WARN';
      confidence = 'moderate';
    }
  }

  const risk = routing ? routing.risk : 'Unknown';
  const authorization = buildEmptyAuthorization();
  const releaseGate = buildEmptyReleaseGate();

  if (decision === 'APPROVE' || decision === 'APPROVE_WITH_NOTES') {
    authorization.plan_approved = true;
    if (AUTONOMOUS_STAGE_COMMIT_RISKS.includes(risk)) {
      authorization.implementation_approved = true;
      authorization.stage_authorized = true;
      authorization.commit_authorized = true;
      releaseGate.stage_allowed = true;
      releaseGate.commit_allowed = true;
    } else if (risk === 'Medium') {
      authorization.implementation_approved = true;
      authorization.stage_authorized = true;
      authorization.commit_authorized = true;
      releaseGate.stage_allowed = true;
      releaseGate.commit_allowed = true;
      if (decision === 'APPROVE') {
        decision = 'APPROVE_WITH_NOTES';
        status = 'WARN';
        confidence = 'moderate';
      }
      findings.advisory.push('Medium risk: human review recommended before push and PR.');
    } else {
      findings.advisory.push(`Risk class "${risk}": stage and commit require human confirmation.`);
    }
  }

  let humanAction;
  if (decision === 'APPROVE') {
    humanAction = 'No issues found. Proceed with bounded implementation under the approved authority chain.';
  } else if (decision === 'APPROVE_WITH_NOTES') {
    humanAction = 'Plan approved with notes. Review findings, keep scope bounded, and keep push/PR gated behind human approval.';
  } else if (decision === 'REQUEST_CORRECTIONS') {
    humanAction = 'Correct the authority chain or scope issues before implementation begins.';
  } else if (decision === 'REJECT') {
    humanAction = 'Stop. Resolve the hard block(s) before any implementation, stage, or commit action.';
  } else {
    humanAction = 'Escalate to human-owner. Protected-domain exposure or malformed authority chain cannot be resolved at bot level.';
  }

  return {
    status,
    decision,
    confidence,
    risk,
    domain: routing ? routing.domain : 'unknown',
    governor: expectedGovernor,
    claimed_governor: claimedGovernor || '',
    findings,
    authorization,
    final_release_gate: releaseGate,
    human_action: humanAction,
    routing: routing || {},
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    authority: AUTHORITY,
    label: LABEL,
    mode,
    status: data.status || 'FAIL',
    decision: data.decision || 'ESCALATE_TO_HUMAN',
    confidence: data.confidence || 'low',
    risk: data.risk || 'Unknown',
    summary: data.summary || '',
    findings: data.findings || { blockers: [], major: [], minor: [], advisory: [] },
    authorization: data.authorization || buildEmptyAuthorization(),
    final_release_gate: data.final_release_gate || buildEmptyReleaseGate(),
    human_action: data.human_action || '',
    metadata: data.metadata || {},
  };
}

function summarize(result) {
  return [
    `${AGENT} (${LABEL})`,
    `Mode: ${result.mode}`,
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `Risk: ${result.risk}`,
    `Confidence: ${result.confidence}`,
    `Human action: ${result.human_action}`,
  ].join('\n');
}

function buildStatusMode(rootDir, options = {}) {
  const botSystemState = loadBotSystem(rootDir, options);
  const releaseState = loadReleaseGovernorApi(rootDir, options);

  const metadata = { bot_system_available: botSystemState.available, release_governor_available: releaseState.available };
  const findings = { blockers: [], major: [], minor: [], advisory: [] };
  let systemStatus = 'PASS';

  let sharedState = null;
  let selfView = null;

  if (botSystemState.available) {
    try {
      sharedState = botSystemState.api.buildSharedState(rootDir, options);
      selfView = botSystemState.api.getAuthorityView(BOT_ID, sharedState.registry, sharedState.policy);
      metadata.implemented_bots = sharedState.detection.implemented;
      metadata.planned_bots = sharedState.detection.missing_planned_bots;
      metadata.hierarchy_warnings = sharedState.hierarchyWarnings;
      metadata.claim_violations = sharedState.claimViolations;

      if (sharedState.claimViolations.length > 0) {
        findings.blockers.push(
          `Authority claim violations: ${sharedState.claimViolations.map((v) => `${v.bot_id} -> ${v.issue}`).join('; ')}`,
        );
        systemStatus = 'FAIL';
      }
      if (sharedState.hierarchyWarnings.length > 0) {
        findings.advisory.push(...sharedState.hierarchyWarnings);
        if (systemStatus === 'PASS') systemStatus = 'WARN';
      }
      if (sharedState.detection.missing_planned_bots.length > 0) {
        findings.advisory.push(
          `Planned bots awaiting implementation: ${sharedState.detection.missing_planned_bots.join(', ')}`,
        );
        if (systemStatus === 'PASS') systemStatus = 'WARN';
      }
    } catch (error) {
      findings.major.push(`Bot system state error: ${error instanceof Error ? error.message : String(error)}`);
      systemStatus = 'WARN';
    }
  } else {
    findings.blockers.push(`Bot system unavailable: ${botSystemState.error}`);
    systemStatus = 'FAIL';
  }

  if (!releaseState.available) {
    findings.minor.push(`Release governor unavailable: ${releaseState.error}`);
  }

  const result = buildOutput('status', {
    status: systemStatus,
    decision: systemStatus === 'FAIL' ? 'ESCALATE_TO_HUMAN' : systemStatus === 'WARN' ? 'APPROVE_WITH_NOTES' : 'APPROVE',
    confidence: systemStatus === 'FAIL' ? 'low' : systemStatus === 'WARN' ? 'moderate' : 'high',
    risk: 'Low',
    findings,
    authorization: {
      ...buildEmptyAuthorization(),
      plan_approved: systemStatus !== 'FAIL',
    },
    final_release_gate: buildEmptyReleaseGate(),
    human_action: systemStatus === 'FAIL'
      ? 'Resolve authority violations before authorizing any bot-level work.'
      : 'Bot system is operational. Chief Arbiter is ready to review plans.',
    metadata: {
      ...metadata,
      self_view: selfView,
      supervises: selfView ? selfView.supervises : [],
    },
  });
  result.summary = summarize(result);
  return result;
}

function buildReviewMode(rootDir, taskText, claimedGovernor, options = {}) {
  if (!taskText) {
    const result = buildOutput('review', {
      status: 'FAIL',
      decision: 'ESCALATE_TO_HUMAN',
      confidence: 'low',
      risk: 'Unknown',
      findings: { blockers: ['Missing required --task value'], major: [], minor: [], advisory: [] },
      authorization: buildEmptyAuthorization(),
      final_release_gate: buildEmptyReleaseGate(),
      human_action: 'Provide a --task description to review.',
    });
    result.summary = summarize(result);
    return result;
  }

  const botSystemState = loadBotSystem(rootDir, options);
  let policy = null;
  if (botSystemState.available) {
    try {
      policy = botSystemState.api.loadPolicy(rootDir);
    } catch {
      policy = null;
    }
  }

  if (!policy) {
    const result = buildOutput('review', {
      status: 'FAIL',
      decision: 'ESCALATE_TO_HUMAN',
      confidence: 'low',
      risk: 'Unknown',
      findings: {
        blockers: ['Policy unavailable — cannot perform cross-domain review'],
        major: [],
        minor: [],
        advisory: [],
      },
      authorization: buildEmptyAuthorization(),
      final_release_gate: buildEmptyReleaseGate(),
      human_action: 'Restore the mission-control-policy.json and bot-system before requesting review.',
    });
    result.summary = summarize(result);
    return result;
  }

  const reviewed = evaluateReview(taskText, claimedGovernor, policy);
  const result = buildOutput('review', reviewed);
  result.summary = summarize(result);
  return result;
}

function buildEscalateMode(rootDir, options = {}) {
  const botSystemState = loadBotSystem(rootDir, options);
  let policy = null;
  if (botSystemState.available) {
    try {
      policy = botSystemState.api.loadPolicy(rootDir);
    } catch {
      policy = null;
    }
  }

  const escalations = [];
  if (policy && policy.approval_matrix) {
    for (const [riskClass, matrix] of Object.entries(policy.approval_matrix)) {
      const humanFor = Array.isArray(matrix.human_required_for) ? matrix.human_required_for : [];
      if (humanFor.length > 0) {
        escalations.push({ risk_class: riskClass, human_required_for: humanFor });
      }
    }
  }

  const humanOnlyActions = policy && policy.authority_rules && policy.authority_rules.human_only_actions
    ? policy.authority_rules.human_only_actions
    : [];
  const hardBlocks = policy && policy.hard_blocks ? policy.hard_blocks : [];
  const protectedDomains = policy && policy.protected_domains ? policy.protected_domains : [];

  const result = buildOutput('escalate', {
    status: 'PASS',
    decision: 'APPROVE',
    confidence: 'high',
    risk: 'Low',
    findings: { blockers: [], major: [], minor: [], advisory: [] },
    authorization: { ...buildEmptyAuthorization(), plan_approved: true },
    final_release_gate: buildEmptyReleaseGate(),
    human_action: 'Review escalation registry. All items below require direct human-owner authorization.',
    metadata: {
      escalations_by_risk: escalations,
      human_only_actions: humanOnlyActions,
      hard_blocks: hardBlocks,
      protected_domains: protectedDomains,
      note: 'Chief Arbiter cannot authorize any item on this list. Human-owner approval is required.',
    },
  });
  result.summary = summarize(result);
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'review') {
    return buildReviewMode(rootDir, parsed.options.task || '', parsed.options.governor || '', options);
  }
  if (parsed.mode === 'escalate') {
    return buildEscalateMode(rootDir, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  BOT_ID,
  REVIEW_DECISIONS,
  ALWAYS_HUMAN_REQUIRED,
  AUTONOMOUS_STAGE_COMMIT_RISKS,
  CRITICAL_HARD_BLOCK_PATTERNS,
  buildEmptyAuthorization,
  buildEmptyReleaseGate,
  buildEscalateMode,
  buildOutput,
  buildReviewMode,
  buildStatusMode,
  evaluateReview,
  formatOutput,
  isCriticalHardBlock,
  loadBotSystem,
  loadReleaseGovernorApi,
  main,
  normalizePath,
  parseArgs,
  splitLines,
  summarize,
  unique,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      authority: AUTHORITY,
      label: LABEL,
      mode: 'status',
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
