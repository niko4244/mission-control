#!/usr/bin/env node
/**
 * validation-gate.cjs
 * Observe-only validation enforcer for Mission Control governance layer.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Validation Gate v1';
const LABEL = 'OBSERVE ONLY / VALIDATION ENFORCER';
const VALID_MODES = new Set(['status', 'check', 'enforce']);
const POLICY_FILE = path.join('config', 'mission-control-policy.json');

// Risk classes that require explicit arbiter override (no autonomous bypass)
const HIGH_RISK_CLASSES = new Set(['Critical', 'High']);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadPolicy(rootDir) {
  return readJsonFile(path.join(rootDir, POLICY_FILE));
}

function loadPackageJson(rootDir) {
  return readJsonFile(path.join(rootDir, 'package.json'));
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
    const key = current.slice(2).replace(/-/g, '_');
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

function getRequiredSteps(policy, riskClass) {
  const rv = policy && policy.required_validation ? policy.required_validation : {};
  return Array.isArray(rv[riskClass]) ? rv[riskClass].slice() : [];
}

function getPackageScripts(packageJson) {
  return packageJson && packageJson.scripts
    ? Object.keys(packageJson.scripts)
    : [];
}

/**
 * checkValidationGate: For a given riskClass, returns what steps are required
 * and which are present in package.json scripts.
 */
function checkValidationGate(riskClass, arbiterOverride, policy, packageJson) {
  const required = getRequiredSteps(policy, riskClass);
  const available = getPackageScripts(packageJson);

  // For each required step, check if a matching script name exists.
  // We do a loose match: step name as a package.json script key substring
  const presentSteps = required.filter((step) => {
    // Normalize both sides: remove spaces, hyphens, underscores for comparison
    const normalized = step.toLowerCase().replace(/[-_\s]+/g, '');
    return available.some((scriptKey) => {
      const sk = scriptKey.toLowerCase().replace(/[-_\s]+/g, '');
      return sk === normalized || sk.includes(normalized) || normalized.includes(sk);
    });
  });

  const missingSteps = required.filter((step) => !presentSteps.includes(step));

  // Gate is closed if any required step is missing from package.json
  // AND also closed if it's a high-risk class without arbiter override
  const hasAllSteps = missingSteps.length === 0;
  const needsOverride = HIGH_RISK_CLASSES.has(riskClass) && !arbiterOverride;

  let gate_open;
  if (!hasAllSteps) {
    gate_open = false;
  } else if (needsOverride) {
    gate_open = false;
  } else {
    gate_open = true;
  }

  return {
    risk_class: riskClass,
    required_steps: required,
    present_in_package_json: presentSteps,
    missing_from_package_json: missingSteps,
    arbiter_override: arbiterOverride || null,
    gate_open,
    reason: !hasAllSteps
      ? `Required validation steps missing from package.json: ${missingSteps.join(', ')}`
      : needsOverride
        ? 'High-risk class requires Chief Arbiter override to open gate'
        : 'All required validation steps present',
  };
}

/**
 * enforceGate: Check if the steps_passed set satisfies policy requirements.
 */
function enforceGate(riskClass, stepsPassed, policy) {
  const required = getRequiredSteps(policy, riskClass);
  const passed = Array.isArray(stepsPassed) ? stepsPassed.slice() : [];

  // Match each required step against passed steps (normalized comparison)
  const missing = required.filter((req) => {
    const normalizedReq = req.toLowerCase().replace(/\s+/g, '');
    return !passed.some((p) => {
      const normalizedP = String(p).toLowerCase().replace(/[-_\s]/g, '');
      return normalizedP === normalizedReq
        || normalizedP.includes(normalizedReq)
        || normalizedReq.includes(normalizedP);
    });
  });

  const satisfied = missing.length === 0;

  let gate_status;
  if (satisfied) {
    gate_status = 'OPEN';
  } else if (HIGH_RISK_CLASSES.has(riskClass)) {
    // For Critical and High: closed = no autonomous override allowed
    gate_status = 'CLOSED';
  } else {
    // For lower risk: indicate override is possible
    gate_status = 'OVERRIDE_REQUIRED';
  }

  return {
    risk_class: riskClass,
    required_steps: required,
    steps_passed: passed,
    missing,
    satisfied,
    gate_status,
    note: gate_status === 'CLOSED'
      ? 'Continuation blocked. Chief Arbiter explicit approval required.'
      : gate_status === 'OVERRIDE_REQUIRED'
        ? 'Missing validation steps. Chief Arbiter may authorize override.'
        : 'All required validation steps satisfied. Gate is open.',
  };
}

