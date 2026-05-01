#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const EXPECTED_DOCS = [
  'docs/mission-control/MISSION_CONTROL_ARCHITECTURE.md',
  'docs/mission-control/AGENT_REGISTRY.md',
  'docs/mission-control/SKILL_REGISTRY.md',
  'docs/mission-control/RISK_AND_APPROVAL_POLICY.md',
  'docs/mission-control/SCHEDULES.md',
  'docs/mission-control/EVIDENCE_LOG_SCHEMA.md',
  'docs/mission-control/BOT_OUTPUT_TEMPLATES.md',
];

const EXPECTED_BOT_FILES = [
  'scripts/passive-income-bot.cjs',
  'src/app/api/bots/passive-income/route.ts',
  'src/lib/server/passive-income-bot-wrapper.ts',
  'src/lib/__tests__/passive-income-bot.test.ts',
];

const EXPECTED_MEMORY_FILES = [
  'scripts/memory-api.cjs',
  'scripts/memory-service.cjs',
  'src/app/memory/page.tsx',
  'src/components/mission-control-memory-ui-v0.tsx',
  'src/lib/memory-service.ts',
  'src/lib/server/memory-api-wrapper.ts',
];

const EXPECTED_PACKAGE_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];

const REGISTRY_FILES = [
  'docs/mission-control/SKILL_REGISTRY.md',
  'src/lib/skill-registry.ts',
  'scripts/mc-mcp-server.cjs',
];

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function toAbsolutePath(rootDir, relativePath) {
  return path.join(rootDir, ...relativePath.split('/'));
}

function fileExists(rootDir, relativePath) {
  return fs.existsSync(toAbsolutePath(rootDir, relativePath));
}

function listPresence(rootDir, expectedPaths) {
  const present = [];
  const missing = [];

  for (const relativePath of expectedPaths) {
    if (fileExists(rootDir, relativePath)) {
      present.push(relativePath);
    } else {
      missing.push(relativePath);
    }
  }

  return { present, missing };
}

