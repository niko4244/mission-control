#!/usr/bin/env node
/**
 * mc-memory.cjs — Mission Control memory CLI
 *
 * Subcommands:
 *   recall  — Recall memories for a prompt
 *   audit   — Audit top memories with full info
 *   write   — Write a new memory entry
 *   outcome — Mark outcome for a memory
 *   status   — Show memory status
 *   health   — Health check
 */

'use strict';

const path = require('node:path');
const memoryApi = require('./memory-api.cjs');

// Database path
const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const DB_PATH = process.env.MISSION_CONTROL_DATA_DIR
  ? path.join(process.env.MISSION_CONTROL_DATA_DIR, '.data', 'mission-control.db')
  : path.join(HOMEDIR, 'mission-control', '.data', 'mission-control.db');

/**
 * Print usage
 */
function printUsage() {
  console.log(`
Mission Control Memory CLI

Usage: node mc-memory.js <command> [options]

Commands:
  recall <prompt> [options]   Recall memories for a prompt
  audit <prompt> [options]    Audit top memories with full info
  write <content> [options]   Write a new memory entry
  outcome <id> <outcome>      Mark outcome for a memory
  status                      Show memory status
  health                      Health check

Recall options:
  --agent <agent>             Agent name (required)
  --limit <n>                 Limit results (default: 3)
  --run-id <id>               Run ID for attribution
  --explore                   Explore mode
  --random-explore            Random exploration

Audit options:
  --limit <n>                 Limit results (default: 10)
  --run-id <id>               Run ID for attribution

Write options:
  --source <source>           Source (default: cli)
  --category <category>       Category (default: execution)
  --agent <agent>             Agent name
  --tags <tags>               Tags
  --confidence <n>            Confidence (0-1)
  --source-ref <ref>          Source reference string

Outcome options:
  --used-patterns <ids>       Comma-separated list of used pattern IDs
  --primary-pattern-id <id>   Primary pattern ID
  --run-id <id>               Run ID for attribution

Examples:
  node mc-memory.js recall "validate input" --agent hermes --limit 3
  node mc-memory.js audit "handle timeout" --agent hermes --limit 10
  node mc-memory.js write "Always validate inputs..." --source cli --category execution
  node mc-memory.js outcome 3 success --used-patterns 1,2,3 --primary-pattern-id 1 --run-id run_abc
  node mc-memory.js status
  node mc-memory.js health
`);
}

/**
 * Format memory entries for table display
 */
function formatMemories(memories, limit = 3) {
  const mems = memories.slice(0, limit);
  if (mems.length === 0) {
    return { header: '', rows: [] };
  }

  // Build rows with simple formatting
  const rows = mems.map(m => {
    const content = m.content.slice(0, 60);
    const score = m.score != null ? m.score.toFixed(2) : 'n/a';
    const level = m.promotion_level || 'observation';
    const valid = m.validation_score > 0 ? '+' + m.validation_score.toFixed(1) : m.validation_score.toFixed(1);
    const clusterSuccess = m.cluster_success_count > 0 ? m.cluster_success_count.toString() : '';
    const clusterFailure = m.cluster_failure_count > 0 ? m.cluster_failure_count.toString() : '';
    const causality = m.causality_score > 0 ? m.causality_score.toFixed(2) : '';
    const explanation = m.explanation || 'Ranked by score';

    return `${content.padEnd(60)} | ${score.padStart(8)} | ${level.padStart(15)} | ${valid.padStart(7)} | ${clusterSuccess.padEnd(10)} | ${clusterFailure.padEnd(10)} | ${causality.padEnd(10)} | ${explanation}`;
  });

  // Build header
  const header = `Content | Score  | Level           | Valid  | ClustSuccess | ClustFailure | Causality | Explanation`;

  return { header, rows };
}

/**
 * Format single memory for table display
 */
function formatSingleMemory(memory) {
  if (!memory) return { header: '', rows: [] };

  // Build rows with simple formatting
  const rows = [
    `ID: ${memory.id}`,
    `Content: ${memory.content || ''}`,
    `Tags: ${memory.tags || ''}`,
    `Score: ${memory.score != null ? memory.score.toFixed(2) : 'n/a'}`,
    `Promotion Level: ${memory.promotion_level || 'observation'}`,
    `Validation Score: ${memory.validation_score > 0 ? '+' + memory.validation_score.toFixed(1) : memory.validation_score.toFixed(1)}`,
    `Cluster Success Count: ${memory.cluster_success_count > 0 ? memory.cluster_success_count.toString() : ''}`,
    `Cluster Failure Count: ${memory.cluster_failure_count > 0 ? memory.cluster_failure_count.toString() : ''}`,
    `Causality Score: ${memory.causality_score > 0 ? '+' + memory.causality_score.toFixed(2) : ''}`,
    `Failure Boost: ${memory.failure_boost > 0 ? '+' + memory.failure_boost.toFixed(1) : ''}`,
    `Competition Boost: ${memory.competition_boost > 0 ? '+' + memory.competition_boost.toFixed(1) : ''}`,
    `Explanation: ${memory.explanation || 'N/A'}`,
    `Source Ref: ${memory.source_ref || 'N/A'}`
  ];

  return { header: 'Memory Entry Details', rows };
}

