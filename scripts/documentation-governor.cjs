#!/usr/bin/env node
/**
 * documentation-governor.cjs
 * Governor for documentation changes.
 *
 * OBSERVE ONLY / DOCS GUARDIAN
 * Reviews doc PRs for accuracy, completeness, and operator guidance quality.
 * Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status              — Agent identity
 *   review --task "…"   — Review a documentation task
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Documentation Governor v1';
const LABEL = 'OBSERVE ONLY / DOCS GUARDIAN';
const BOT_ID = 'documentation-governor';
const AUTHORITY_LEVEL = 3;
const VALID_MODES = new Set(['status', 'review']);

const ALWAYS_HUMAN_REQUIRED = ['push', 'create_pr', 'merge'];

const SUPERVISED_BOTS = ['documentation-executor'];

// Keywords that signal policy/authority/governance docs
const SENSITIVE_KEYWORDS = ['policy', 'authority', 'governance', 'security'];

// Minor typo/grammar patterns
const TYPO_PATTERNS = ['typo', 'spelling', 'grammar', 'fix typo', 'fix spelling', 'punctuation'];

// New section / major content patterns
const NEW_SECTION_PATTERNS = ['new section', 'add section', 'new page', 'add page', 'new guide', 'add guide'];

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

function classifyDocTask(taskText) {
  const lower = String(taskText || '').toLowerCase();

  const isSensitive = SENSITIVE_KEYWORDS.some((k) => lower.includes(k));
  const isTypo = TYPO_PATTERNS.some((k) => lower.includes(k));
  const isNewSection = NEW_SECTION_PATTERNS.some((k) => lower.includes(k));
  const isArchDoc = lower.includes('architecture') && (lower.includes('doc') || lower.includes('guide'));

  // Scope classification
  let scope;
  if (isTypo) {
    scope = 'minor_typo';
  } else if (isNewSection) {
    scope = 'new_section';
  } else if (isArchDoc) {
    scope = 'architecture_doc';
  } else if (isSensitive) {
    scope = 'policy_doc';
  } else {
    scope = 'content_update';
  }

  // Risk level
  let riskLevel;
  if (scope === 'minor_typo') {
    riskLevel = 'Docs';
  } else if (scope === 'policy_doc' || scope === 'architecture_doc' || isSensitive) {
    riskLevel = 'Medium';
  } else {
    riskLevel = 'Low';
  }

  // Concerns
  const concerns = [];
  if (isSensitive) {
    concerns.push('Task references policy/authority/governance/security — human confirmation required before merge');
  }
  if (isNewSection) {
    concerns.push('New section additions may require accuracy review by a domain expert');
  }
  if (isArchDoc) {
    concerns.push('Architecture documentation changes should be cross-reviewed with architecture-governor');
  }

  // Decision
  let decision;
  if (riskLevel === 'Medium') {
    decision = 'APPROVE_WITH_NOTES';
  } else if (concerns.length > 0) {
    decision = 'APPROVE_WITH_NOTES';
  } else {
    decision = 'APPROVE';
  }

  const approved = decision !== 'REQUEST_CORRECTIONS';

  return {
    scope,
    risk_level: riskLevel,
    approved,
    decision,
    concerns,
    requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
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
  return buildOutput('status', {
    status: 'PASS',
    observe_only: true,
    reports_to: 'chief-arbiter',
    supervised_bots: SUPERVISED_BOTS,
    human_required_for: ALWAYS_HUMAN_REQUIRED.slice(),
    summary: `${AGENT} (${LABEL}) — observe-only docs governor. Supervises: ${SUPERVISED_BOTS.join(', ')}.`,
  });
}

function buildReviewMode(rootDir, taskText, options = {}) {
  if (!taskText) {
    return buildOutput('review', {
      status: 'FAIL',
      error: 'Missing required --task value',
      requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
    });
  }

  const classification = classifyDocTask(taskText);

  return buildOutput('review', {
    status: classification.approved ? 'PASS' : 'WARN',
    task: taskText,
    scope: classification.scope,
    risk_level: classification.risk_level,
    approved: classification.approved,
    decision: classification.decision,
    concerns: classification.concerns,
    requires_human_for: ALWAYS_HUMAN_REQUIRED.slice(),
    summary: `${AGENT}: ${classification.decision} (scope=${classification.scope}, risk=${classification.risk_level})`,
  });
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
  LABEL,
  BOT_ID,
  ALWAYS_HUMAN_REQUIRED,
  SUPERVISED_BOTS,
  buildOutput,
  buildStatusMode,
  buildReviewMode,
  classifyDocTask,
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
