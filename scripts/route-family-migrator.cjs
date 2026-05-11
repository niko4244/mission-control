#!/usr/bin/env node
/**
 * route-family-migrator.cjs
 * Plans bounded route family migrations.
 *
 * OBSERVE ONLY / MIGRATION PLANNER
 * Generates migration plans for architecture-governor-approved route changes.
 * Never stages, commits, or executes — plan generation only.
 *
 * Modes:
 *   status                                          — Agent identity
 *   plan --route-family "agents" [--change "…"]     — Generate migration plan
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Route Family Migrator v1';
const LABEL = 'OBSERVE ONLY / MIGRATION PLANNER';
const BOT_ID = 'route-family-migrator';
const AUTHORITY_LEVEL = 6;
const VALID_MODES = new Set(['status', 'plan']);

// Never self-executes — human required for all of these
const REQUIRES_HUMAN_FOR = ['stage', 'commit', 'push', 'create_pr', 'merge'];

// Protected route families that increase risk
const PROTECTED_FAMILIES = ['auth', 'security', 'admin', 'gateway', 'workspace'];

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
    const key = current.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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

function scanRouteFamily(routeFamily, rootDir) {
  const apiBase = path.join(rootDir, 'src', 'app', 'api', routeFamily);

  if (!fs.existsSync(apiBase)) {
    return { files: [], exists: false };
  }

  const routeFiles = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name === 'route.ts') {
        routeFiles.push(normalizePath(path.relative(rootDir, fullPath)));
      }
    }
  }

  walk(apiBase);
  return { files: routeFiles, exists: true };
}

function buildMigrationSteps(routeFamily, files, proposedChange) {
  const steps = [];
  let stepNum = 1;

  // Step 1: Review and plan
  steps.push({
    step_number: stepNum++,
    file: `src/app/api/${routeFamily}/`,
    action: 'review',
    description: `Review all ${files.length} route file(s) in the ${routeFamily} family for the proposed change: "${proposedChange}"`,
  });

  // Step 2: Per-file update steps
  for (const file of files) {
    steps.push({
      step_number: stepNum++,
      file,
      action: 'update',
      description: `Apply "${proposedChange}" to ${file}`,
    });
  }

  // Step 3: Test
  steps.push({
    step_number: stepNum++,
    file: `src/lib/__tests__/`,
    action: 'test',
    description: `Run tests for the ${routeFamily} route family after changes`,
  });

  // Step 4: Validation
  steps.push({
    step_number: stepNum++,
    file: 'package.json',
    action: 'validate',
    description: 'Run pnpm typecheck and pnpm lint to confirm no drift',
  });

  return steps;
}

function determineRiskLevel(routeFamily, files) {
  const isProtected = PROTECTED_FAMILIES.some((f) => routeFamily.toLowerCase().includes(f));
  const fileCount = files.length;

  if (isProtected || fileCount > 10) {
    return 'High';
  }
  if (fileCount > 4) {
    return 'Medium';
  }
  return 'Low';
}

function buildRequiredTests(routeFamily, files) {
  const tests = [
    `pnpm vitest run src/lib/__tests__/ -- ${routeFamily}`,
    'pnpm typecheck',
    'pnpm lint',
  ];
  if (files.length > 3) {
    tests.push('pnpm test:e2e (recommended for broad changes)');
  }
  return tests;
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
    may_mutate: true,
    may_stage: false,
    may_commit: false,
    may_push: false,
    reports_to: 'architecture-governor',
    requires_human_for: REQUIRES_HUMAN_FOR.slice(),
    note: 'may_mutate=true but may_stage=false — generates plans, does NOT execute',
    summary: `${AGENT} (${LABEL}) — generates migration plans only. Reports to architecture-governor. All execution requires human.`,
  });
}

function buildPlanMode(rootDir, routeFamily, proposedChange, options = {}) {
  if (!routeFamily) {
    return buildOutput('plan', {
      status: 'FAIL',
      error: 'Missing required --route-family value',
      requires_human_for: REQUIRES_HUMAN_FOR.slice(),
    });
  }

  const change = proposedChange || 'apply proposed migration';
  const scanResult = scanRouteFamily(routeFamily, rootDir);

  if (!scanResult.exists) {
    return buildOutput('plan', {
      status: 'WARN',
      route_family: routeFamily,
      files_in_family: [],
      proposed_change: change,
      migration_steps: [],
      required_tests: [],
      estimated_files_changed: 0,
      risk_level: 'Low',
      requires_architecture_governor_approval: true,
      requires_human_for: REQUIRES_HUMAN_FOR.slice(),
      warning: `Route family directory not found: src/app/api/${routeFamily}/`,
      summary: `Route family "${routeFamily}" not found. Cannot generate migration plan.`,
    });
  }

  const files = scanResult.files;
  const migrationSteps = buildMigrationSteps(routeFamily, files, change);
  const riskLevel = determineRiskLevel(routeFamily, files);
  const requiredTests = buildRequiredTests(routeFamily, files);

  return buildOutput('plan', {
    status: 'PASS',
    route_family: routeFamily,
    files_in_family: files,
    proposed_change: change,
    migration_steps: migrationSteps,
    required_tests: requiredTests,
    estimated_files_changed: files.length,
    risk_level: riskLevel,
    requires_architecture_governor_approval: true,
    requires_human_for: REQUIRES_HUMAN_FOR.slice(),
    summary: `Migration plan for "${routeFamily}" (${files.length} file(s), risk=${riskLevel}). Requires architecture-governor approval and human execution.`,
  });
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'plan') {
    const routeFamily = parsed.options.routeFamily || parsed.options['route-family'] || '';
    const change = parsed.options.change || '';
    return buildPlanMode(rootDir, routeFamily, change, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  REQUIRES_HUMAN_FOR,
  PROTECTED_FAMILIES,
  buildOutput,
  buildStatusMode,
  buildPlanMode,
  main,
  normalizePath,
  parseArgs,
  scanRouteFamily,
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
