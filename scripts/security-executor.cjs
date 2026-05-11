#!/usr/bin/env node
/**
 * security-executor.cjs
 * Controlled execution layer under the Arbiter/Governor/Runner stack.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Security Executor v1';
const LABEL = 'CONTROLLED EXECUTION / NO REMOTE MUTATION';
const VALID_MODES = new Set(['plan', 'run-approved', 'finalize-approved']);
const PACKET_DIR = path.join('.git', 'mission-control');
const PACKET_FILE = path.join(PACKET_DIR, 'security-executor-packet.json');
const DEFAULT_VALIDATION_COMMANDS = [
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm build',
  'node scripts/security-hardening-runner.cjs verify',
  'node scripts/security-governor.cjs verify',
];
const BLOCKED_STAGE_BASENAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const TOOL_CONFIG = {
  runnerAudit: {
    script: 'scripts/security-hardening-runner.cjs',
    fnName: 'runAuditMode',
    cliMode: 'audit',
  },
  runnerVerify: {
    script: 'scripts/security-hardening-runner.cjs',
    fnName: 'runVerifyMode',
    cliMode: 'verify',
  },
  governorPlan: {
    script: 'scripts/security-governor.cjs',
    fnName: 'runPlanMode',
    cliMode: 'plan',
  },
  governorVerify: {
    script: 'scripts/security-governor.cjs',
    fnName: 'runVerifyMode',
    cliMode: 'verify',
  },
  arbiterPlan: {
    script: 'scripts/security-arbiter.cjs',
    fnName: 'runPlanMode',
    cliMode: 'plan',
  },
  arbiterReview: {
    script: 'scripts/security-arbiter.cjs',
    fnName: 'runReviewMode',
    cliMode: 'review',
  },
};

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/);
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

function runShellLine(commandLine, options = {}) {
  const result = spawnSync(commandLine, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: true,
  });

  return {
    ok: !result.error && result.status === 0,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : '',
  };
}

function parseJsonWithSummary(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Tool output was empty.');

  const separatorIndex = trimmed.indexOf('\n\n');
  const candidate = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  return JSON.parse(candidate);
}

function loadApi(rootDir, scriptPath) {
  const absolute = path.join(rootDir, scriptPath);
  if (!fs.existsSync(absolute)) return null;

  try {
    return require(absolute);
  } catch {
    return null;
  }
}

function getToolResult(rootDir, config, options = {}) {
  const api = options.api || loadApi(rootDir, config.script);
  if (api && typeof api[config.fnName] === 'function') {
    try {
      return {
        available: true,
        source: 'module',
        api,
        result: api[config.fnName](rootDir),
      };
    } catch (error) {
      return {
        available: false,
        source: 'module',
        api,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const absolute = path.join(rootDir, config.script);
  if (!fs.existsSync(absolute)) {
    return {
      available: false,
      source: 'none',
      api,
      error: `Script not found: ${config.script}`,
    };
  }

  const execution = (options.commandRunner || runCommand)(process.execPath, [absolute, config.cliMode], { cwd: rootDir });
  if (!execution.ok) {
    return {
      available: false,
      source: 'cli',
      api,
      error: execution.stderr || execution.error || `${config.script} ${config.cliMode} failed.`,
    };
  }

  try {
    return {
      available: true,
      source: 'cli',
      api,
      result: parseJsonWithSummary(execution.stdout),
    };
  } catch (error) {
    return {
      available: false,
      source: 'cli',
      api,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getCurrentBranch(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['branch', '--show-current'], { cwd: rootDir });
  return result.ok ? result.stdout.trim() : '';
}

function getWorkingTreeState(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['status', '--short'], { cwd: rootDir });
  const lines = result.ok ? splitLines(result.stdout).filter(Boolean) : [];
  return {
    ok: result.ok,
    clean: lines.length === 0,
    lines,
  };
}

function getHeadShort(rootDir, commandRunner = runCommand) {
  const result = commandRunner('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootDir });
  return result.ok ? result.stdout.trim() : '';
}

function getPacketPath(rootDir) {
  return path.join(rootDir, PACKET_FILE);
}

function saveExecutionPacket(rootDir, packet, fsApi = fs) {
  const packetPath = getPacketPath(rootDir);
  fsApi.mkdirSync(path.dirname(packetPath), { recursive: true });
  fsApi.writeFileSync(packetPath, JSON.stringify(packet, null, 2));
  return packetPath;
}

function loadExecutionPacket(rootDir, fsApi = fs) {
  const packetPath = getPacketPath(rootDir);
  if (!fsApi.existsSync(packetPath)) return null;

  try {
    return JSON.parse(fsApi.readFileSync(packetPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractSectionLines(prompt, header) {
  const lines = splitLines(prompt);
  const headerIndex = lines.findIndex((line) => line.trim().toUpperCase() === header.toUpperCase());
  if (headerIndex === -1) return [];

  const values = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      if (values.length > 0) break;
      continue;
    }
    if (/^[A-Z][A-Z /-]+:$/.test(trimmed)) break;
    values.push(trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed);
  }
  return values;
}

function extractBranchFromPrompt(prompt) {
  const branchLines = extractSectionLines(prompt, 'BRANCH:');
  const line = branchLines.find((value) => /create from updated main:/i.test(value));
  if (!line) return '';
  const match = line.match(/create from updated main:\s*(.+)$/i);
  return match ? match[1].trim() : '';
}

function getRouteFamily(filePath) {
  const normalized = normalizePath(filePath);
  const prefix = 'src/app/api/';
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  const parts = relative.split('/').filter(Boolean);
  const trimmed = parts.slice(0, -1).filter((part) => !part.startsWith('['));
  if (trimmed.length === 0) return 'unknown';
  if (trimmed[0] === 'v1' && trimmed[1]) return `v1/${trimmed[1]}`;
  return trimmed[0] || 'unknown';
}

function humanizeFamily(family) {
  return String(family || '')
    .split('/')
    .map((part) => part.replace(/-/g, ' '))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferCommitMessageFromTarget(target, approvedFiles) {
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget.startsWith('src/app/api/')) {
    return `Harden ${humanizeFamily(getRouteFamily(normalizedTarget)).toLowerCase()} workspace route`.replace(/^h/, 'H');
  }
  if ((approvedFiles || []).some((file) => normalizePath(file).startsWith('scripts/')) && (approvedFiles || []).some((file) => normalizePath(file).includes('__tests__/'))) {
    return 'Add security executor v1';
  }
  return 'Update approved scope';
}

function inferPrTitle(commitMessage) {
  return commitMessage || 'Update approved scope';
}

function inferPrBody(packet) {
  const approvedRouteFiles = (packet.approved_files || []).filter((file) => normalizePath(file).startsWith('src/app/api/'));
  const focusedTests = (packet.approved_files || []).filter((file) => normalizePath(file).includes('__tests__/'));
  const scopeLabel = approvedRouteFiles.length > 0
    ? approvedRouteFiles.map((file) => file.replace(/^src\/app\/api\//, '/api/').replace(/\/route\.ts$/, '')).join(', ')
    : 'approved local tooling scope';

  return [
    `Executes the Arbiter-approved scope for ${scopeLabel}.`,
    '',
    'Scope:',
    ...approvedRouteFiles.map((file) => `- touch ${file}`),
    ...focusedTests.map((file) => `- focused test: ${file}`),
    '',
    'Safety:',
    '- approved local scope only',
    '- no git add .',
    '- push/PR remain human-gated',
    '',
    'Validation:',
    ...(packet.validation_commands || []).map((command) => `- ${command}`),
  ].join('\n');
}

function buildPrCommands(branch, prTitle, prBody) {
  const escapedBody = prBody.replace(/"/g, '\\"');
  return {
    push_command: `git push -u origin ${branch}`,
    create_command: `gh pr create --repo niko4244/mission-control --base main --head ${branch} --title "${prTitle.replace(/"/g, '\\"')}" --body "${escapedBody}"`,
  };
}

function buildPlanPacket(arbiterPlan, governorPlan, runnerAudit) {
  const implementationPrompt = String(arbiterPlan && arbiterPlan.implementation_prompt || governorPlan && governorPlan.implementation_prompt || '');
  const approvedFiles = unique([
    ...extractSectionLines(implementationPrompt, 'EXACT ALLOWED FILES:'),
    ...((governorPlan && governorPlan.policy && governorPlan.policy.allowed_files) || []),
  ].map(normalizePath));
  const blockedFiles = unique([
    ...extractSectionLines(implementationPrompt, 'EXACT BLOCKED FILES:'),
    ...((governorPlan && governorPlan.policy && governorPlan.policy.blocked_files) || []),
  ].map(normalizePath));
  const validationCommands = unique([
    ...extractSectionLines(implementationPrompt, 'VALIDATION COMMANDS:'),
    ...DEFAULT_VALIDATION_COMMANDS,
  ]);
  const approvedBranch = extractBranchFromPrompt(implementationPrompt)
    || normalizePath(governorPlan && governorPlan.strategy && governorPlan.strategy.branch)
    || normalizePath(arbiterPlan && arbiterPlan.strategy && arbiterPlan.strategy.branch);
  const target = normalizePath(governorPlan && governorPlan.strategy && governorPlan.strategy.target)
    || normalizePath(arbiterPlan && arbiterPlan.strategy && arbiterPlan.strategy.target);
  const focusedTestPath = approvedFiles.find((file) => file.includes('__tests__')) || '';
  const commitMessage = inferCommitMessageFromTarget(target, approvedFiles);
  const prTitle = inferPrTitle(commitMessage);
  const packet = {
    target,
    branch: approvedBranch,
    risk: String(arbiterPlan && arbiterPlan.risk || governorPlan && governorPlan.strategy && governorPlan.strategy.risk || 'Unknown'),
    approved_files: approvedFiles,
    blocked_files: blockedFiles,
    implementation_prompt: implementationPrompt,
    validation_commands: validationCommands,
    focused_test_path: focusedTestPath,
    commit_message: commitMessage,
    pr_title: prTitle,
    pr_body: inferPrBody({
      approved_files: approvedFiles,
      validation_commands: validationCommands,
    }),
    arbiter_decision: String(arbiterPlan && arbiterPlan.decision || ''),
    governor_decision: String(governorPlan && governorPlan.decision || ''),
    runner_status: String(runnerAudit && runnerAudit.status || ''),
  };
  const commands = buildPrCommands(packet.branch, packet.pr_title, packet.pr_body);
  packet.push_command = commands.push_command;
  packet.create_command = commands.create_command;
  return packet;
}

function buildAuthority(runnerStatus, governorDecision, arbiterDecision, authorization = {}) {
  return {
    runner_status: runnerStatus || '',
    governor_decision: governorDecision || '',
    arbiter_decision: arbiterDecision || '',
    stage_authorized: Boolean(authorization.stage_authorized),
    commit_authorized: Boolean(authorization.commit_authorized),
    push_authorized: Boolean(authorization.push_authorized),
    pr_create_authorized: Boolean(authorization.pr_create_authorized),
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status,
    decision: data.decision,
    authority: data.authority || {
      runner_status: '',
      governor_decision: '',
      arbiter_decision: '',
      stage_authorized: false,
      commit_authorized: false,
      push_authorized: false,
      pr_create_authorized: false,
    },
    scope: data.scope || {
      branch: '',
      approved_files: [],
      blocked_files: [],
      changed_files: [],
      staged_files: [],
      untracked_files: [],
    },
    actions_taken: data.actions_taken || [],
    blocking_reasons: data.blocking_reasons || [],
    warnings: data.warnings || [],
    implementation_prompt: data.implementation_prompt || '',
    validation_commands: data.validation_commands || [],
    commit: data.commit || {
      message: '',
      hash: '',
    },
    pr: data.pr || {
      title: '',
      body: '',
      push_command: '',
      create_command: '',
    },
    human_action: data.human_action || '',
    summary: data.summary || '',
  };
}

function summarizeResult(result) {
  const lines = [
    `${AGENT} (${LABEL})`,
    `Mode: ${result.mode}`,
    `Status: ${result.status}`,
    `Decision: ${result.decision}`,
    `Approved branch: ${result.scope.branch || 'none'}`,
  ];
  if (result.blocking_reasons.length > 0) {
    lines.push(`Top blocker: ${result.blocking_reasons[0]}`);
  } else if (result.actions_taken.length > 0) {
    lines.push(`Actions taken: ${result.actions_taken.join('; ')}`);
  }
  lines.push(`Next human action: ${result.human_action}`);
  return lines.join('\n');
}

function planDecisionIsApproved(arbiterPlan) {
  return arbiterPlan
    && ['APPROVE_PLAN', 'APPROVE_WITH_NOTES'].includes(String(arbiterPlan.decision))
    && arbiterPlan.authorization
    && arbiterPlan.authorization.plan_approved === true;
}

function runPlanMode(rootDir, options = {}) {
  const runnerState = getToolResult(rootDir, TOOL_CONFIG.runnerAudit, { api: options.runnerApi, commandRunner: options.commandRunner });
  const governorState = getToolResult(rootDir, TOOL_CONFIG.governorPlan, { api: options.governorApi, commandRunner: options.commandRunner });
  const arbiterState = getToolResult(rootDir, TOOL_CONFIG.arbiterPlan, { api: options.arbiterApi, commandRunner: options.commandRunner });

  const blockingReasons = [];
  if (!runnerState.available) blockingReasons.push(runnerState.error || 'Runner audit unavailable.');
  if (!governorState.available) blockingReasons.push(governorState.error || 'Governor plan unavailable.');
  if (!arbiterState.available) blockingReasons.push(arbiterState.error || 'Arbiter plan unavailable.');

  if (blockingReasons.length > 0) {
    const result = buildOutput('plan', {
      status: 'FAIL',
      decision: 'BLOCKED',
      authority: buildAuthority('', '', '', {}),
      scope: {
        branch: '',
        approved_files: [],
        blocked_files: [],
        changed_files: [],
        staged_files: [],
        untracked_files: [],
      },
      actions_taken: [],
      blocking_reasons: blockingReasons,
      warnings: [],
      implementation_prompt: '',
      validation_commands: [],
      commit: { message: '', hash: '' },
      pr: { title: '', body: '', push_command: '', create_command: '' },
      human_action: 'Do not execute anything. Repair the missing Runner/Governor/Arbiter inputs first.',
    });
    result.summary = summarizeResult(result);
    return result;
  }

  if (!planDecisionIsApproved(arbiterState.result)) {
    const result = buildOutput('plan', {
      status: arbiterState.result.status === 'FAIL' ? 'FAIL' : 'WARN',
      decision: 'BLOCKED',
      authority: buildAuthority(
        runnerState.result.status,
        governorState.result.decision,
        arbiterState.result.decision,
        arbiterState.result.authorization,
      ),
      scope: {
        branch: '',
        approved_files: [],
        blocked_files: [],
        changed_files: [],
        staged_files: [],
        untracked_files: [],
      },
      actions_taken: [],
      blocking_reasons: [`Arbiter plan decision ${arbiterState.result.decision} does not authorize execution.`],
      warnings: [],
      implementation_prompt: '',
      validation_commands: [],
      commit: { message: '', hash: '' },
      pr: { title: '', body: '', push_command: '', create_command: '' },
      human_action: 'Do not execute the plan. Wait for an Arbiter-approved plan first.',
    });
    result.summary = summarizeResult(result);
    return result;
  }

  const packet = buildPlanPacket(arbiterState.result, governorState.result, runnerState.result);
  const warnings = [];
  const status = arbiterState.result.status === 'WARN' ? 'WARN' : 'PASS';
  if (arbiterState.result.findings && Array.isArray(arbiterState.result.findings.major)) {
    warnings.push(...arbiterState.result.findings.major);
  }
  if (arbiterState.result.findings && Array.isArray(arbiterState.result.findings.minor)) {
    warnings.push(...arbiterState.result.findings.minor);
  }

  const result = buildOutput('plan', {
    status,
    decision: 'READY_TO_EXECUTE',
    authority: buildAuthority(
      runnerState.result.status,
      governorState.result.decision,
      arbiterState.result.decision,
      arbiterState.result.authorization,
    ),
    scope: {
      branch: packet.branch,
      approved_files: packet.approved_files,
      blocked_files: packet.blocked_files,
      changed_files: [],
      staged_files: [],
      untracked_files: [],
    },
    actions_taken: [],
    blocking_reasons: [],
    warnings: unique(warnings),
    implementation_prompt: packet.implementation_prompt,
    validation_commands: packet.validation_commands,
    commit: {
      message: packet.commit_message,
      hash: '',
    },
    pr: {
      title: packet.pr_title,
      body: packet.pr_body,
      push_command: packet.push_command,
      create_command: packet.create_command,
    },
    human_action: 'Run node scripts/security-executor.cjs run-approved to prepare the approved branch and local execution packet.',
  });
  result.summary = summarizeResult(result);
  return result;
}

function localBranchExists(rootDir, branch, commandRunner = runCommand) {
  const result = commandRunner('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: rootDir });
  return result.ok;
}

function checkoutApprovedBranch(rootDir, branch, commandRunner = runCommand) {
  const currentBranch = getCurrentBranch(rootDir, commandRunner);
  if (currentBranch === branch) {
    return {
      ok: true,
      action: 'already_on_branch',
      branch,
      command: '',
    };
  }

  if (localBranchExists(rootDir, branch, commandRunner)) {
    const checkout = commandRunner('git', ['checkout', branch], { cwd: rootDir });
    return {
      ok: checkout.ok,
      action: 'checked_out_existing_branch',
      branch,
      command: `git checkout ${branch}`,
      error: checkout.stderr || checkout.error || '',
    };
  }

  const create = commandRunner('git', ['checkout', '-b', branch], { cwd: rootDir });
  return {
    ok: create.ok,
    action: 'created_branch',
    branch,
    command: `git checkout -b ${branch}`,
    error: create.stderr || create.error || '',
  };
}

function runRunApprovedMode(rootDir, options = {}) {
  const planResult = runPlanMode(rootDir, options);
  if (planResult.decision !== 'READY_TO_EXECUTE') {
    const blocked = buildOutput('run-approved', {
      status: planResult.status === 'PASS' ? 'WARN' : planResult.status,
      decision: 'BLOCKED',
      authority: planResult.authority,
      scope: planResult.scope,
      actions_taken: [],
      blocking_reasons: planResult.blocking_reasons.length > 0 ? planResult.blocking_reasons : ['No Arbiter-approved execution packet is ready.'],
      warnings: planResult.warnings,
      implementation_prompt: planResult.implementation_prompt,
      validation_commands: planResult.validation_commands,
      commit: planResult.commit,
      pr: planResult.pr,
      human_action: 'Do not create a branch or hand off implementation until the plan is READY_TO_EXECUTE.',
    });
    blocked.summary = summarizeResult(blocked);
    return blocked;
  }

  const tree = getWorkingTreeState(rootDir, options.commandRunner || runCommand);
  const currentBranch = getCurrentBranch(rootDir, options.commandRunner || runCommand);
  const blockingReasons = [];
  const warnings = [...planResult.warnings];

  if (!tree.ok) {
    blockingReasons.push('Unable to read git working tree state.');
  } else if (!tree.clean) {
    blockingReasons.push('Working tree must be clean before preparing the approved branch.');
  }

  if (currentBranch && currentBranch !== 'main' && currentBranch !== planResult.scope.branch) {
    blockingReasons.push(`run-approved expects main or the approved branch, but found ${currentBranch}.`);
  }

  if (blockingReasons.length > 0) {
    const blocked = buildOutput('run-approved', {
      status: 'FAIL',
      decision: 'BLOCKED',
      authority: planResult.authority,
      scope: planResult.scope,
      actions_taken: [],
      blocking_reasons: blockingReasons,
      warnings,
      implementation_prompt: planResult.implementation_prompt,
      validation_commands: planResult.validation_commands,
      commit: planResult.commit,
      pr: planResult.pr,
      human_action: 'Clean the working tree on main, then rerun run-approved.',
    });
    blocked.summary = summarizeResult(blocked);
    return blocked;
  }

  const packet = {
    branch: planResult.scope.branch,
    approved_files: planResult.scope.approved_files,
    blocked_files: planResult.scope.blocked_files,
    implementation_prompt: planResult.implementation_prompt,
    validation_commands: planResult.validation_commands,
    focused_test_path: planResult.scope.approved_files.find((file) => file.includes('__tests__')) || '',
    commit_message: planResult.commit.message,
    pr_title: planResult.pr.title,
    pr_body: planResult.pr.body,
    push_command: planResult.pr.push_command,
    create_command: planResult.pr.create_command,
    created_at: new Date().toISOString(),
  };

  const branchResult = checkoutApprovedBranch(rootDir, packet.branch, options.commandRunner || runCommand);
  if (!branchResult.ok) {
    const blocked = buildOutput('run-approved', {
      status: 'FAIL',
      decision: 'BLOCKED',
      authority: planResult.authority,
      scope: planResult.scope,
      actions_taken: [],
      blocking_reasons: [branchResult.error || `Failed to check out approved branch ${packet.branch}.`],
      warnings,
      implementation_prompt: planResult.implementation_prompt,
      validation_commands: planResult.validation_commands,
      commit: planResult.commit,
      pr: planResult.pr,
      human_action: 'Repair the local git branch state before trying run-approved again.',
    });
    blocked.summary = summarizeResult(blocked);
    return blocked;
  }

  const packetPath = saveExecutionPacket(rootDir, packet, options.fsApi || fs);
  const actionsTaken = [];
  if (branchResult.command) actionsTaken.push(branchResult.command);
  actionsTaken.push(`saved execution packet to ${normalizePath(path.relative(rootDir, packetPath))}`);

  const result = buildOutput('run-approved', {
    status: planResult.status === 'WARN' ? 'WARN' : 'PASS',
    decision: 'READY_FOR_IMPLEMENTER',
    authority: planResult.authority,
    scope: {
      ...planResult.scope,
      changed_files: [],
      staged_files: [],
      untracked_files: [],
    },
    actions_taken: actionsTaken,
    blocking_reasons: [],
    warnings,
    implementation_prompt: planResult.implementation_prompt,
    validation_commands: planResult.validation_commands,
    commit: planResult.commit,
    pr: planResult.pr,
    human_action: 'Execute the approved implementation prompt on the prepared branch. Do not stage, commit, push, or create a PR yet.',
  });
  result.summary = summarizeResult(result);
  return result;
}

function gatherFinalizeInputs(rootDir, options = {}) {
  const runnerState = getToolResult(rootDir, TOOL_CONFIG.runnerVerify, { api: options.runnerApi, commandRunner: options.commandRunner });
  const governorState = getToolResult(rootDir, TOOL_CONFIG.governorVerify, { api: options.governorApi, commandRunner: options.commandRunner });
  const arbiterState = getToolResult(rootDir, TOOL_CONFIG.arbiterReview, { api: options.arbiterApi, commandRunner: options.commandRunner });
  return {
    runnerState,
    governorState,
    arbiterState,
  };
}

function evaluateFinalizeState(packet, inputs, currentBranch) {
  const blockingReasons = [];
  const warnings = [];
  const runnerVerify = inputs.runnerState.result;
  const governorVerify = inputs.governorState.result;
  const arbiterReview = inputs.arbiterState.result;

  if (!packet) blockingReasons.push('No approved execution packet was found. Run run-approved first.');
  if (!inputs.runnerState.available) blockingReasons.push(inputs.runnerState.error || 'Runner verify unavailable.');
  if (!inputs.governorState.available) blockingReasons.push(inputs.governorState.error || 'Governor verify unavailable.');
  if (!inputs.arbiterState.available) blockingReasons.push(inputs.arbiterState.error || 'Arbiter review unavailable.');

  if (blockingReasons.length > 0) {
    return {
      status: 'FAIL',
      decision: 'BLOCKED',
      blocking_reasons: unique(blockingReasons),
      warnings,
      should_stage: false,
      stage_files: [],
      should_commit: false,
      commit_message: '',
      scope: {
        branch: packet ? packet.branch : '',
        approved_files: packet ? packet.approved_files : [],
        blocked_files: packet ? packet.blocked_files : [],
        changed_files: [],
        staged_files: [],
        untracked_files: [],
      },
      authority: buildAuthority('', '', '', {}),
      human_action: 'Do not stage or commit. Prepare an approved execution packet and healthy review inputs first.',
    };
  }

  const changedFiles = unique(runnerVerify.verify.changed_files || []);
  const stagedFiles = unique(runnerVerify.verify.staged_files || []);
  const untrackedFiles = unique(runnerVerify.verify.untracked_files || []);
  const approvedFiles = unique((packet.approved_files || []).map(normalizePath));
  const blockedFiles = unique((packet.blocked_files || []).map(normalizePath));
  const outsideScope = changedFiles.filter((file) => !approvedFiles.includes(normalizePath(file)));

  if (currentBranch && packet.branch && currentBranch !== packet.branch) {
    blockingReasons.push(`Current branch ${currentBranch} does not match the approved branch ${packet.branch}.`);
  }
  if (runnerVerify.status === 'FAIL') {
    blockingReasons.push('Runner verify returned FAIL.');
  }
  if ((runnerVerify.verify.blocking_conditions || []).length > 0) {
    blockingReasons.push(...runnerVerify.verify.blocking_conditions);
  }
  if (!['APPROVE_STAGE', 'APPROVE_COMMIT', 'NO_CHANGES'].includes(String(governorVerify.decision))) {
    blockingReasons.push(`Governor decision ${governorVerify.decision} does not allow finalize-approved to continue.`);
  }
  if (!['APPROVE', 'APPROVE_WITH_NOTES'].includes(String(arbiterReview.decision))) {
    blockingReasons.push(`Arbiter decision ${arbiterReview.decision} does not authorize finalize-approved.`);
  }
  if (!arbiterReview.authorization || arbiterReview.authorization.stage_authorized !== true) {
    if (changedFiles.length > 0) blockingReasons.push('Arbiter has not authorized staging for the current changes.');
  }
  if (!arbiterReview.authorization || arbiterReview.authorization.commit_authorized !== true) {
    if (stagedFiles.length > 0 || changedFiles.length > 0) blockingReasons.push('Arbiter has not authorized commit for the current changes.');
  }
  if (outsideScope.length > 0) {
    blockingReasons.push(`Changed files fall outside the approved scope: ${outsideScope.join(', ')}`);
  }
  if (changedFiles.some((file) => BLOCKED_STAGE_BASENAMES.has(path.posix.basename(normalizePath(file))))) {
    blockingReasons.push('Package or lockfile drift is not allowed in finalize-approved.');
  }
  if (runnerVerify.verify.fallback_regression && runnerVerify.verify.fallback_regression.passed === false) {
    blockingReasons.push('Fallback regression still failed.');
  }
  if (untrackedFiles.some((file) => file.includes('__tests__')) && (!arbiterReview.authorization || arbiterReview.authorization.stage_authorized !== true)) {
    blockingReasons.push('Untracked intended test files exist and stage is not authorized.');
  }

  const authority = buildAuthority(
    runnerVerify.status,
    governorVerify.decision,
    arbiterReview.decision,
    arbiterReview.authorization,
  );

  if (blockingReasons.length > 0) {
    return {
      status: 'FAIL',
      decision: 'BLOCKED',
      blocking_reasons: unique(blockingReasons),
      warnings,
      should_stage: false,
      stage_files: [],
      should_commit: false,
      commit_message: '',
      scope: {
        branch: packet.branch,
        approved_files: approvedFiles,
        blocked_files: blockedFiles,
        changed_files: changedFiles,
        staged_files: stagedFiles,
        untracked_files: untrackedFiles,
      },
      authority,
      human_action: 'Do not continue. Resolve the verification blockers before any staging or commit action.',
    };
  }

  if (changedFiles.length === 0 && runnerVerify.repo && runnerVerify.repo.working_tree_clean) {
    return {
      status: arbiterReview.status === 'WARN' || governorVerify.status === 'WARN' ? 'WARN' : 'PASS',
      decision: 'APPROVED_COMMITTED_READY_FOR_PR',
      blocking_reasons: [],
      warnings: unique([
        ...warnings,
        ...(governorVerify.policy && governorVerify.policy.warnings || []),
        ...(arbiterReview.findings && arbiterReview.findings.advisory || []),
      ]),
      should_stage: false,
      stage_files: [],
      should_commit: false,
      commit_message: packet.commit_message,
      scope: {
        branch: packet.branch,
        approved_files: approvedFiles,
        blocked_files: blockedFiles,
        changed_files: [],
        staged_files: [],
        untracked_files: [],
      },
      authority,
      human_action: 'Approve push/PR manually if desired. The branch is already committed and clean.',
    };
  }

  const unstagedOrUntracked = changedFiles.filter((file) => !stagedFiles.includes(file));
  if (unstagedOrUntracked.length > 0 && arbiterReview.authorization.stage_authorized === true) {
    const stageFiles = unstagedOrUntracked.filter((file) => !BLOCKED_STAGE_BASENAMES.has(path.posix.basename(normalizePath(file))));
    return {
      status: arbiterReview.status === 'WARN' || governorVerify.status === 'WARN' ? 'WARN' : 'PASS',
      decision: 'READY_TO_EXECUTE',
      blocking_reasons: [],
      warnings,
      should_stage: true,
      stage_files: stageFiles,
      should_commit: false,
      commit_message: packet.commit_message,
      scope: {
        branch: packet.branch,
        approved_files: approvedFiles,
        blocked_files: blockedFiles,
        changed_files: changedFiles,
        staged_files: stagedFiles,
        untracked_files: untrackedFiles,
      },
      authority,
      human_action: 'Stage only the approved files, rerun verification, and commit only if authorization still holds.',
    };
  }

  if (stagedFiles.length > 0 && arbiterReview.authorization.commit_authorized === true && governorVerify.decision === 'APPROVE_COMMIT') {
    return {
      status: arbiterReview.status === 'WARN' || governorVerify.status === 'WARN' ? 'WARN' : 'PASS',
      decision: 'READY_TO_EXECUTE',
      blocking_reasons: [],
      warnings,
      should_stage: false,
      stage_files: [],
      should_commit: true,
      commit_message: packet.commit_message || governorVerify.verify_decision.commit_message || '',
      scope: {
        branch: packet.branch,
        approved_files: approvedFiles,
        blocked_files: blockedFiles,
        changed_files: changedFiles,
        staged_files: stagedFiles,
        untracked_files: untrackedFiles,
      },
      authority,
      human_action: 'Commit the staged approved files, then stop before push or PR creation.',
    };
  }

  return {
    status: 'WARN',
    decision: 'NO_ACTION',
    blocking_reasons: [],
    warnings: unique([...warnings, 'No executor action was needed for the current branch state.']),
    should_stage: false,
    stage_files: [],
    should_commit: false,
    commit_message: packet.commit_message,
    scope: {
      branch: packet.branch,
      approved_files: approvedFiles,
      blocked_files: blockedFiles,
      changed_files: changedFiles,
      staged_files: stagedFiles,
      untracked_files: untrackedFiles,
    },
    authority,
    human_action: 'No local execution action was taken. Review the branch state manually if this was unexpected.',
  };
}

function stageExactFiles(rootDir, files, commandRunner = runCommand) {
  const stageable = unique((files || []).map(normalizePath)).filter((file) => !BLOCKED_STAGE_BASENAMES.has(path.posix.basename(file)));
  if (stageable.length === 0) {
    return { ok: true, files: [], command: '' };
  }
  const result = commandRunner('git', ['add', '--', ...stageable], { cwd: rootDir });
  return {
    ok: result.ok,
    files: stageable,
    command: `git add ${stageable.join(' ')}`,
    error: result.stderr || result.error || '',
  };
}

function commitApprovedFiles(rootDir, message, commandRunner = runCommand) {
  const result = commandRunner('git', ['commit', '-m', message], { cwd: rootDir });
  return {
    ok: result.ok,
    command: `git commit -m "${message.replace(/"/g, '\\"')}"`,
    error: result.stderr || result.error || '',
  };
}

function rerunFocusedTest(rootDir, packet, shellRunner = runShellLine) {
  const command = (packet.validation_commands || []).find((line) => /^pnpm test -- /i.test(line))
    || (packet.focused_test_path ? `pnpm test -- ${packet.focused_test_path}` : '');
  if (!command) {
    return { ok: true, command: '', skipped: true };
  }

  const result = shellRunner(command, { cwd: rootDir });
  return {
    ok: result.ok,
    command,
    skipped: false,
    error: result.stderr || result.error || '',
  };
}

function runFinalizeApprovedMode(rootDir, options = {}) {
  const packet = loadExecutionPacket(rootDir, options.fsApi || fs);
  const currentBranch = getCurrentBranch(rootDir, options.commandRunner || runCommand);
  let inputs = gatherFinalizeInputs(rootDir, options);
  let evaluated = evaluateFinalizeState(packet, inputs, currentBranch);
  const actionsTaken = [];

  if (!packet) {
    const blocked = buildOutput('finalize-approved', {
      status: evaluated.status,
      decision: evaluated.decision,
      authority: evaluated.authority,
      scope: evaluated.scope,
      actions_taken: actionsTaken,
      blocking_reasons: evaluated.blocking_reasons,
      warnings: evaluated.warnings,
      implementation_prompt: '',
      validation_commands: [],
      commit: { message: '', hash: '' },
      pr: { title: '', body: '', push_command: '', create_command: '' },
      human_action: evaluated.human_action,
    });
    blocked.summary = summarizeResult(blocked);
    return blocked;
  }

  if (evaluated.decision === 'BLOCKED' || evaluated.decision === 'NO_ACTION' || evaluated.decision === 'APPROVED_COMMITTED_READY_FOR_PR') {
    const ready = buildOutput('finalize-approved', {
      status: evaluated.status,
      decision: evaluated.decision,
      authority: evaluated.authority,
      scope: evaluated.scope,
      actions_taken: actionsTaken,
      blocking_reasons: evaluated.blocking_reasons,
      warnings: evaluated.warnings,
      implementation_prompt: packet.implementation_prompt,
      validation_commands: packet.validation_commands,
      commit: {
        message: packet.commit_message,
        hash: evaluated.decision === 'APPROVED_COMMITTED_READY_FOR_PR' ? getHeadShort(rootDir, options.commandRunner || runCommand) : '',
      },
      pr: {
        title: packet.pr_title,
        body: packet.pr_body,
        push_command: packet.push_command,
        create_command: packet.create_command,
      },
      human_action: evaluated.human_action,
    });
    ready.summary = summarizeResult(ready);
    return ready;
  }

  if (evaluated.should_stage) {
    const staged = stageExactFiles(rootDir, evaluated.stage_files, options.commandRunner || runCommand);
    if (!staged.ok) {
      const blocked = buildOutput('finalize-approved', {
        status: 'FAIL',
        decision: 'BLOCKED',
        authority: evaluated.authority,
        scope: evaluated.scope,
        actions_taken: actionsTaken,
        blocking_reasons: [staged.error || 'Failed to stage the approved files.'],
        warnings: evaluated.warnings,
        implementation_prompt: packet.implementation_prompt,
        validation_commands: packet.validation_commands,
        commit: { message: packet.commit_message, hash: '' },
        pr: {
          title: packet.pr_title,
          body: packet.pr_body,
          push_command: packet.push_command,
          create_command: packet.create_command,
        },
        human_action: 'Resolve the staging failure before trying finalize-approved again.',
      });
      blocked.summary = summarizeResult(blocked);
      return blocked;
    }
    if (staged.command) actionsTaken.push(staged.command);
    inputs = gatherFinalizeInputs(rootDir, options);
    evaluated = evaluateFinalizeState(packet, inputs, currentBranch);
  }

  if (evaluated.decision === 'BLOCKED' || evaluated.should_commit === false) {
    const output = buildOutput('finalize-approved', {
      status: evaluated.status,
      decision: evaluated.decision === 'BLOCKED' ? 'BLOCKED' : 'NO_ACTION',
      authority: evaluated.authority,
      scope: evaluated.scope,
      actions_taken: actionsTaken,
      blocking_reasons: evaluated.blocking_reasons,
      warnings: evaluated.warnings,
      implementation_prompt: packet.implementation_prompt,
      validation_commands: packet.validation_commands,
      commit: { message: packet.commit_message, hash: '' },
      pr: {
        title: packet.pr_title,
        body: packet.pr_body,
        push_command: packet.push_command,
        create_command: packet.create_command,
      },
      human_action: evaluated.human_action,
    });
    output.summary = summarizeResult(output);
    return output;
  }

  const commitResult = commitApprovedFiles(rootDir, evaluated.commit_message || packet.commit_message, options.commandRunner || runCommand);
  if (!commitResult.ok) {
    const blocked = buildOutput('finalize-approved', {
      status: 'FAIL',
      decision: 'BLOCKED',
      authority: evaluated.authority,
      scope: evaluated.scope,
      actions_taken: actionsTaken,
      blocking_reasons: [commitResult.error || 'Failed to create the approved commit.'],
      warnings: evaluated.warnings,
      implementation_prompt: packet.implementation_prompt,
      validation_commands: packet.validation_commands,
      commit: { message: evaluated.commit_message || packet.commit_message, hash: '' },
      pr: {
        title: packet.pr_title,
        body: packet.pr_body,
        push_command: packet.push_command,
        create_command: packet.create_command,
      },
      human_action: 'Resolve the commit failure before running finalize-approved again.',
    });
    blocked.summary = summarizeResult(blocked);
    return blocked;
  }
  actionsTaken.push(commitResult.command);

  const focusedTest = rerunFocusedTest(rootDir, packet, options.shellRunner || runShellLine);
  if (!focusedTest.ok) {
    const blocked = buildOutput('finalize-approved', {
      status: 'FAIL',
      decision: 'BLOCKED',
      authority: evaluated.authority,
      scope: evaluated.scope,
      actions_taken: actionsTaken.concat(focusedTest.command ? [focusedTest.command] : []),
      blocking_reasons: [focusedTest.error || 'Focused test rerun failed after commit.'],
      warnings: evaluated.warnings,
      implementation_prompt: packet.implementation_prompt,
      validation_commands: packet.validation_commands,
      commit: { message: evaluated.commit_message || packet.commit_message, hash: getHeadShort(rootDir, options.commandRunner || runCommand) },
      pr: {
        title: packet.pr_title,
        body: packet.pr_body,
        push_command: packet.push_command,
        create_command: packet.create_command,
      },
      human_action: 'Investigate the focused test failure before any push or PR step.',
    });
    blocked.summary = summarizeResult(blocked);
    return blocked;
  }
  if (focusedTest.command) actionsTaken.push(focusedTest.command);

  inputs = gatherFinalizeInputs(rootDir, options);
  const postCommit = evaluateFinalizeState(packet, inputs, currentBranch);
  const commitHash = getHeadShort(rootDir, options.commandRunner || runCommand);
  const result = buildOutput('finalize-approved', {
    status: postCommit.status,
    decision: 'APPROVED_COMMITTED_READY_FOR_PR',
    authority: postCommit.authority,
    scope: postCommit.scope,
    actions_taken: actionsTaken,
    blocking_reasons: postCommit.blocking_reasons,
    warnings: postCommit.warnings,
    implementation_prompt: packet.implementation_prompt,
    validation_commands: packet.validation_commands,
    commit: {
      message: evaluated.commit_message || packet.commit_message,
      hash: commitHash,
    },
    pr: {
      title: packet.pr_title,
      body: packet.pr_body,
      push_command: packet.push_command,
      create_command: packet.create_command,
    },
    human_action: 'Approve push/PR if desired. The Executor stops before any remote mutation in v1.',
  });
  result.summary = summarizeResult(result);
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2)) {
  const mode = VALID_MODES.has(String(argv[0] || '').toLowerCase())
    ? String(argv[0]).toLowerCase()
    : 'plan';
  const rootDir = path.resolve(__dirname, '..');

  if (!fs.existsSync(rootDir)) {
    throw new Error(`Repository root not found: ${rootDir}`);
  }

  if (mode === 'run-approved') {
    return runRunApprovedMode(rootDir);
  }
  if (mode === 'finalize-approved') {
    return runFinalizeApprovedMode(rootDir);
  }
  return runPlanMode(rootDir);
}

module.exports = {
  AGENT,
  LABEL,
  PACKET_FILE,
  TOOL_CONFIG,
  BLOCKED_STAGE_BASENAMES,
  buildAuthority,
  buildOutput,
  buildPlanPacket,
  buildPrCommands,
  checkoutApprovedBranch,
  evaluateFinalizeState,
  extractBranchFromPrompt,
  extractSectionLines,
  formatOutput,
  getCurrentBranch,
  getPacketPath,
  getToolResult,
  getWorkingTreeState,
  inferCommitMessageFromTarget,
  inferPrBody,
  loadApi,
  loadExecutionPacket,
  main,
  parseJsonWithSummary,
  rerunFocusedTest,
  runCommand,
  runFinalizeApprovedMode,
  runPlanMode,
  runRunApprovedMode,
  runShellLine,
  saveExecutionPacket,
  stageExactFiles,
  summarizeResult,
};

if (require.main === module) {
  const result = main();
  process.stdout.write(formatOutput(result));
}
