#!/usr/bin/env node
/**
 * systems-steward.cjs
 * Continuity and completion-map observer for Mission Control.
 *
 * Observe-only. Scans the repository for unfinished systems, architectural
 * drift, disconnected features, TODO/FIXME/stub markers, missing tests,
 * orphaned scripts, and unregistered bots. Produces ranked recommendations
 * for the next best completion PR.
 *
 * Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status    — Agent identity, key system availability, registry/policy health
 *   scan      — Full repo observation: markers, gaps, orphans, missing coverage
 *   recommend — Ranked next-PR recommendations with selected_next_task
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Systems Steward v1';
const LABEL = 'OBSERVE ONLY / CONTINUITY AND COMPLETION MAP';
const BOT_ID = 'systems-steward';
const VALID_MODES = new Set(['status', 'scan', 'recommend']);

const MARKER_PATTERNS = [
  { label: 'TODO', regex: /\bTODO\b/ },
  { label: 'FIXME', regex: /\bFIXME\b/ },
  { label: 'placeholder', regex: /\bplaceholder\b/i },
  { label: 'stub', regex: /\bstub\b/i },
  { label: 'not_implemented', regex: /not\s+implemented/i },
  { label: 'planned', regex: /\/\/\s*planned\b/i },
  { label: 'future', regex: /\/\/\s*future\b/i },
];

const SCAN_DIRS = ['scripts', path.join('src', 'lib'), path.join('src', 'app', 'api'), path.join('src', 'components')];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.cjs', '.mjs']);
const SCAN_FILE_SIZE_LIMIT = 120 * 1024;
const SCAN_DEPTH_LIMIT = 6;

const KEY_GOVERNANCE_SCRIPTS = [
  'scripts/chief-arbiter.cjs',
  'scripts/release-governor.cjs',
  'scripts/security-governor.cjs',
  'scripts/mission-control-bot-system.cjs',
];

const GOVERNANCE_SCRIPT_ALIASES = {
  'chief-arbiter.cjs': 'govern:arbiter',
  'release-governor.cjs': 'govern:release',
  'mission-control-bot-system.cjs': 'govern:bot-system',
  'workflow-governor.cjs': 'govern:workflow',
  'security-governor.cjs': null,
  'security-arbiter.cjs': null,
  'security-executor.cjs': null,
  'security-hardening-runner.cjs': null,
};

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

function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > SCAN_FILE_SIZE_LIMIT) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function walkDir(dir, depth, results) {
  if (depth > SCAN_DEPTH_LIMIT) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, depth + 1, results);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(normalizePath(full));
    }
  }
}

function collectScanFiles(rootDir) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    walkDir(path.join(rootDir, dir), 0, files);
  }
  return unique(files);
}

function scanFileForMarkers(filePath, rootDir) {
  const content = readFileSafe(filePath);
  if (!content) return [];

  const relative = normalizePath(path.relative(rootDir, filePath));
  const lines = content.split(/\r?\n/);
  const hits = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { label, regex } of MARKER_PATTERNS) {
      if (regex.test(line)) {
        hits.push({
          file: relative,
          line: i + 1,
          marker: label,
          text: line.trim().slice(0, 120),
        });
        break;
      }
    }
  }

  return hits;
}

function loadBotSystem(rootDir, options = {}) {
  if (options.botSystemApi) return { available: true, api: options.botSystemApi };
  const scriptPath = path.join(rootDir, 'scripts', 'mission-control-bot-system.cjs');
  if (!fileExists(scriptPath)) return { available: false, error: 'mission-control-bot-system.cjs not found' };
  try {
    return { available: true, api: require(scriptPath) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function detectPlannedBotsWithoutScripts(registry, rootDir) {
  const bots = Array.isArray(registry && registry.bots) ? registry.bots : [];
  return bots
    .filter((bot) => bot.status !== 'implemented' && bot.status !== 'deferred' && bot.implementation_type === 'script')
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      category: bot.category,
      authority_level: bot.authority_level,
      script_expected: bot.implementation_script || `scripts/${bot.id}.cjs`,
      script_exists: fileExists(path.join(rootDir, bot.implementation_script || `scripts/${bot.id}.cjs`)),
    }));
}

function detectGovernanceScriptsWithoutTests(rootDir) {
  const scriptsDir = path.join(rootDir, 'scripts');
  const testsDir = path.join(rootDir, 'src', 'lib', '__tests__');
  if (!fileExists(scriptsDir)) return [];

  let scriptFiles;
  try {
    scriptFiles = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs'));
  } catch {
    return [];
  }

  const testFiles = fileExists(testsDir)
    ? fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'))
    : [];

  const governanceScripts = scriptFiles.filter((name) => {
    const stem = name.replace('.cjs', '');
    return [
      'security', 'governor', 'arbiter', 'executor', 'steward', 'runner',
      'mission-control', 'release', 'chief', 'systems',
    ].some((kw) => stem.includes(kw));
  });

  return governanceScripts
    .filter((scriptName) => {
      const stem = scriptName.replace('.cjs', '');
      return !testFiles.some((tf) => tf.includes(stem) || stem.includes(tf.replace('.test.ts', '')));
    })
    .map((scriptName) => ({
      script: `scripts/${scriptName}`,
      expected_test: `src/lib/__tests__/${scriptName.replace('.cjs', '.test.ts')}`,
    }));
}

function detectMissingPackageAliases(rootDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }

  const scriptValues = new Set(Object.values(pkg.scripts || {}).map((v) => String(v)));
  const missing = [];

  for (const [scriptFile, expectedAlias] of Object.entries(GOVERNANCE_SCRIPT_ALIASES)) {
    if (!expectedAlias) continue;
    const command = `node scripts/${scriptFile}`;
    if (!scriptValues.has(command)) {
      missing.push({ script: `scripts/${scriptFile}`, expected_alias: expectedAlias, command });
    }
  }

  return missing;
}

function detectOrphanedScripts(registry, rootDir) {
  const bots = Array.isArray(registry && registry.bots) ? registry.bots : [];
  const registeredScripts = new Set(
    bots
      .filter((b) => b.implementation_script)
      .map((b) => normalizePath(b.implementation_script)),
  );

  let scriptFiles;
  try {
    scriptFiles = fs.readdirSync(path.join(rootDir, 'scripts')).filter((f) => f.endsWith('.cjs'));
  } catch {
    return [];
  }

  const governancePatterns = [
    'governor', 'arbiter', 'executor', 'steward', 'runner', 'sentinel',
    'inspector', 'curator', 'migrator', 'manager', 'compiler',
  ];

  return scriptFiles
    .filter((name) => governancePatterns.some((kw) => name.includes(kw)))
    .map((name) => `scripts/${name}`)
    .filter((scriptPath) => !registeredScripts.has(normalizePath(scriptPath)))
    .map((scriptPath) => ({ script: scriptPath, status: 'not_in_registry' }));
}

function runScan(rootDir, options = {}) {
  const botSystemState = loadBotSystem(rootDir, options);
  let registry = null;
  let sharedState = null;

  if (botSystemState.available) {
    try {
      sharedState = botSystemState.api.buildSharedState(rootDir, options);
      registry = sharedState.registry;
    } catch {
      registry = null;
    }
  }

  const scanFiles = collectScanFiles(rootDir);
  const allMarkers = [];
  for (const filePath of scanFiles) {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(rootDir, filePath);
    allMarkers.push(...scanFileForMarkers(absolutePath, rootDir));
  }

  const markersByFile = {};
  for (const hit of allMarkers) {
    if (!markersByFile[hit.file]) markersByFile[hit.file] = [];
    markersByFile[hit.file].push(hit);
  }

  const plannedBotsWithoutScripts = registry
    ? detectPlannedBotsWithoutScripts(registry, rootDir)
    : [];

  const governanceScriptsWithoutTests = detectGovernanceScriptsWithoutTests(rootDir);
  const missingPackageAliases = detectMissingPackageAliases(rootDir);
  const orphanedScripts = registry ? detectOrphanedScripts(registry, rootDir) : [];

  const markerSummary = MARKER_PATTERNS.reduce((acc, { label }) => {
    acc[label] = allMarkers.filter((m) => m.marker === label).length;
    return acc;
  }, {});

  return {
    files_scanned: scanFiles.length,
    total_markers: allMarkers.length,
    marker_summary: markerSummary,
    markers_by_file: markersByFile,
    planned_bots_without_scripts: plannedBotsWithoutScripts,
    governance_scripts_without_tests: governanceScriptsWithoutTests,
    missing_package_aliases: missingPackageAliases,
    orphaned_scripts: orphanedScripts,
    registry_loaded: Boolean(registry),
    hierarchy_warnings: sharedState ? sharedState.hierarchyWarnings : [],
  };
}

function buildRecommendations(scanResult, rootDir) {
  const recs = [];

  const plannedBots = (scanResult.planned_bots_without_scripts || [])
    .sort((a, b) => a.authority_level - b.authority_level);

  if (plannedBots.length > 0) {
    const nextBot = plannedBots[0];
    recs.push({
      title: `Implement ${nextBot.name} (${nextBot.id})`,
      reason: `Bot is registered in the registry at authority level ${nextBot.authority_level} but has no implementation script.`,
      evidence: `config/mission-control-bot-registry.json lists ${nextBot.id} as planned. Expected script: ${nextBot.script_expected}`,
      risk_level: nextBot.authority_level <= 3 ? 'High' : 'Medium',
      likely_files: [nextBot.script_expected, `src/lib/__tests__/${nextBot.id}.test.ts`],
      validation_commands: ['pnpm vitest run', 'pnpm typecheck', 'pnpm lint'],
      requires_governor_or_arbiter: nextBot.authority_level <= 3,
      autonomous_safe: nextBot.authority_level > 3,
    });

    if (plannedBots.length > 1) {
      const remaining = plannedBots.slice(1, 4);
      recs.push({
        title: `Implement remaining planned bots (${remaining.length} of ${plannedBots.length - 1} shown)`,
        reason: `${plannedBots.length} planned bots have no implementation scripts.`,
        evidence: `Planned: ${plannedBots.map((b) => b.id).join(', ')}`,
        risk_level: 'Medium',
        likely_files: remaining.map((b) => b.script_expected),
        validation_commands: ['pnpm vitest run', 'pnpm typecheck'],
        requires_governor_or_arbiter: false,
        autonomous_safe: true,
      });
    }
  }

  const scriptsWithoutTests = scanResult.governance_scripts_without_tests || [];
  if (scriptsWithoutTests.length > 0) {
    recs.push({
      title: `Add tests for ${scriptsWithoutTests.length} untested governance scripts`,
      reason: 'Governance scripts without tests cannot be safely validated in CI.',
      evidence: scriptsWithoutTests.map((s) => s.script).join(', '),
      risk_level: 'Low',
      likely_files: scriptsWithoutTests.map((s) => s.expected_test),
      validation_commands: ['pnpm vitest run', 'pnpm typecheck', 'pnpm lint'],
      requires_governor_or_arbiter: false,
      autonomous_safe: true,
    });
  }

  const markerFiles = Object.keys(scanResult.markers_by_file || {});
  if (markerFiles.length > 0) {
    const topFiles = markerFiles
      .map((f) => ({ file: f, count: scanResult.markers_by_file[f].length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    recs.push({
      title: `Resolve TODO/FIXME markers (${scanResult.total_markers} across ${markerFiles.length} files)`,
      reason: 'Unresolved markers indicate incomplete implementations or known technical debt.',
      evidence: `Top files: ${topFiles.map((f) => `${f.file} (${f.count})`).join(', ')}`,
      risk_level: 'Low',
      likely_files: topFiles.map((f) => f.file),
      validation_commands: ['pnpm vitest run', 'pnpm typecheck'],
      requires_governor_or_arbiter: false,
      autonomous_safe: true,
    });
  }

  const missingAliases = scanResult.missing_package_aliases || [];
  if (missingAliases.length > 0) {
    recs.push({
      title: `Add missing package.json aliases for ${missingAliases.length} governance scripts`,
      reason: 'Governance scripts without aliases require manual path invocation.',
      evidence: missingAliases.map((a) => `${a.expected_alias} -> ${a.command}`).join(', '),
      risk_level: 'Tooling',
      likely_files: ['package.json'],
      validation_commands: ['pnpm test', 'pnpm typecheck'],
      requires_governor_or_arbiter: false,
      autonomous_safe: true,
    });
  }

  const orphans = scanResult.orphaned_scripts || [];
  if (orphans.length > 0) {
    recs.push({
      title: `Register or remove ${orphans.length} unregistered governance scripts`,
      reason: 'Governance scripts not in the bot registry are outside policy authority.',
      evidence: orphans.map((o) => o.script).join(', '),
      risk_level: 'Medium',
      likely_files: ['config/mission-control-bot-registry.json', ...orphans.map((o) => o.script)],
      validation_commands: ['node scripts/mission-control-bot-system.cjs status', 'pnpm test'],
      requires_governor_or_arbiter: true,
      autonomous_safe: false,
    });
  }

  recs.sort((a, b) => {
    const order = { High: 0, Medium: 1, Low: 2, Tooling: 3 };
    return (order[a.risk_level] ?? 4) - (order[b.risk_level] ?? 4);
  });

  return recs;
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

function summarize(result) {
  return [
    `${AGENT} (${LABEL})`,
    `Mode: ${result.mode}`,
    `Status: ${result.status}`,
  ].join('\n');
}

function buildStatusMode(rootDir, options = {}) {
  const warnings = [];
  const botSystemState = loadBotSystem(rootDir, options);
  let implementedBots = [];
  let plannedBots = [];

  if (botSystemState.available) {
    try {
      const shared = botSystemState.api.buildSharedState(rootDir, options);
      implementedBots = shared.detection.implemented;
      plannedBots = shared.detection.missing_planned_bots;
      warnings.push(...shared.hierarchyWarnings);
      if (plannedBots.length > 0) {
        warnings.push(`${plannedBots.length} planned bots awaiting implementation`);
      }
    } catch (error) {
      warnings.push(`Bot system state error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push(`Bot system unavailable: ${botSystemState.error}`);
  }

  const keySystemStatus = KEY_GOVERNANCE_SCRIPTS.map((scriptPath) => ({
    script: normalizePath(scriptPath),
    available: fileExists(path.join(rootDir, scriptPath)),
  }));

  const result = buildOutput('status', {
    status: warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    metadata: {
      implemented_bots: implementedBots,
      planned_bots: plannedBots,
      key_systems: keySystemStatus,
      bot_system_available: botSystemState.available,
      observe_only: true,
    },
  });
  result.summary = summarize(result);
  return result;
}

function buildScanMode(rootDir, options = {}) {
  const scanResult = runScan(rootDir, options);
  const warnings = [];

  if (scanResult.total_markers > 0) {
    warnings.push(`${scanResult.total_markers} TODO/FIXME/stub markers across ${Object.keys(scanResult.markers_by_file).length} files`);
  }
  if (scanResult.planned_bots_without_scripts.length > 0) {
    warnings.push(`${scanResult.planned_bots_without_scripts.length} planned bots have no implementation script`);
  }
  if (scanResult.governance_scripts_without_tests.length > 0) {
    warnings.push(`${scanResult.governance_scripts_without_tests.length} governance scripts have no test coverage`);
  }
  if (scanResult.missing_package_aliases.length > 0) {
    warnings.push(`${scanResult.missing_package_aliases.length} governance scripts missing npm aliases`);
  }
  if (scanResult.orphaned_scripts.length > 0) {
    warnings.push(`${scanResult.orphaned_scripts.length} governance scripts not registered in bot registry`);
  }

  const result = buildOutput('scan', {
    status: warnings.length > 0 ? 'WARN' : 'PASS',
    warnings,
    metadata: {
      files_scanned: scanResult.files_scanned,
      total_markers: scanResult.total_markers,
      marker_summary: scanResult.marker_summary,
      markers_by_file: scanResult.markers_by_file,
      planned_bots_without_scripts: scanResult.planned_bots_without_scripts,
      governance_scripts_without_tests: scanResult.governance_scripts_without_tests,
      missing_package_aliases: scanResult.missing_package_aliases,
      orphaned_scripts: scanResult.orphaned_scripts,
      hierarchy_warnings: scanResult.hierarchy_warnings,
    },
  });
  result.summary = summarize(result);
  return result;
}

function buildRecommendMode(rootDir, options = {}) {
  const scanResult = runScan(rootDir, options);
  const recommendations = buildRecommendations(scanResult, rootDir);
  const selectedNextTask = recommendations.find((r) => r.autonomous_safe) || recommendations[0] || null;

  const result = buildOutput('recommend', {
    status: recommendations.length > 0 ? 'WARN' : 'PASS',
    warnings: recommendations.length > 0
      ? [`${recommendations.length} completion opportunities identified`]
      : [],
    metadata: {
      total_recommendations: recommendations.length,
      recommendations,
      selected_next_task: selectedNextTask,
      scan_summary: {
        total_markers: scanResult.total_markers,
        planned_bots: scanResult.planned_bots_without_scripts.length,
        scripts_without_tests: scanResult.governance_scripts_without_tests.length,
      },
    },
  });
  result.summary = [
    summarize(result),
    selectedNextTask
      ? `Selected next task: ${selectedNextTask.title}`
      : 'No recommendations — system appears complete.',
  ].join('\n');
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  return { mode };
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'scan') return buildScanMode(rootDir, options);
  if (parsed.mode === 'recommend') return buildRecommendMode(rootDir, options);
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  MARKER_PATTERNS,
  buildOutput,
  buildRecommendMode,
  buildRecommendations,
  buildScanMode,
  buildStatusMode,
  collectScanFiles,
  detectGovernanceScriptsWithoutTests,
  detectMissingPackageAliases,
  detectOrphanedScripts,
  detectPlannedBotsWithoutScripts,
  fileExists,
  formatOutput,
  loadBotSystem,
  main,
  normalizePath,
  parseArgs,
  runScan,
  scanFileForMarkers,
  summarize,
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
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
