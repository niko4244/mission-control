#!/usr/bin/env node
/**
 * diff-scope-classifier.cjs
 * Observe-only diff scope classifier for Mission Control. Classifies diff scope
 * and escalates broad changes. Detects when too many files are changed.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Diff Scope Classifier v1';
const LABEL = 'OBSERVE ONLY / DIFF ANALYSIS';
const VALID_MODES = new Set(['status', 'classify']);

// Thresholds
const SCOPE_MINIMAL_MAX = 3;
const SCOPE_BOUNDED_MAX = 8;
const SCOPE_BROAD_MAX = 20;
// warn if > 8, escalate if > 20
const ESCALATE_WARN_THRESHOLD = 8;
const ESCALATE_THRESHOLD = 20;

// Release-sensitive file patterns
const RELEASE_SENSITIVE_PATTERNS = [
  // exact filenames
  'package.json',
  'pnpm-lock.yaml',
  // prefix patterns (checked via startsWith after normalization)
  'src/app/api/',
  'src/lib/security/',
  'scripts/',
  '.github/',
];

// next.config.* is basename-checked; config/*.json is prefix+glob-checked
function isReleaseSensitive(filePath) {
  const normalized = normalizePath(filePath);
  const basename = path.posix.basename(normalized);

  if (normalized === 'package.json') return true;
  if (normalized === 'pnpm-lock.yaml') return true;
  if (basename.startsWith('next.config.')) return true;
  if (normalized.startsWith('src/app/api/')) return true;
  if (normalized.startsWith('src/lib/security/')) return true;
  if (normalized.startsWith('scripts/')) return true;
  if (normalized.startsWith('.github/')) return true;
  // config/*.json — any json under config/
  if (normalized.startsWith('config/') && normalized.endsWith('.json')) return true;

  return false;
}

function categorizeFile(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.startsWith('src/app/') && !normalized.startsWith('src/app/api/')) return 'components';
  if (normalized.startsWith('src/app/api/') || normalized.startsWith('src/pages/api/')) return 'routes';
  if (normalized.includes('__tests__') || normalized.endsWith('.test.ts') || normalized.endsWith('.test.tsx') || normalized.endsWith('.spec.ts') || normalized.endsWith('.spec.tsx')) return 'tests';
  if (normalized.startsWith('scripts/') || normalized.endsWith('.cjs') || normalized.endsWith('.sh')) return 'scripts';
  if (normalized.startsWith('config/') || normalized === 'package.json' || normalized === 'pnpm-lock.yaml' || normalized.startsWith('next.config') || normalized.startsWith('.github/') || normalized.startsWith('.env')) return 'config';
  if (normalized.startsWith('src/components/') || normalized.startsWith('src/lib/') || normalized.endsWith('.tsx') || normalized.endsWith('.ts')) return 'components';
  return 'unknown';
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function scopeRating(count) {
  if (count <= SCOPE_MINIMAL_MAX) return 'minimal';
  if (count <= SCOPE_BOUNDED_MAX) return 'bounded';
  if (count <= SCOPE_BROAD_MAX) return 'broad';
  return 'excessive';
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

function classifyDiffScope(rootDir, commandRunner) {
  const runner = commandRunner || runCommand;

  let diffResult = runner('git', ['diff', '--name-only', 'main...HEAD'], { cwd: rootDir });
  let diffBase = 'main...HEAD';

  if (!diffResult.ok) {
    diffResult = runner('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: rootDir });
    diffBase = 'origin/main...HEAD';
  }

  const diffAvailable = diffResult.ok;
  const changedFiles = diffAvailable
    ? unique(splitLines(diffResult.stdout).map(normalizePath))
    : [];

  const fileCount = changedFiles.length;
  const rating = scopeRating(fileCount);
  const escalate = fileCount > ESCALATE_THRESHOLD;
  const warnOnly = fileCount > ESCALATE_WARN_THRESHOLD && !escalate;

  let escalationReason = '';
  if (escalate) {
    escalationReason = `${fileCount} files changed — exceeds escalation threshold of ${ESCALATE_THRESHOLD}. Human review required before any PR action.`;
  } else if (warnOnly) {
    escalationReason = `${fileCount} files changed — exceeds warning threshold of ${ESCALATE_WARN_THRESHOLD}. Consider splitting the change set.`;
  }

  // Categorize files
  const byCategory = {
    routes: [],
    tests: [],
    scripts: [],
    config: [],
    components: [],
    unknown: [],
  };

  for (const file of changedFiles) {
    const cat = categorizeFile(file);
    if (byCategory[cat]) {
      byCategory[cat].push(file);
    } else {
      byCategory.unknown.push(file);
    }
  }

  const releaseSensitive = changedFiles.filter(isReleaseSensitive);

  // Build recommendation
  let recommendation = '';
  if (!diffAvailable) {
    recommendation = 'Diff unavailable — ensure you are on a branch with commits ahead of main.';
  } else if (rating === 'excessive') {
    recommendation = `STOP: ${fileCount} files changed is excessive (>${ESCALATE_THRESHOLD}). Split this change into smaller PRs and obtain human sign-off before proceeding.`;
  } else if (rating === 'broad') {
    recommendation = `CAUTION: ${fileCount} files changed. Review categorization carefully, consider splitting scope, and ensure human oversight for release-sensitive files.`;
  } else if (releaseSensitive.length > 0) {
    recommendation = `Scope is ${rating} but includes ${releaseSensitive.length} release-sensitive file(s). Obtain human review for: ${releaseSensitive.join(', ')}.`;
  } else if (rating === 'bounded') {
    recommendation = `Scope is bounded (${fileCount} files). Proceed with normal code review.`;
  } else {
    recommendation = `Scope is minimal (${fileCount} file(s)). Proceed normally.`;
  }

  return {
    diff_base: diffAvailable ? diffBase : '',
    diff_available: diffAvailable,
    changed_files: changedFiles,
    file_count: fileCount,
    scope_rating: rating,
    escalate,
    escalation_reason: escalationReason,
    by_category: {
      routes: byCategory.routes,
      tests: byCategory.tests,
      scripts: byCategory.scripts,
      config: byCategory.config,
      components: byCategory.components,
      unknown: byCategory.unknown,
    },
    release_sensitive: releaseSensitive,
    recommendation,
    warn_only: warnOnly,
  };
}

function buildOutput(rootDir, commandRunner, now) {
  const ts = (now instanceof Date ? now : new Date()).toISOString();
  const classification = classifyDiffScope(rootDir, commandRunner);

  const overallStatus = classification.escalate
    ? 'FAIL'
    : classification.warn_only || classification.release_sensitive.length > 0
      ? 'WARN'
      : 'PASS';

  return {
    agent: AGENT,
    label: LABEL,
    observe_only: true,
    mode: 'classify',
    status: overallStatus,
    checked_at: ts,
    changed_files: classification.changed_files,
    file_count: classification.file_count,
    scope_rating: classification.scope_rating,
    escalate: classification.escalate,
    escalation_reason: classification.escalation_reason,
    by_category: classification.by_category,
    release_sensitive: classification.release_sensitive,
    recommendation: classification.recommendation,
    diff_base: classification.diff_base,
    diff_available: classification.diff_available,
    summary: [
      `${AGENT} (${LABEL})`,
      `Status: ${overallStatus}`,
      `Scope: ${classification.scope_rating} (${classification.file_count} file(s))`,
      `Escalate: ${classification.escalate}`,
      `Release-sensitive files: ${classification.release_sensitive.length}`,
      `Recommendation: ${classification.recommendation}`,
    ].join('\n'),
  };
}

function buildStatusOutput(rootDir) {
  return {
    agent: AGENT,
    label: LABEL,
    observe_only: true,
    mode: 'status',
    status: 'PASS',
    root_dir: normalizePath(rootDir),
    thresholds: {
      minimal_max: SCOPE_MINIMAL_MAX,
      bounded_max: SCOPE_BOUNDED_MAX,
      broad_max: SCOPE_BROAD_MAX,
      warn_threshold: ESCALATE_WARN_THRESHOLD,
      escalate_threshold: ESCALATE_THRESHOLD,
    },
    release_sensitive_patterns: RELEASE_SENSITIVE_PATTERNS,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: status',
      'Self-report: operational',
      `Thresholds: warn>${ESCALATE_WARN_THRESHOLD}, escalate>${ESCALATE_THRESHOLD}`,
      'Scope ratings: minimal(1-3), bounded(4-8), broad(9-20), excessive(>20)',
    ].join('\n'),
  };
}

function parseArgs(argv = []) {
  const args = argv.slice();
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  return { mode };
}

function main(argv, options) {
  const args = argv !== undefined ? argv : process.argv.slice(2);
  const opts = options || {};
  const { mode } = parseArgs(args);
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');
  const commandRunner = opts.commandRunner || runCommand;
  const now = opts.now instanceof Date ? opts.now : new Date();

  let result;
  if (mode === 'classify') {
    result = buildOutput(rootDir, commandRunner, now);
  } else {
    result = buildStatusOutput(rootDir);
  }

  return result;
}

module.exports = {
  AGENT,
  LABEL,
  SCOPE_MINIMAL_MAX,
  SCOPE_BOUNDED_MAX,
  SCOPE_BROAD_MAX,
  ESCALATE_WARN_THRESHOLD,
  ESCALATE_THRESHOLD,
  RELEASE_SENSITIVE_PATTERNS,
  buildOutput,
  buildStatusOutput,
  categorizeFile,
  classifyDiffScope,
  isReleaseSensitive,
  main,
  normalizePath,
  runCommand,
  scopeRating,
  splitLines,
  unique,
};

if (require.main === module) {
  const result = main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`);
}