function createGitRunner(rootDir, customExecFileSync) {
  const runner = customExecFileSync || execFileSync;

  return function runGit(args) {
    return runner('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };
}

function parseStatusLines(statusOutput) {
  return statusOutput
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
}

function deriveStatus({ warnings, docsMissing, botsMissing, memoryMissing, scriptsMissing, isClean }) {
  if (docsMissing.length > 0 || botsMissing.length > 0 || memoryMissing.length > 0 || scriptsMissing.length > 0) {
    return 'FAIL';
  }

  if (!isClean || warnings.length > 0) {
    return 'WARN';
  }

  return 'OK';
}

function buildRecommendedNextActions({ isClean, docsMissing, botsMissing, memoryMissing, scriptsMissing, warnings }) {
  const actions = [];

  if (!isClean) {
    actions.push('Clean or explicitly review uncommitted changes before enabling any write-capable maintenance flow.');
  }

  if (docsMissing.length > 0) {
    actions.push(`Restore or add missing Mission Control docs: ${docsMissing.join(', ')}.`);
  }

  if (botsMissing.length > 0) {
    actions.push(`Restore or add missing domain bot files: ${botsMissing.join(', ')}.`);
  }

  if (memoryMissing.length > 0) {
    actions.push(`Restore or add missing memory files: ${memoryMissing.join(', ')}.`);
  }

  if (scriptsMissing.length > 0) {
    actions.push(`Add missing package scripts before relying on automated validation: ${scriptsMissing.join(', ')}.`);
  }

  if (warnings.some(warning => warning.includes('package-lock.json') && warning.includes('pnpm-lock.yaml'))) {
    actions.push('Confirm whether pnpm is the source of truth and keep lockfile policy consistent.');
  }

  actions.push('Review the audit output before promoting Systems Curator beyond observe-only mode.');

  return [...new Set(actions)];
}

function runAudit(options = {}) {
  const rootDir = options.rootDir || REPO_ROOT;
  const runGit = createGitRunner(rootDir, options.execFileSync);

  const statusOutput = runGit(['-c', 'core.pager=cat', 'status', '--short']);
  const branchOutput = runGit(['-c', 'core.pager=cat', 'branch', '--show-current']);
  const logOutput = runGit(['-c', 'core.pager=cat', 'log', '--oneline', '-5']);

  const statusEntries = parseStatusLines(statusOutput);
  const untrackedFiles = statusEntries
    .filter(line => line.startsWith('?? '))
    .map(line => normalizeRelativePath(line.slice(3).trim()));

  const latestCommits = logOutput
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const docs = listPresence(rootDir, EXPECTED_DOCS);
  const bots = listPresence(rootDir, EXPECTED_BOT_FILES);
  const memory = listPresence(rootDir, EXPECTED_MEMORY_FILES);
  const registries = listPresence(rootDir, REGISTRY_FILES);

  const packageJsonPath = toAbsolutePath(rootDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const packageScripts = packageJson.scripts || {};

  const scriptsPresent = EXPECTED_PACKAGE_SCRIPTS.filter(scriptName => typeof packageScripts[scriptName] === 'string');
  const scriptsMissing = EXPECTED_PACKAGE_SCRIPTS.filter(scriptName => typeof packageScripts[scriptName] !== 'string');

  const packageWarnings = [];

  if (fileExists(rootDir, 'package-lock.json') && fileExists(rootDir, 'pnpm-lock.yaml')) {
    packageWarnings.push('Both package-lock.json and pnpm-lock.yaml are present; confirm pnpm remains the source of truth.');
  }

  const warnings = [];

  if (statusEntries.length > 0) {
    warnings.push(`Working tree is not clean (${statusEntries.length} status entr${statusEntries.length === 1 ? 'y' : 'ies'}).`);
  }

  if (untrackedFiles.length > 0) {
    warnings.push(`Known untracked files detected: ${untrackedFiles.join(', ')}.`);
  }

  if (docs.missing.length > 0) {
    warnings.push(`Missing Mission Control docs: ${docs.missing.join(', ')}.`);
  }

  if (bots.missing.length > 0) {
    warnings.push(`Missing bot files: ${bots.missing.join(', ')}.`);
  }

  if (memory.missing.length > 0) {
    warnings.push(`Missing memory files: ${memory.missing.join(', ')}.`);
  }

  if (registries.missing.length > 0) {
    warnings.push(`Missing registry files: ${registries.missing.join(', ')}.`);
  }

  if (scriptsMissing.length > 0) {
    warnings.push(`Missing package scripts: ${scriptsMissing.join(', ')}.`);
  }

  const report = {
    status: deriveStatus({
      warnings: [...warnings, ...packageWarnings],
      docsMissing: docs.missing,
      botsMissing: bots.missing,
      memoryMissing: memory.missing,
      scriptsMissing,
      isClean: statusEntries.length === 0,
    }),
    risk_level: 0,
    label: 'OBSERVE ONLY',
    repo: {
      branch: branchOutput,
      is_clean: statusEntries.length === 0,
      status_entries: statusEntries,
      untracked_files: untrackedFiles,
      latest_commits: latestCommits,
    },
    mission_control: {
      docs_present: docs.present,
      docs_missing: docs.missing,
      bots_present: bots.present,
      bots_missing: bots.missing,
      memory_present: memory.present,
      memory_missing: memory.missing,
      registry_files_present: registries.present,
      registry_files_missing: registries.missing,
      risk_approval_policy_present: docs.present.includes('docs/mission-control/RISK_AND_APPROVAL_POLICY.md'),
    },
    package_hygiene: {
      scripts_present: scriptsPresent,
      scripts_missing: scriptsMissing,
      warnings: packageWarnings,
    },
    warnings: [...warnings, ...packageWarnings],
    recommended_next_actions: buildRecommendedNextActions({
      isClean: statusEntries.length === 0,
      docsMissing: docs.missing,
      botsMissing: bots.missing,
      memoryMissing: memory.missing,
      scriptsMissing,
      warnings: [...warnings, ...packageWarnings],
    }),
  };

  return report;
}

function emitJsonAndExit(payload, exitCode) {
  const output = `${JSON.stringify(payload, null, 2)}\n`;
  process.stdout.write(output);
  process.exit(exitCode);
}

if (require.main === module) {
  try {
    emitJsonAndExit(runAudit(), 0);
  } catch (error) {
    emitJsonAndExit({
      status: 'FAIL',
      risk_level: 0,
      label: 'OBSERVE ONLY',
      error: error instanceof Error ? error.message : String(error),
    }, 1);
  }
}

module.exports = {
  EXPECTED_BOT_FILES,
  EXPECTED_DOCS,
  EXPECTED_MEMORY_FILES,
  EXPECTED_PACKAGE_SCRIPTS,
  REGISTRY_FILES,
  runAudit,
};
