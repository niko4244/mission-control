#!/usr/bin/env node
/**
 * break-glass-protocol.cjs
 * Observe-only human-only gate for Mission Control absolute action restrictions.
 */

'use strict';

const AGENT = 'Break Glass Protocol v1';
const LABEL = 'OBSERVE ONLY / HUMAN-ONLY GATE';
const VALID_MODES = new Set(['status', 'check', 'audit']);

const BREAK_GLASS_ACTIONS = {
  force_push: {
    id: 'force_push',
    description: 'git push --force on any branch — rewrites remote history without review',
    category: 'git',
    severity: 'critical',
  },
  history_rewrite: {
    id: 'history_rewrite',
    description: 'git rebase -i, git filter-branch, git reset --hard — destructive history mutation',
    category: 'git',
    severity: 'critical',
  },
  governance_bypass: {
    id: 'governance_bypass',
    description: 'Skipping any governor/arbiter review — circumvents the approval chain',
    category: 'governance',
    severity: 'critical',
  },
  production_destructive: {
    id: 'production_destructive',
    description: 'DROP TABLE, rm -rf on data, delete .data/ — permanent data destruction in production',
    category: 'data',
    severity: 'critical',
  },
  secret_exposure: {
    id: 'secret_exposure',
    description: 'Printing/logging secrets, tokens, credentials — credential leakage risk',
    category: 'security',
    severity: 'critical',
  },
  secret_rotation: {
    id: 'secret_rotation',
    description: 'Changing AUTH_SECRET, API_KEY, tokens in production — disrupts all active sessions',
    category: 'security',
    severity: 'critical',
  },
  constitution_change: {
    id: 'constitution_change',
    description: 'Modifying mission-control-policy.json authority rules — alters the governance constitution',
    category: 'governance',
    severity: 'critical',
  },
  merge_to_protected: {
    id: 'merge_to_protected',
    description: 'Merging to main/master without PR — bypasses all review and CI gates',
    category: 'git',
    severity: 'critical',
  },
  deploy_without_validation: {
    id: 'deploy_without_validation',
    description: 'Deploying without passing tests — ships unvalidated code to production',
    category: 'release',
    severity: 'critical',
  },
};

const ESCALATION_PATH = 'Human Owner only — no bot can authorize this';

function isBreakGlass(actionId) {
  return Object.prototype.hasOwnProperty.call(BREAK_GLASS_ACTIONS, String(actionId || ''));
}

function checkBreakGlass(actionId) {
  const action = BREAK_GLASS_ACTIONS[String(actionId || '')];

  if (!action) {
    return {
      is_break_glass: false,
      action_id: actionId || '',
      description: 'Action is not on the break-glass list',
      human_authorization_required: false,
      bot_authorization_possible: true,
      escalation_path: 'Standard governance chain applies',
    };
  }

  return {
    is_break_glass: true,
    action_id: action.id,
    description: action.description,
    category: action.category,
    severity: action.severity,
    human_authorization_required: true,
    bot_authorization_possible: false,
    escalation_path: ESCALATION_PATH,
  };
}

function auditBreakGlass(actionId, requesterId) {
  const isGlass = isBreakGlass(actionId);
  const action = BREAK_GLASS_ACTIONS[String(actionId || '')];
  const timestamp = new Date().toISOString();

  if (!isGlass) {
    return {
      attempted: true,
      blocked: false,
      requester: requesterId || 'unknown',
      action: actionId || '',
      reason: 'Action is not a break-glass action — standard governance applies',
      required_human_approval: false,
      timestamp,
    };
  }

  return {
    attempted: true,
    blocked: true,
    requester: requesterId || 'unknown',
    action: action.id,
    description: action.description,
    category: action.category,
    severity: action.severity,
    reason: `Break-glass action attempted by bot. ${ESCALATION_PATH}.`,
    required_human_approval: true,
    bot_authorization_possible: false,
    escalation_path: ESCALATION_PATH,
    timestamp,
  };
}

function buildStatusMode() {
  const actions = Object.values(BREAK_GLASS_ACTIONS).map((action) => ({
    id: action.id,
    description: action.description,
    category: action.category,
    severity: action.severity,
    human_authorization_required: true,
    bot_authorization_possible: false,
  }));

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'status',
    status: 'PASS',
    observe_only: true,
    description: 'Documents and enforces the absolute human-only action list. No bot can authorize these actions.',
    escalation_path: ESCALATION_PATH,
    break_glass_actions: actions,
    summary: [
      `${AGENT} (${LABEL})`,
      `Mode: status`,
      `Break-glass action count: ${actions.length}`,
      `All require: Human Owner authorization`,
      `Bot authorization possible: false`,
    ].join('\n'),
  };
}

function buildCheckMode(actionId) {
  if (!actionId) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'check',
      status: 'FAIL',
      error: 'Missing required --action value',
      summary: `${AGENT} (${LABEL})\nMode: check\nStatus: FAIL`,
    };
  }

  const result = checkBreakGlass(actionId);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'check',
    status: 'PASS',
    ...result,
    summary: [
      `${AGENT} (${LABEL})`,
      `Mode: check`,
      `Action: ${actionId}`,
      `Is break-glass: ${result.is_break_glass}`,
      `Bot authorization possible: ${result.bot_authorization_possible}`,
      `Escalation: ${result.escalation_path}`,
    ].join('\n'),
  };
}

function buildAuditMode(actionId, requesterId) {
  if (!actionId) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'audit',
      status: 'FAIL',
      error: 'Missing required --action value',
      summary: `${AGENT} (${LABEL})\nMode: audit\nStatus: FAIL`,
    };
  }

  const result = auditBreakGlass(actionId, requesterId);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'audit',
    status: result.blocked ? 'FAIL' : 'PASS',
    ...result,
    summary: [
      `${AGENT} (${LABEL})`,
      `Mode: audit`,
      `Action: ${actionId}`,
      `Requester: ${requesterId || 'unknown'}`,
      `Blocked: ${result.blocked}`,
      `Required human approval: ${result.required_human_approval}`,
    ].join('\n'),
  };
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

  return { mode, options };
}

function buildOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);

  if (parsed.mode === 'check') {
    return buildCheckMode(parsed.options.action || '');
  }

  if (parsed.mode === 'audit') {
    return buildAuditMode(
      parsed.options.action || '',
      parsed.options.requester || '',
    );
  }

  return buildStatusMode();
}

module.exports = {
  AGENT,
  LABEL,
  BREAK_GLASS_ACTIONS,
  ESCALATION_PATH,
  isBreakGlass,
  checkBreakGlass,
  auditBreakGlass,
  buildStatusMode,
  buildCheckMode,
  buildAuditMode,
  buildOutput,
  main,
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
      error: error && error.message ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
