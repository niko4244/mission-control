#!/usr/bin/env node
/**
 * mission-control-verification.cjs
 * Minimal verification guard for completed Mission Control runs.
 */

'use strict';

const KNOWN_RUN_STATUSES = new Set(['OK', 'PASS', 'WARN', 'FAIL']);
const KNOWN_VALIDATION_STATUSES = new Set(['PASS', 'FAIL', 'NOT_RUN']);

function getValueAtPath(target, fieldPath) {
  return String(fieldPath || '')
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => (value == null ? undefined : value[key]), target);
}

function normalizeRunStatus(status) {
  if (typeof status !== 'string') return 'UNKNOWN';
  const upper = status.toUpperCase();
  if (upper === 'PASS') return 'OK';
  if (upper === 'OK' || upper === 'WARN' || upper === 'FAIL') return upper;
  return upper;
}

function normalizeValidationStatus(step) {
  if (!step || typeof step !== 'object') return 'UNKNOWN';

  if (typeof step.status === 'string') {
    return step.status.toUpperCase();
  }

  if (step.skipped === true) return 'NOT_RUN';
  if (step.passed === true) return 'PASS';
  if (step.passed === false) return 'FAIL';

  return 'UNKNOWN';
}

function collectValidationChecks(output) {
  const steps = Array.isArray(output && output.validation && output.validation.steps)
    ? output.validation.steps
    : Array.isArray(output && output.validation && output.validation.commands)
      ? output.validation.commands
      : [];

  return steps.map((step, index) => ({
    name: step.step || step.name || step.command || `validation-${index + 1}`,
    status: normalizeValidationStatus(step),
  }));
}

function pushUnique(values, nextValue) {
  if (nextValue && !values.includes(nextValue)) {
    values.push(nextValue);
  }
}

function verifyCompletedRun(output, options = {}) {
  const checks = [];
  const failures = [];
  const warnings = [];
  const next_actions = [];
  const requiredFields = Array.isArray(options.requiredFields)
    ? options.requiredFields
    : ['status', 'risk_level'];
  const requiredValidationCommands = Array.isArray(options.requiredValidationCommands)
    ? options.requiredValidationCommands
    : [];

  const addCheck = (name, status, message) => {
    checks.push({ name, status, message });
  };

  for (const field of requiredFields) {
    if (getValueAtPath(output, field) === undefined) {
      const message = `Missing required field: ${field}`;
      failures.push(message);
      pushUnique(next_actions, `Populate required output field: ${field}`);
      addCheck(`schema:${field}`, 'FAIL', message);
    } else {
      addCheck(`schema:${field}`, 'PASS', `${field} present`);
    }
  }

  const rawStatus = typeof (output && output.status) === 'string'
    ? output.status.toUpperCase()
    : null;

  if (!rawStatus) {
    const message = 'Missing status value';
    failures.push(message);
    pushUnique(next_actions, 'Return a recognized status value: OK, PASS, WARN, or FAIL');
    addCheck('status:value', 'FAIL', message);
  } else if (!KNOWN_RUN_STATUSES.has(rawStatus)) {
    const message = `Unknown status value: ${rawStatus}`;
    failures.push(message);
    pushUnique(next_actions, 'Return a recognized status value: OK, PASS, WARN, or FAIL');
    addCheck('status:value', 'FAIL', message);
  } else {
    addCheck('status:value', 'PASS', `Recognized status: ${rawStatus}`);
  }

  const validationChecks = collectValidationChecks(output);
  const validationByName = new Map(validationChecks.map((check) => [check.name, check.status]));

  for (const requiredCommand of requiredValidationCommands) {
    const commandStatus = validationByName.get(requiredCommand);

    if (!commandStatus) {
      const message = `Missing validation command result: ${requiredCommand}`;
      failures.push(message);
      pushUnique(next_actions, `Record validation outcome for ${requiredCommand}, or mark it NOT_RUN`);
      addCheck(`validation:${requiredCommand}`, 'FAIL', message);
      continue;
    }

    if (commandStatus === 'FAIL') {
      const message = `Validation command failed: ${requiredCommand}`;
      failures.push(message);
      pushUnique(next_actions, `Fix or rerun validation command: ${requiredCommand}`);
      addCheck(`validation:${requiredCommand}`, 'FAIL', message);
      continue;
    }

    if (commandStatus === 'NOT_RUN') {
      const message = `Validation command not run: ${requiredCommand}`;
      warnings.push(message);
      pushUnique(next_actions, `Run validation command when possible: ${requiredCommand}`);
      addCheck(`validation:${requiredCommand}`, 'WARN', message);
      continue;
    }

    if (!KNOWN_VALIDATION_STATUSES.has(commandStatus)) {
      const message = `Unknown validation status for ${requiredCommand}: ${commandStatus}`;
      failures.push(message);
      pushUnique(next_actions, `Normalize validation status for ${requiredCommand}`);
      addCheck(`validation:${requiredCommand}`, 'FAIL', message);
      continue;
    }

    addCheck(`validation:${requiredCommand}`, 'PASS', `Validation recorded: ${requiredCommand}`);
  }

  for (const validationCheck of validationChecks) {
    if (requiredValidationCommands.includes(validationCheck.name)) {
      continue;
    }

    if (validationCheck.status === 'FAIL') {
      const message = `Validation command failed: ${validationCheck.name}`;
      failures.push(message);
      pushUnique(next_actions, `Fix or rerun validation command: ${validationCheck.name}`);
      addCheck(`validation:${validationCheck.name}`, 'FAIL', message);
      continue;
    }

    if (validationCheck.status === 'NOT_RUN') {
      const message = `Validation command not run: ${validationCheck.name}`;
      warnings.push(message);
      pushUnique(next_actions, `Run validation command when possible: ${validationCheck.name}`);
      addCheck(`validation:${validationCheck.name}`, 'WARN', message);
      continue;
    }

    if (!KNOWN_VALIDATION_STATUSES.has(validationCheck.status)) {
      const message = `Unknown validation status for ${validationCheck.name}: ${validationCheck.status}`;
      failures.push(message);
      pushUnique(next_actions, `Normalize validation status for ${validationCheck.name}`);
      addCheck(`validation:${validationCheck.name}`, 'FAIL', message);
      continue;
    }
  }

  if (output && output.git) {
    if (output.git.is_clean === false && options.allowDirtyGit !== true) {
      const message = 'Working tree is dirty';
      warnings.push(message);
      pushUnique(next_actions, 'Review or explicitly allow the dirty working tree before reporting completion');
      addCheck('git:is_clean', 'WARN', message);
    } else if (typeof output.git.is_clean === 'boolean') {
      addCheck('git:is_clean', 'PASS', output.git.is_clean ? 'Working tree is clean' : 'Dirty working tree explicitly allowed');
    }
  }

  const status = failures.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';
  const risk_level = failures.length > 0 ? 3 : warnings.length > 0 ? 1 : 0;

  return {
    status,
    risk_level,
    checks,
    failures,
    warnings,
    next_actions,
  };
}

module.exports = {
  normalizeRunStatus,
  verifyCompletedRun,
};
