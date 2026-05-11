#!/usr/bin/env node
/**
 * test-runner-bot.cjs
 * Runs targeted validation and classifies test failures.
 * Observer only — never mutates source code.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = 'Test Runner Bot v1';
const LABEL = 'OBSERVE ONLY / VALIDATION CLASSIFIER';
const VALID_MODES = new Set(['status', 'run', 'classify']);
const CACHE_FILE = path.join('.data', 'test-runner-cache.json');
const SPAWN_TIMEOUT_MS = 120000;

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean);
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

function checkVitestAvailability(rootDir) {
  const localVitest = path.join(rootDir, 'node_modules', '.bin', 'vitest');
  const localVitestCmd = path.join(rootDir, 'node_modules', '.bin', 'vitest.cmd');
  return fs.existsSync(localVitest) || fs.existsSync(localVitestCmd)
    || fs.existsSync(path.join(rootDir, 'node_modules', 'vitest'));
}

function loadCache(rootDir, fsApi = fs) {
  const cachePath = path.join(rootDir, CACHE_FILE);
  if (!fsApi.existsSync(cachePath)) return null;

  try {
    return JSON.parse(fsApi.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(rootDir, data, fsApi = fs) {
  const cachePath = path.join(rootDir, CACHE_FILE);
  try {
    fsApi.mkdirSync(path.dirname(cachePath), { recursive: true });
    fsApi.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function parseVitestOutput(stdout, stderr, exitStatus, durationMs) {
  const output = stdout + '\n' + stderr;
  const lines = splitLines(output);

  let filesRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let testsSkipped = 0;
  const failures = [];

  // Parse vitest summary lines: "Tests  12 passed | 2 failed | 1 skipped (15)"
  for (const line of lines) {
    const testSummary = line.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/i);
    if (testSummary) {
      testsPassed = parseInt(testSummary[1] || '0', 10);
      testsFailed = parseInt(testSummary[2] || '0', 10);
      testsSkipped = parseInt(testSummary[3] || '0', 10);
    }

    // "Test Files  3 passed (3)"
    const fileSummary = line.match(/Test Files\s+(\d+)\s+passed/i);
    if (fileSummary) {
      filesRun = parseInt(fileSummary[1] || '0', 10);
    }

    // "× test name" or "✗ test name" or "FAIL test name" style failure lines
    const failLine = line.match(/^\s*(?:×|✗|FAIL|✕)\s+(.+)$/);
    if (failLine) {
      failures.push({
        file: '',
        test: failLine[1].trim(),
        error: '',
      });
    }
  }

  // Extract file-level failures from "FAIL src/lib/__tests__/foo.test.ts" lines
  let lastFailFile = '';
  for (const line of lines) {
    const failFileLine = line.match(/^\s*(?:FAIL|×)\s+(src\/.+\.(?:test|spec)\.[tj]s[x]?)$/i);
    if (failFileLine) {
      lastFailFile = normalizePath(failFileLine[1]);
    }
    // Associate errors with last fail file
    const errorLine = line.match(/^\s*(?:AssertionError|Error|TypeError|ReferenceError):\s+(.+)$/);
    if (errorLine && lastFailFile && failures.length > 0) {
      const last = failures[failures.length - 1];
      if (!last.file) last.file = lastFailFile;
      if (!last.error) last.error = errorLine[1].trim();
    }
  }

  let classification;
  if (exitStatus === null || exitStatus === undefined) {
    classification = 'error';
  } else if (exitStatus === 124) {
    classification = 'timeout';
  } else if (testsFailed > 0) {
    classification = 'some_fail';
  } else {
    classification = 'all_pass';
  }

  return {
    files_run: filesRun,
    tests_passed: testsPassed,
    tests_failed: testsFailed,
    tests_skipped: testsSkipped,
    duration_ms: durationMs,
    failures,
    classification,
    raw_lines: lines.length,
  };
}

function classifyFailures(rawOutput, diffFiles = []) {
  const lines = splitLines(rawOutput);
  const failures = [];
  const normalizedDiff = (diffFiles || []).map(normalizePath);

  let currentFile = '';
  let currentTest = '';
  let currentError = '';

  for (const line of lines) {
    // File-level fail markers
    const failFileLine = line.match(/^\s*(?:FAIL|×)\s+(src\/.+\.(?:test|spec)\.[tj]s[x]?)/i);
    if (failFileLine) {
      if (currentTest) {
        failures.push({
          file: currentFile,
          test: currentTest,
          error: currentError,
          classification: classifySingleFailure(currentFile, currentTest, currentError, normalizedDiff),
        });
        currentTest = '';
        currentError = '';
      }
      currentFile = normalizePath(failFileLine[1]);
      continue;
    }

    // Individual test fail
    const testFail = line.match(/^\s*(?:×|✗|✕)\s+(.+)$/);
    if (testFail) {
      if (currentTest) {
        failures.push({
          file: currentFile,
          test: currentTest,
          error: currentError,
          classification: classifySingleFailure(currentFile, currentTest, currentError, normalizedDiff),
        });
      }
      currentTest = testFail[1].trim();
      currentError = '';
      continue;
    }

    // Error lines
    const errorLine = line.match(/^\s*(?:AssertionError|Error|TypeError|ReferenceError|expect\():\s+(.+)$/);
    if (errorLine && currentTest && !currentError) {
      currentError = errorLine[1].trim();
    }

    // Timeout detection
    if (/timeout/i.test(line) && currentTest) {
      currentError = currentError || 'timeout';
    }
  }

  if (currentTest) {
    failures.push({
      file: currentFile,
      test: currentTest,
      error: currentError,
      classification: classifySingleFailure(currentFile, currentTest, currentError, normalizedDiff),
    });
  }

  // Determine overall classification
  const allPassing = failures.length === 0;
  const hasTimeout = failures.some((f) => f.error === 'timeout' || /timeout/i.test(f.error));
  const hasIntroduced = failures.some((f) => f.classification === 'introduced');
  const hasPreExisting = failures.some((f) => f.classification === 'pre-existing');
  const hasFlaky = failures.some((f) => f.classification === 'flaky');
  const hasUnrelated = failures.some((f) => f.classification === 'unrelated');

  let overallClassification = 'all_pass';
  if (!allPassing) {
    if (hasTimeout) overallClassification = 'timeout';
    else if (hasIntroduced) overallClassification = 'some_fail';
    else if (hasPreExisting) overallClassification = 'some_fail';
    else if (hasFlaky) overallClassification = 'some_fail';
    else if (hasUnrelated) overallClassification = 'some_fail';
    else overallClassification = 'some_fail';
  }

  return {
    failures,
    classification: overallClassification,
    has_introduced: hasIntroduced,
    has_pre_existing: hasPreExisting,
    has_flaky: hasFlaky,
    has_unrelated: hasUnrelated,
    has_timeout: hasTimeout,
  };
}

function classifySingleFailure(file, testName, errorText, normalizedDiffFiles = []) {
  const normalizedFile = normalizePath(file);
  const lowerError = String(errorText || '').toLowerCase();
  const lowerTest = String(testName || '').toLowerCase();

  // Flaky: timeout or random-seed-style failures
  if (/timeout/i.test(lowerError) || /timed out/i.test(lowerError)) return 'flaky';
  if (/random|flak|intermittent|nondeterminist/i.test(lowerTest)) return 'flaky';

  // Introduced: file matches diff or is a new test file not in diff
  if (normalizedDiffFiles.some((diffFile) => {
    const normalizedDiff = normalizePath(diffFile);
    return normalizedFile === normalizedDiff
      || normalizedFile.replace(/\.(?:test|spec)\./, '.').replace(/__tests__\//, '') === normalizedDiff
      || normalizedDiff.includes(path.posix.basename(normalizedFile, path.posix.extname(normalizedFile)));
  })) {
    return 'introduced';
  }

  // Pre-existing: file exists and is not in diff
  if (normalizedFile && normalizedDiffFiles.length > 0) {
    return 'pre-existing';
  }

  // Unrelated: completely different module
  return 'unrelated';
}

function buildBaseOutput(mode) {
  return {
    agent: AGENT,
    label: LABEL,
    mode,
    status: 'PASS',
    warnings: [],
    blockers: [],
    metadata: {},
    summary: '',
  };
}

function runStatusMode(rootDir, options = {}) {
  const fsApi = options.fsApi || fs;
  const result = buildBaseOutput('status');
  const vitestAvailable = checkVitestAvailability(rootDir);
  const cache = loadCache(rootDir, fsApi);

  result.vitest_available = vitestAvailable;
  result.last_run_summary = cache ? cache.last_run_summary : null;
  result.last_run_at = cache ? cache.last_run_at : null;

  if (!vitestAvailable) {
    result.warnings.push('vitest not found in node_modules — run pnpm install first');
  }

  result.metadata = {
    root_dir: normalizePath(rootDir),
    vitest_available: vitestAvailable,
    cache_file: normalizePath(CACHE_FILE),
    cache_loaded: Boolean(cache),
    last_run_at: cache ? cache.last_run_at : null,
  };

  result.status = result.blockers.length > 0 ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS';
  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: status',
    `Status: ${result.status}`,
    `Vitest available: ${vitestAvailable}`,
    `Last run: ${result.last_run_at || 'never'}`,
  ].join('\n');

  return result;
}

function runRunMode(rootDir, scope, options = {}) {
  const fsApi = options.fsApi || fs;
  const commandRunner = options.commandRunner || null;
  const result = buildBaseOutput('run');

  if (!scope) {
    result.status = 'FAIL';
    result.blockers.push('Missing required --scope argument');
    result.metadata = { root_dir: normalizePath(rootDir) };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: run',
      'Status: FAIL',
      'Blockers: Missing --scope argument',
    ].join('\n');
    return result;
  }

  const startTime = Date.now();
  let spawnResult;

  if (commandRunner) {
    // Allow injection for testing
    spawnResult = commandRunner('pnpm', ['vitest', 'run', scope], { cwd: rootDir });
    spawnResult._duration_ms = Date.now() - startTime;
  } else {
    const raw = spawnSync('pnpm', ['vitest', 'run', scope], {
      cwd: rootDir,
      encoding: 'utf8',
      shell: false,
      timeout: SPAWN_TIMEOUT_MS,
    });
    spawnResult = {
      ok: !raw.error && raw.status === 0,
      status: typeof raw.status === 'number' ? raw.status : null,
      stdout: raw.stdout || '',
      stderr: raw.stderr || '',
      error: raw.error ? raw.error.message : '',
      _duration_ms: Date.now() - startTime,
    };
  }

  const durationMs = spawnResult._duration_ms || (Date.now() - startTime);
  const parsed = parseVitestOutput(
    spawnResult.stdout,
    spawnResult.stderr,
    spawnResult.status,
    durationMs,
  );

  if (spawnResult.error && spawnResult.error !== '') {
    result.warnings.push(`Spawn error: ${spawnResult.error}`);
    parsed.classification = 'error';
  }

  result.files_run = parsed.files_run;
  result.tests_passed = parsed.tests_passed;
  result.tests_failed = parsed.tests_failed;
  result.tests_skipped = parsed.tests_skipped;
  result.duration_ms = durationMs;
  result.failures = parsed.failures;
  result.classification = parsed.classification;
  result.exit_status = spawnResult.status;

  // Cache the run summary
  const cacheSummary = {
    last_run_summary: {
      scope,
      files_run: parsed.files_run,
      tests_passed: parsed.tests_passed,
      tests_failed: parsed.tests_failed,
      tests_skipped: parsed.tests_skipped,
      duration_ms: durationMs,
      classification: parsed.classification,
    },
    last_run_at: new Date().toISOString(),
  };
  saveCache(rootDir, cacheSummary, fsApi);

  result.metadata = {
    root_dir: normalizePath(rootDir),
    scope,
    exit_status: spawnResult.status,
    duration_ms: durationMs,
    cache_file: normalizePath(CACHE_FILE),
  };

  result.status = parsed.classification === 'all_pass' ? 'PASS'
    : parsed.classification === 'error' ? 'FAIL'
    : parsed.tests_failed > 0 ? 'FAIL'
    : 'WARN';

  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: run',
    `Status: ${result.status}`,
    `Scope: ${scope}`,
    `Files run: ${parsed.files_run}`,
    `Tests: ${parsed.tests_passed} passed, ${parsed.tests_failed} failed, ${parsed.tests_skipped} skipped`,
    `Classification: ${parsed.classification}`,
    `Duration: ${durationMs}ms`,
  ].join('\n');

  return result;
}

function runClassifyMode(rootDir, outputFile, options = {}) {
  const fsApi = options.fsApi || fs;
  const diffFiles = options.diffFiles || [];
  const result = buildBaseOutput('classify');

  if (!outputFile) {
    result.status = 'FAIL';
    result.blockers.push('Missing required --output argument (path to test output file)');
    result.metadata = { root_dir: normalizePath(rootDir) };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: classify',
      'Status: FAIL',
      'Blockers: Missing --output argument',
    ].join('\n');
    return result;
  }

  const absolutePath = path.isAbsolute(outputFile)
    ? outputFile
    : path.join(rootDir, outputFile);

  if (!fsApi.existsSync(absolutePath)) {
    result.status = 'FAIL';
    result.blockers.push(`Output file not found: ${outputFile}`);
    result.metadata = { root_dir: normalizePath(rootDir), output_file: outputFile };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: classify',
      'Status: FAIL',
      `Blockers: File not found: ${outputFile}`,
    ].join('\n');
    return result;
  }

  let rawOutput;
  try {
    rawOutput = fsApi.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    result.status = 'FAIL';
    result.blockers.push(`Failed to read output file: ${error.message}`);
    result.metadata = { root_dir: normalizePath(rootDir), output_file: outputFile };
    result.summary = [
      `${AGENT} (${LABEL})`,
      'Mode: classify',
      'Status: FAIL',
      `Blockers: Read error: ${error.message}`,
    ].join('\n');
    return result;
  }

  const classified = classifyFailures(rawOutput, diffFiles);

  result.classification = classified.classification;
  result.failures = classified.failures;
  result.has_introduced = classified.has_introduced;
  result.has_pre_existing = classified.has_pre_existing;
  result.has_flaky = classified.has_flaky;
  result.has_unrelated = classified.has_unrelated;
  result.has_timeout = classified.has_timeout;

  result.metadata = {
    root_dir: normalizePath(rootDir),
    output_file: outputFile,
    diff_files: diffFiles,
    failure_count: classified.failures.length,
  };

  result.status = classified.classification === 'all_pass' ? 'PASS'
    : classified.has_introduced ? 'FAIL'
    : classified.classification === 'timeout' ? 'WARN'
    : 'WARN';

  result.summary = [
    `${AGENT} (${LABEL})`,
    'Mode: classify',
    `Status: ${result.status}`,
    `Classification: ${classified.classification}`,
    `Failures: ${classified.failures.length}`,
    classified.has_introduced ? 'Has introduced failures: true' : '',
    classified.has_pre_existing ? 'Has pre-existing failures: true' : '',
    classified.has_flaky ? 'Has flaky failures: true' : '',
  ].filter(Boolean).join('\n');

  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'run') {
    const scope = parsed.options.scope || '';
    return runRunMode(rootDir, scope, options);
  }

  if (parsed.mode === 'classify') {
    const outputFile = parsed.options.output || '';
    return runClassifyMode(rootDir, outputFile, options);
  }

  return runStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  CACHE_FILE,
  SPAWN_TIMEOUT_MS,
  VALID_MODES,
  buildBaseOutput,
  checkVitestAvailability,
  classifyFailures,
  classifySingleFailure,
  formatOutput,
  loadCache,
  main,
  normalizePath,
  parseArgs,
  parseVitestOutput,
  runClassifyMode,
  runRunMode,
  runStatusMode,
  saveCache,
  splitLines,
  unique,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'unknown',
      status: 'FAIL',
      error: error && error.message ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