/**
 * Main handler
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const cmdArgs = args.slice(1);

  switch (command) {
    case 'recall': {
      if (cmdArgs.length === 0) {
        console.error('Error: recall requires a prompt');
        printUsage();
        process.exit(1);
      }

      const prompt = cmdArgs[0];
      let agent = cmdArgs[1];
      let limit = 3;
      let runId = null;
      let explore = false;
      let randomExplore = false;

      // Parse options
      for (let i = 2; i < cmdArgs.length; i++) {
        const arg = cmdArgs[i];
        if (arg === '--agent' && cmdArgs[i + 1]) {
          agent = cmdArgs[++i];
        } else if (arg === '--limit' && cmdArgs[i + 1]) {
          limit = parseInt(cmdArgs[++i], 10);
        } else if (arg === '--run-id' && cmdArgs[i + 1]) {
          runId = cmdArgs[++i];
        } else if (arg === '--explore') {
          explore = true;
        } else if (arg === '--random-explore') {
          randomExplore = true;
        } else if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
      }

      if (!agent) {
        console.error('Error: --agent is required');
        printUsage();
        process.exit(1);
      }

      const result = await memoryApi.recall(agent, { prompt, limit, runId, explore, randomExplore });

      // Print header
      console.log();
      console.log(`=== Memory Recall for: "${prompt}" ===`);
      console.log(`Run ID: ${runId || 'N/A'}`);
      console.log(`Used Patterns: ${result.usedPatterns.join(', ') || 'none'}`);
      console.log(`Found: ${result.selected.length} memories`);
      console.log();

      // Print memories
      const { header, rows } = formatMemories(result.selected, limit);
      console.log(header);
      console.log('-'.repeat(header.length));
      rows.forEach(row => console.log(row));
      console.log();
      console.log(`Pruned: ${result.pruned_count}, Merged: ${result.merged_count}`);
      console.log();

      process.exit(0);
    }

    case 'audit': {
      if (cmdArgs.length === 0) {
        console.error('Error: audit requires a prompt');
        printUsage();
        process.exit(1);
      }

      const prompt = cmdArgs[0];
      let agent = cmdArgs[1];
      let limit = 10;
      let runId = null;

      // Parse options
      for (let i = 2; i < cmdArgs.length; i++) {
        const arg = cmdArgs[i];
        if (arg === '--agent' && cmdArgs[i + 1]) {
          agent = cmdArgs[++i];
        } else if (arg === '--limit' && cmdArgs[i + 1]) {
          limit = parseInt(cmdArgs[++i], 10);
        } else if (arg === '--run-id' && cmdArgs[i + 1]) {
          runId = cmdArgs[++i];
        } else if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
      }

      if (!agent) {
        console.error('Error: --agent is required');
        printUsage();
        process.exit(1);
      }

      const result = await memoryApi.audit(agent, { prompt, limit, runId });

      // Print summary
      console.log();
      console.log(`=== Memory Audit for: "${prompt}" ===`);
      console.log(`Candidates: ${result.summary.total_candidates}`);
      console.log(`Returned: ${result.summary.returned}`);
      console.log(`Top Score: ${result.summary.top_score.toFixed(2)}`);
      console.log(`Warnings: ${result.summary.warning_count}`);
      console.log();

      // Print entries
      const { header, rows } = formatMemories(result.entries, limit);
      console.log(header);
      console.log('-'.repeat(header.length));
      rows.forEach(row => console.log(row));
      console.log();

      // Print warnings
      if (result.summary.warning_count > 0) {
        console.log('Warnings:');
        result.summary.warnings.forEach(w => {
          console.log(`  [${w.severity.toUpperCase()}] Entry ${w.entryId}: ${w.reason}`);
        });
      }
      console.log();

      process.exit(0);
    }

    case 'write': {
      if (cmdArgs.length === 0) {
        console.error('Error: write requires content');
        printUsage();
        process.exit(1);
      }

      const content = cmdArgs[0];
      let source = 'cli';
      let category = 'execution';
      let agent = null;
      let taskId = null;
      let runId = null;
      let tags = null;
      let confidence = null;
      let sourceRef = null;
      let project = null;
      let rawExecutionLog = false;

      // Parse options
      for (let i = 1; i < cmdArgs.length; i++) {
        const arg = cmdArgs[i];
        if (arg === '--source' && cmdArgs[i + 1]) {
          source = cmdArgs[++i];
        } else if (arg === '--category' && cmdArgs[i + 1]) {
          category = cmdArgs[++i];
        } else if (arg === '--agent' && cmdArgs[i + 1]) {
          agent = cmdArgs[++i];
        } else if (arg === '--task-id' && cmdArgs[i + 1]) {
          taskId = cmdArgs[++i];
        } else if (arg === '--run-id' && cmdArgs[i + 1]) {
          runId = cmdArgs[++i];
        } else if (arg === '--tags' && cmdArgs[i + 1]) {
          tags = cmdArgs[++i];
        } else if (arg === '--confidence' && cmdArgs[i + 1]) {
          confidence = parseFloat(cmdArgs[++i]);
        } else if (arg === '--source-ref' && cmdArgs[i + 1]) {
          sourceRef = cmdArgs[++i];
        } else if (arg === '--project' && cmdArgs[i + 1]) {
          project = cmdArgs[++i];
        } else if (arg === '--raw-execution-log') {
          rawExecutionLog = true;
        } else if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
      }

      const result = await memoryApi.write({
        source,
        category,
        content,
        agent,
        taskId,
        runId,
        tags,
        confidence,
        sourceRef,
        project,
        rawExecutionLog
      });

      console.log();
      console.log(`Memory written with ID: ${result.id}`);
      console.log();

      process.exit(0);
    }

    case 'outcome': {
      if (cmdArgs.length < 2) {
        console.error('Error: outcome requires an ID and outcome (success|failure)');
        printUsage();
        process.exit(1);
      }

      const id = parseInt(cmdArgs[0], 10);
      const outcome = cmdArgs[1];
      const usedPatterns = cmdArgs[2]?.split(',').map(n => parseInt(n.trim(), 10));
      const primaryPatternId = cmdArgs[2]?.split(',').find(n => n.startsWith('-')) || null;
      const runId = cmdArgs[2]?.split(',').find(n => n.startsWith('--')) || null;

      // Parse options
      for (let i = 3; i < cmdArgs.length; i++) {
        const arg = cmdArgs[i];
        if (arg === '--used-patterns' && cmdArgs[i + 1]) {
          usedPatterns = cmdArgs[++i].split(',').map(n => parseInt(n.trim(), 10));
        } else if (arg === '--primary-pattern-id' && cmdArgs[i + 1]) {
          primaryPatternId = parseInt(cmdArgs[++i], 10);
        } else if (arg === '--run-id' && cmdArgs[i + 1]) {
          runId = cmdArgs[++i];
        } else if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
      }

      if (!usedPatterns && !primaryPatternId) {
        console.error('Error: either --used-patterns or --primary-pattern-id is required');
        process.exit(1);
      }

      const result = await memoryApi.markOutcome(id, outcome, {
        usedPatterns,
        primaryPatternId,
        runId
      });

      console.log();
      console.log(`Outcome marked for memory ${id}: ${result.outcome}`);
      console.log(`Updated: ${result.updated}`);
      if (result.reason) {
        console.log(`Reason: ${result.reason}`);
      }
      console.log();

      process.exit(0);
    }

    case 'status': {
      const result = await memoryApi.status();

      console.log();
      console.log(`=== Memory Status ===`);
      console.log(`Total memories: ${result.total_memories}`);
      console.log();
      console.log(`By source:`);
      result.by_source.forEach(r => {
        console.log(`  ${r.source}: ${r.count}`);
      });
      console.log();
      console.log(`By category:`);
      result.by_category.forEach(r => {
        console.log(`  ${r.category}: ${r.count}`);
      });
      console.log();
      console.log(`Outcome counts:`);
      console.log(`  success: ${result.outcome_counts.success || 0}`);
      console.log(`  failure: ${result.outcome_counts.failure || 0}`);
      console.log(`  unknown: ${result.outcome_counts.unknown || 0}`);
      console.log();
      console.log(`Promotion counts:`);
      console.log(`  core_rule: ${result.promoted_counts.core_rule || 0}`);
      console.log(`  validated_pattern: ${result.promoted_counts.validated_pattern || 0}`);
      console.log(`  candidate_pattern: ${result.promoted_counts.candidate_pattern || 0}`);
      console.log(`  observation: ${result.promoted_counts.observation || 0}`);
      console.log();
      console.log(`Recent memories: ${result.recent_count}`);
      if (result.warnings.length > 0) {
        console.log();
        console.log('Warnings:');
        result.warnings.forEach(w => console.log(`  - ${w}`));
      }
      console.log();

      process.exit(0);
    }

    case 'health': {
      const result = await memoryApi.health();

      console.log();
      console.log(`=== Health Check ===`);
      console.log(`Status: ${result.ok ? 'OK' : 'ISSUES DETECTED'}`);
      console.log();
      console.log('Checks:');
      console.log(`  Database accessible: ${result.checks.memory_db_accessible}`);
      console.log(`  Required exports present: ${result.checks.required_exports_present}`);
      console.log(`  Deterministic scoring: ${result.checks.deterministic_scoring}`);
      console.log(`  No NaN scores: ${result.checks.no_nan_score}`);
      console.log();

      if (result.issues.length > 0) {
        console.log('Issues:');
        result.issues.forEach(issue => console.log(`  - ${issue}`));
        console.log();
        process.exit(1);
      }

      console.log('All checks passed');
      console.log();

      process.exit(0);
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
