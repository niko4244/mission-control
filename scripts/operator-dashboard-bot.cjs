#!/usr/bin/env node
/**
 * operator-dashboard-bot.cjs
 * Surfaces queue state, risk, approvals, and next actions to operators.
 *
 * OBSERVE ONLY / OPERATOR VISIBILITY
 *
 * Modes:
 *   status    — Agent identity
 *   dashboard — Comprehensive operator view
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Operator Dashboard Bot v1';
const LABEL = 'OBSERVE ONLY / OPERATOR VISIBILITY';
const BOT_ID = 'operator-dashboard-bot';
const AUTHORITY = 'OPERATOR_VISIBILITY';
const VALID_MODES = new Set(['status', 'dashboard']);

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

function healthRank(h) {
  if (h === 'FAIL') return 2;
  if (h === 'WARN') return 1;
  return 0;
}

function aggregateHealth(statuses) {
  const worst = statuses.reduce((acc, s) => Math.max(acc, healthRank(s)), 0);
  if (worst >= 2) return 'FAIL';
  if (worst >= 1) return 'WARN';
  return 'PASS';
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    authority: AUTHORITY,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    metadata: data.metadata || {},
    summary: data.summary || '',
  };
}

function buildStatusMode(rootDir, options = {}) {
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      bot_id: BOT_ID,
      agent: AGENT,
      label: LABEL,
      authority_level: 7,
      category: 'observer',
      reports_to: 'ui-dashboard-governor',
      observe_only: true,
    },
    summary: `${AGENT} (${LABEL}) | Status: PASS`,
  });
  result.summary = `${AGENT} (${LABEL}) | Status: PASS`;
  return result;
}

function buildDashboardMode(rootDir, options = {}) {
  const botSystemApi = loadSubsystemApi(rootDir, 'scripts/mission-control-bot-system.cjs');
  const releaseGovernorApi = loadSubsystemApi(rootDir, 'scripts/release-governor.cjs');
  const chiefArbiterApi = loadSubsystemApi(rootDir, 'scripts/chief-arbiter.cjs');

  const operator_alerts = [];
  const healthStatuses = [];

  // Bot system status
  let bot_system_status = null;
  if (botSystemApi.available) {
    try {
      bot_system_status = botSystemApi.api.buildStatusMode(rootDir, options);
      healthStatuses.push(bot_system_status.status || 'FAIL');
      const findings = bot_system_status.findings || {};
      const allWarnings = [
        ...(findings.blockers || []),
        ...(findings.major || []),
        ...(findings.minor || []),
        ...(findings.advisory || []),
      ];
      operator_alerts.push(...allWarnings);
    } catch (err) {
      bot_system_status = { status: 'FAIL', error: err instanceof Error ? err.message : String(err) };
      healthStatuses.push('FAIL');
      operator_alerts.push(`Bot system error: ${bot_system_status.error}`);
    }
  } else {
    bot_system_status = { status: 'FAIL', error: botSystemApi.error };
    healthStatuses.push('FAIL');
    operator_alerts.push(`Bot system unavailable: ${botSystemApi.error}`);
  }

  // Release status
  let release_status = null;
  if (releaseGovernorApi.available) {
    try {
      release_status = releaseGovernorApi.api.runReleaseGovernor({ rootDir });
      const rs = release_status.status || release_status.gate_status || 'FAIL';
      healthStatuses.push(String(rs).toUpperCase().includes('PASS') ? 'PASS' : String(rs).toUpperCase().includes('WARN') ? 'WARN' : 'FAIL');
      const warnings = release_status.warnings || release_status.blockers || [];
      operator_alerts.push(...(Array.isArray(warnings) ? warnings : []));
    } catch (err) {
      release_status = { status: 'FAIL', error: err instanceof Error ? err.message : String(err) };
      healthStatuses.push('FAIL');
      operator_alerts.push(`Release governor error: ${release_status.error}`);
    }
  } else {
    release_status = { status: 'FAIL', error: releaseGovernorApi.error };
    healthStatuses.push('FAIL');
    operator_alerts.push(`Release governor unavailable: ${releaseGovernorApi.error}`);
  }

  // Chief arbiter status
  let chief_arbiter_status = null;
  if (chiefArbiterApi.available) {
    try {
      chief_arbiter_status = chiefArbiterApi.api.buildStatusMode(rootDir, options);
      healthStatuses.push(chief_arbiter_status.status || 'FAIL');
      const findings = chief_arbiter_status.findings || {};
      const allWarnings = [
        ...(findings.blockers || []),
        ...(findings.major || []),
        ...(findings.minor || []),
      ];
      operator_alerts.push(...allWarnings);
    } catch (err) {
      chief_arbiter_status = { status: 'FAIL', error: err instanceof Error ? err.message : String(err) };
      healthStatuses.push('FAIL');
      operator_alerts.push(`Chief arbiter error: ${chief_arbiter_status.error}`);
    }
  } else {
    chief_arbiter_status = { status: 'FAIL', error: chiefArbiterApi.error };
    healthStatuses.push('FAIL');
    operator_alerts.push(`Chief arbiter unavailable: ${chiefArbiterApi.error}`);
  }

  const overall_health = aggregateHealth(healthStatuses);

  // Build governance summary from bot system
  let implemented_bots = 0;
  let planned_bots = [];
  let release_ready = false;
  let branch = '';
  let warnings = [];

  if (bot_system_status && bot_system_status.metadata) {
    implemented_bots = (bot_system_status.metadata.implemented_bots || []).length;
    planned_bots = bot_system_status.metadata.planned_bots || [];
    warnings = [
      ...(bot_system_status.metadata.hierarchy_warnings || []),
      ...(bot_system_status.metadata.claim_violations || []).map((v) => `${v.bot_id}: ${v.issue}`),
    ];
  }
  if (release_status) {
    release_ready = release_status.release_ready === true || release_status.gate_status === 'PASS';
    branch = release_status.branch || release_status.metadata?.branch || '';
  }

  const governance_summary = {
    implemented_bots,
    planned_bots,
    release_ready,
    branch,
    warnings,
  };

  let next_recommended_action = 'System healthy. Continue implementation under governance.';
  if (overall_health === 'FAIL') {
    next_recommended_action = 'Critical issues detected. Human review required before proceeding.';
  } else if (overall_health === 'WARN') {
    next_recommended_action = 'Warnings present. Review operator_alerts and address before push/PR.';
  }

  const result = buildOutput('dashboard', {
    status: overall_health,
    metadata: {
      overall_health,
      governance_summary,
      next_recommended_action,
      operator_alerts,
      timestamp: new Date().toISOString(),
      subsystems: {
        bot_system: bot_system_status,
        release: release_status,
        chief_arbiter: chief_arbiter_status,
      },
    },
    summary: `${AGENT} | Dashboard | health=${overall_health} | alerts=${operator_alerts.length}`,
  });
  result.summary = `${AGENT} | Dashboard | health=${overall_health} | alerts=${operator_alerts.length}`;
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'dashboard') {
    return buildDashboardMode(rootDir, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  BOT_ID,
  buildOutput,
  buildStatusMode,
  buildDashboardMode,
  formatOutput,
  main,
  parseArgs,
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