function buildCheckMode(riskClass, arbiterOverride, rootDir) {
  const policy = loadPolicy(rootDir);
  let packageJson = null;
  try {
    packageJson = loadPackageJson(rootDir);
  } catch {
    packageJson = null;
  }

  if (!riskClass) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'check',
      status: 'FAIL',
      error: 'Missing required --risk value',
      summary: `${AGENT} (${LABEL})\nMode: check\nStatus: FAIL`,
    };
  }

  const result = checkValidationGate(riskClass, arbiterOverride, policy, packageJson);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'check',
    status: 'PASS',
    ...result,
    summary: [
      `${AGENT} (${LABEL})`,
      `Mode: check`,
      `Risk class: ${riskClass}`,
      `Gate open: ${result.gate_open}`,
      `Required steps: ${result.required_steps.join(', ')}`,
    ].join('\n'),
  };
}

function buildEnforceMode(riskClass, stepsPassed, rootDir) {
  const policy = loadPolicy(rootDir);

  if (!riskClass) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'enforce',
      status: 'FAIL',
      error: 'Missing required --risk value',
      summary: `${AGENT} (${LABEL})\nMode: enforce\nStatus: FAIL`,
    };
  }

  const result = enforceGate(riskClass, stepsPassed, policy);
  const outputStatus = result.gate_status === 'OPEN' ? 'PASS' : 'FAIL';

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'enforce',
    status: outputStatus,
    ...result,
    summary: [
      `${AGENT} (${LABEL})`,
      `Mode: enforce`,
      `Risk class: ${riskClass}`,
      `Gate status: ${result.gate_status}`,
      `Missing steps: ${result.missing.join(', ') || 'none'}`,
    ].join('\n'),
  };
}

function buildStatusOutput(rootDir) {
  const policy = loadPolicy(rootDir);
  const riskClasses = policy.required_validation ? Object.keys(policy.required_validation) : [];

  const validations = {};
  for (const rc of riskClasses) {
    validations[rc] = getRequiredSteps(policy, rc);
  }

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'status',
    status: 'PASS',
    observe_only: true,
    description: 'Blocks task continuation after failed validation unless Chief Arbiter explicitly authorizes override.',
    required_validations_per_risk_class: validations,
    high_risk_classes: [...HIGH_RISK_CLASSES],
    summary: `${AGENT} (${LABEL})\nMode: status\nStatus: PASS`,
  };
}

function buildOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'check') {
    return buildCheckMode(
      parsed.options.risk || '',
      parsed.options.arbiter_override || null,
      rootDir,
    );
  }

  if (parsed.mode === 'enforce') {
    let stepsPassed = [];
    try {
      stepsPassed = parsed.options.steps_passed ? JSON.parse(parsed.options.steps_passed) : [];
    } catch {
      stepsPassed = [];
    }
    return buildEnforceMode(parsed.options.risk || '', stepsPassed, rootDir);
  }

  return buildStatusOutput(rootDir);
}

module.exports = {
  AGENT,
  LABEL,
  HIGH_RISK_CLASSES,
  checkValidationGate,
  enforceGate,
  buildCheckMode,
  buildEnforceMode,
  buildOutput,
  buildStatusOutput,
  main,
  normalizePath,
  parseArgs,
  getRequiredSteps,
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
