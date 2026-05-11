#!/usr/bin/env node
/**
 * ui-dashboard-governor.cjs
 * Governor for dashboard visibility and UI safety.
 *
 * Reviews UI changes for data exposure risks, operator UX quality,
 * and safe exposure of bot state.
 *
 * OBSERVE ONLY / UI SAFETY GOVERNOR
 * Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status  — Agent identity, list supervised bots
 *   review  — Review a UI/dashboard task: --task "description"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'UI Dashboard Governor v1';
const LABEL = 'OBSERVE ONLY / UI SAFETY GOVERNOR';
const BOT_ID = 'ui-dashboard-governor';
const AUTHORITY = 'UI_DOMAIN_GOVERNOR';
const VALID_MODES = new Set(['status', 'review']);

const SUPERVISES = ['operator-dashboard-bot'];

const ALWAYS_HUMAN_REQUIRED = ['push', 'create_pr', 'merge'];

const DATA_EXPOSURE_KEYWORDS = [
  'token', 'key', 'secret', 'api_key', 'apikey', 'password', 'credential',
  'auth', 'jwt', 'bearer', 'private', 'sensitive', 'user data', 'pii',
];

const AUTH_UI_KEYWORDS = [
  'auth', 'login', 'logout', 'password', 'token', 'session', 'oauth',
  'credential', 'permission', 'role', 'access control',
];

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

function classifyScope(taskLower) {
  if (
    AUTH_UI_KEYWORDS.some((kw) => taskLower.includes(kw)) &&
    (taskLower.includes('form') || taskLower.includes('page') || taskLower.includes('screen') ||
      taskLower.includes('ui') || taskLower.includes('component'))
  ) {
    return 'auth_ui';
  }
  if (DATA_EXPOSURE_KEYWORDS.some((kw) => taskLower.includes(kw))) {
    return 'data_exposure';
  }
  if (taskLower.includes('panel') || taskLower.includes('widget') || taskLower.includes('chart')) {
    if (taskLower.includes('new') || taskLower.includes('add') || taskLower.includes('create')) {
      return 'new_panel';
    }
    return 'widget_update';
  }
  if (taskLower.includes('layout') || taskLower.includes('grid') || taskLower.includes('arrangement')) {
    return 'layout_change';
  }
  return 'widget_update';
}

function hasDataExposureRisk(taskLower) {
  return DATA_EXPOSURE_KEYWORDS.some((kw) => taskLower.includes(kw));
}

function isAuthUiChange(taskLower) {
  return AUTH_UI_KEYWORDS.some((kw) => taskLower.includes(kw));
}

function reviewTask(taskText) {
  const taskLower = String(taskText || '').toLowerCase();
  const scope = classifyScope(taskLower);
  const data_exposure_risk = hasDataExposureRisk(taskLower);
  const isAuth = isAuthUiChange(taskLower) || scope === 'auth_ui';

  const concerns = [];
  let risk_level = 'Low';
  let decision = 'APPROVE';

  // Auth UI or data exposure → escalate
  if (scope === 'auth_ui' || isAuth) {
    risk_level = 'High';
    decision = 'ESCALATE_TO_HUMAN';
    concerns.push('Auth/token/key/secret UI changes require human review before any implementation.');
  } else if (scope === 'data_exposure' || data_exposure_risk) {
    risk_level = 'High';
    decision = 'ESCALATE_TO_HUMAN';
    concerns.push('Data exposure risk detected — task references sensitive data. Human review required.');
  } else if (scope === 'new_panel') {
    risk_level = 'Medium';
    decision = 'APPROVE_WITH_NOTES';
    concerns.push('New panel additions should be reviewed for unintended data surface area.');
  } else {
    // cosmetic / widget_update / layout_change
    risk_level = 'Low';
    decision = 'APPROVE';
  }

  // If data_exposure_risk and no explicit review note, force escalate
  if (data_exposure_risk && decision !== 'ESCALATE_TO_HUMAN') {
    decision = 'ESCALATE_TO_HUMAN';
    risk_level = 'High';
    concerns.push('Data exposure keywords detected — escalating to human for explicit review.');
  }

  const approved = decision === 'APPROVE' || decision === 'APPROVE_WITH_NOTES';

  return {
    scope,
    risk_level,
    data_exposure_risk,
    approved,
    decision,
    concerns,
    requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    authority: AUTHORITY,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    decision: data.decision || 'APPROVE',
    metadata: data.metadata || {},
    summary: data.summary || '',
  };
}

function buildStatusMode(rootDir, options = {}) {
  const registryPath = path.join(rootDir, 'config', 'mission-control-bot-registry.json');
  let selfEntry = null;
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      selfEntry = (registry.bots || []).find((b) => b.id === BOT_ID) || null;
    } catch {
      // ignore
    }
  }

  const result = buildOutput('status', {
    status: 'PASS',
    decision: 'APPROVE',
    metadata: {
      bot_id: BOT_ID,
      agent: AGENT,
      label: LABEL,
      authority_level: 3,
      category: 'governor',
      reports_to: 'chief-arbiter',
      supervises: SUPERVISES,
      registry_entry: selfEntry,
      observe_only: true,
      human_required_for: ALWAYS_HUMAN_REQUIRED,
    },
    summary: `${AGENT} (${LABEL}) | Status: PASS | Supervises: ${SUPERVISES.join(', ')}`,
  });
  result.summary = `${AGENT} (${LABEL}) | Status: PASS | Supervises: ${SUPERVISES.join(', ')}`;
  return result;
}

function buildReviewMode(rootDir, taskText, options = {}) {
  if (!taskText) {
    return buildOutput('review', {
      status: 'FAIL',
      decision: 'ESCALATE_TO_HUMAN',
      metadata: {
        error: 'Missing required --task value',
        requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
      },
      summary: `${AGENT} | FAIL | Missing --task`,
    });
  }

  const review = reviewTask(taskText);
  const result = buildOutput('review', {
    status: review.risk_level === 'High' ? 'WARN' : 'PASS',
    decision: review.decision,
    metadata: {
      task: taskText,
      ...review,
    },
    summary: `${AGENT} | ${review.decision} | scope=${review.scope} risk=${review.risk_level}`,
  });
  result.summary = `${AGENT} | ${review.decision} | scope=${review.scope} risk=${review.risk_level}`;
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'review') {
    return buildReviewMode(rootDir, parsed.options.task || '', options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  BOT_ID,
  ALWAYS_HUMAN_REQUIRED,
  SUPERVISES,
  buildOutput,
  buildStatusMode,
  buildReviewMode,
  formatOutput,
  main,
  parseArgs,
  reviewTask,
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
