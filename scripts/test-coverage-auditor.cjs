#!/usr/bin/env node
/**
 * test-coverage-auditor.cjs
 * Test coverage auditor for governance scripts and API routes.
 *
 * Observe-only. Identifies risky untested changes and coverage gaps.
 *
 * Modes:
 *   status          — Agent identity + count of governance scripts, test files
 *   audit [options] — Full coverage audit
 *     --scope "scripts"|"routes"|"all"  Scope of audit (default: all)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Test Coverage Auditor v1';
const LABEL = 'OBSERVE ONLY / COVERAGE VERIFIER';
const BOT_ID = 'test-coverage-auditor';
const VALID_MODES = new Set(['status', 'audit']);

const GOVERNANCE_KEYWORD_PATTERNS = [
  'governor',
  'arbiter',
  'executor',
  'steward',
  'runner',
  'sentinel',
  'inspector',
  'curator',
  'migrator',
  'manager',
  'compiler',
  'engine',
  'lifecycle',
  'intake',
  'journal',
  'middleware',
  'schema',
  'filter',
  'checker',
  'classifier',
  'protocol',
  'reconciler',
];

const HIGH_RISK_PATTERNS = ['governor', 'arbiter', 'executor', 'sentinel', 'inspector'];
const CRITICAL_RISK_PATTERNS = ['arbiter', 'governor'];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isGovernanceScript(name) {
  const stem = name.replace(/\.cjs$/, '').toLowerCase();
  return GOVERNANCE_KEYWORD_PATTERNS.some((kw) => stem.includes(kw));
}

function getRiskLevel(name) {
  const stem = name.replace(/\.cjs$/, '').toLowerCase();
  if (CRITICAL_RISK_PATTERNS.some((kw) => stem.includes(kw))) return 'Critical';
  if (HIGH_RISK_PATTERNS.some((kw) => stem.includes(kw))) return 'High';
  return 'Medium';
}

function scriptToExpectedTest(scriptName) {
  const stem = scriptName.replace(/\.cjs$/, '');
  return `src/lib/__tests__/${stem}.test.ts`;
}

function routeToExpectedTest(routeRelative) {
  const normalized = normalizePath(routeRelative);
  const parts = normalized.split('/');
  const segmentIndex = parts.indexOf('api');
  const segments = segmentIndex >= 0 ? parts.slice(segmentIndex + 1) : parts;
  const relevantSegments = segments.filter((s) => s !== 'route.ts');
  const testStem = relevantSegments.join('-').replace(/[^a-zA-Z0-9-]/g, '');
  return `src/lib/__tests__/api-${testStem}.test.ts`;
}

function auditScripts(rootDir, options = {}) {
  const scriptsDir = path.join(rootDir, 'scripts');
  const testsDir = path.join(rootDir, 'src', 'lib', '__tests__');

  if (!fileExists(scriptsDir)) {
    return {
      scripts_audited: 0,
      scripts_with_tests: 0,
      scripts_without_tests: [],
    };
  }

  let scriptFiles = [];
  try {
    scriptFiles = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
  } catch {
    scriptFiles = [];
  }

  const governanceScripts = scriptFiles.filter(isGovernanceScript);

  let testFiles = [];
  if (fileExists(testsDir)) {
    try {
      testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));
    } catch {
      testFiles = [];
    }
  }

  const withTests = [];
  const withoutTests = [];

  for (const scriptName of governanceScripts) {
    const stem = scriptName.replace(/\.cjs$/, '');
    const hasTest = testFiles.some((tf) => {
      const tfStem = tf.replace(/\.test\.ts$/, '');
      return tfStem === stem || tfStem.includes(stem) || stem.includes(tfStem);
    });

    if (hasTest) {
      withTests.push(scriptName);
    } else {
      withoutTests.push({
        script: `scripts/${scriptName}`,
        expected_test: scriptToExpectedTest(scriptName),
        risk_level: getRiskLevel(scriptName),
      });
    }
  }

  return {
    scripts_audited: governanceScripts.length,
    scripts_with_tests: withTests.length,
    scripts_without_tests: withoutTests,
  };
}

function auditRoutes(rootDir, options = {}) {
  const routesDir = path.join(rootDir, 'src', 'app', 'api');
  const testsDir = path.join(rootDir, 'src', 'lib', '__tests__');

  if (!fileExists(routesDir)) {
    return {
      routes_audited: 0,
      routes_with_tests: 0,
      routes_without_tests: [],
    };
  }

  const routeFiles = [];

  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === 'route.ts') {
        routeFiles.push(normalizePath(path.relative(rootDir, full)));
      }
    }
  }

  walk(routesDir, 0);

  let testFiles = [];
  if (fileExists(testsDir)) {
    try {
      testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));
    } catch {
      testFiles = [];
    }
  }

  const withTests = [];
  const withoutTests = [];

  for (const routeRelative of routeFiles) {
    const parts = normalizePath(routeRelative).split('/');
    const apiIdx = parts.indexOf('api');
    const segments = apiIdx >= 0 ? parts.slice(apiIdx + 1).filter((s) => s !== 'route.ts') : [];

    const hasTest = testFiles.some((tf) => {
      return segments.some((seg) => tf.includes(seg));
    });

    if (hasTest) {
      withTests.push(routeRelative);
    } else {
      withoutTests.push({
        route: routeRelative,
        expected_test: routeToExpectedTest(routeRelative),
      });
    }
  }

  return {
    routes_audited: routeFiles.length,
    routes_with_tests: withTests.length,
    routes_without_tests: withoutTests,
  };
}

function computeCoverageScore(scriptsAudited, scriptsWithTests, routesAudited, routesWithTests) {
  const total = scriptsAudited + routesAudited;
  if (total === 0) return 100;
  const covered = scriptsWithTests + routesWithTests;
  return Math.round((covered / total) * 100);
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    observe_only: true,
    warnings: data.warnings || [],
    blocking_conditions: data.blocking_conditions || [],
    summary: data.summary || '',
    metadata: data.metadata || {},
  };
}

function buildStatusMode(rootDir, options = {}) {
  const scriptsDir = path.join(rootDir, 'scripts');
  const testsDir = path.join(rootDir, 'src', 'lib', '__tests__');

  let governanceScriptCount = 0;
  let testFileCount = 0;

  try {
    if (fileExists(scriptsDir)) {
      const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
      governanceScriptCount = files.filter(isGovernanceScript).length;
    }
  } catch {
    governanceScriptCount = 0;
  }

  try {
    if (fileExists(testsDir)) {
      testFileCount = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts')).length;
    }
  } catch {
    testFileCount = 0;
  }

  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      governance_script_count: governanceScriptCount,
      test_file_count: testFileCount,
      observe_only: true,
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: status\nStatus: PASS\nGovernance scripts: ${governanceScriptCount}\nTest files: ${testFileCount}`;
  return result;
}

function buildAuditMode(rootDir, options = {}) {
  const scope = options.scope || 'all';
  const warnings = [];
  const blockingConditions = [];

  let scriptsResult = { scripts_audited: 0, scripts_with_tests: 0, scripts_without_tests: [] };
  let routesResult = { routes_audited: 0, routes_with_tests: 0, routes_without_tests: [] };

  if (scope === 'scripts' || scope === 'all') {
    scriptsResult = auditScripts(rootDir, options);
  }
  if (scope === 'routes' || scope === 'all') {
    routesResult = auditRoutes(rootDir, options);
  }

  const coverageScore = computeCoverageScore(
    scriptsResult.scripts_audited,
    scriptsResult.scripts_with_tests,
    routesResult.routes_audited,
    routesResult.routes_with_tests,
  );

  const highRiskWithoutTests = scriptsResult.scripts_without_tests.filter(
    (s) => s.risk_level === 'High' || s.risk_level === 'Critical',
  );
  const waiverRequired = highRiskWithoutTests.length > 0;

  if (waiverRequired) {
    blockingConditions.push(
      `${highRiskWithoutTests.length} High/Critical governance script(s) lack test coverage — waiver required`,
    );
  }
  if (scriptsResult.scripts_without_tests.length > 0) {
    warnings.push(
      `${scriptsResult.scripts_without_tests.length} governance script(s) have no test coverage`,
    );
  }
  if (routesResult.routes_without_tests.length > 0) {
    warnings.push(
      `${routesResult.routes_without_tests.length} API route(s) have no test coverage`,
    );
  }
  if (coverageScore < 50) {
    warnings.push(`Coverage score is low: ${coverageScore}%`);
  }

  const result = buildOutput('audit', {
    status: blockingConditions.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    blocking_conditions: blockingConditions,
    metadata: {
      agent: AGENT,
      label: LABEL,
      bot_id: BOT_ID,
      scope,
      scripts_audited: scriptsResult.scripts_audited,
      scripts_with_tests: scriptsResult.scripts_with_tests,
      scripts_without_tests: scriptsResult.scripts_without_tests,
      routes_audited: routesResult.routes_audited,
      routes_with_tests: routesResult.routes_with_tests,
      routes_without_tests: routesResult.routes_without_tests,
      coverage_score: coverageScore,
      waiver_required: waiverRequired,
      observe_only: true,
    },
  });
  result.summary = `${AGENT} (${LABEL})\nMode: audit\nStatus: ${result.status}\nCoverage score: ${coverageScore}%`;
  return result;
}

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

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const mergedOptions = Object.assign({}, options, parsed.options);

  if (parsed.mode === 'audit') {
    return buildAuditMode(rootDir, mergedOptions);
  }
  return buildStatusMode(rootDir, mergedOptions);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  GOVERNANCE_KEYWORD_PATTERNS,
  auditRoutes,
  auditScripts,
  buildAuditMode,
  buildOutput,
  buildStatusMode,
  computeCoverageScore,
  fileExists,
  getRiskLevel,
  isGovernanceScript,
  main,
  normalizePath,
  parseArgs,
  routeToExpectedTest,
  scriptToExpectedTest,
  unique,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
