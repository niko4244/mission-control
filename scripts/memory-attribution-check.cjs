#!/usr/bin/env node
/**
 * memory-attribution-check.cjs — Attribution loop validation
 *
 * Tests the exact flow:
 * 1. Write or load 3 candidate memories
 * 2. Recall them for a prompt
 * 3. Mark outcome success for primary pattern
 * 4. Verify signal accumulation is correct
 */

'use strict';

const memoryApi = require('./memory-api.cjs');
const Database = require('better-sqlite3');
const path = require('node:path');
const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const DB_PATH = path.join(HOMEDIR, 'mission-control', '.data', 'mission-control.db');
const db = new Database(DB_PATH);

/**
 * Check attribution signals
 */
function checkAttribution() {
  console.log('=== ATTRIBUTION LOOP CHECK ===\n');

  const checks = [];
  let passed = true;

  // Test 1: Write 3 candidate memories
  console.log('Step 1: Writing 3 candidate memories. ..');

  const candidate1 = memoryApi.write({
    source: 'cli',
    category: 'execution',
    content: 'Pattern A: Always validate inputs first.',
    tags: 'outcome:success',
    confidence: 0.8,
    agent: 'cli',
    sourceRef: 'source:cli|pattern_success:+1|outcome:success'
  });
  console.log(`  Created: ${candidate1.id}`);

  const candidate2 = memoryApi.write({
    source: 'cli',
    category: 'execution',
    content: 'Pattern B: Use timeouts for long operations.',
    tags: 'outcome:success',
    confidence: 0.7,
    agent: 'cli',
    sourceRef: 'source:cli|pattern_success:+1|outcome:success'
  });
  console.log(`  Created: ${candidate2.id}`);

  const candidate3 = memoryApi.write({
    source: 'cli',
    category: 'execution',
    content: 'Pattern C: Handle database connections properly.',
    tags: 'outcome:success',
    confidence: 0.6,
    agent: 'cli',
    sourceRef: 'source:cli|pattern_success:+1|outcome:success'
  });
  console.log(`  Created: ${candidate3.id}`);

  checks.push({
    name: 'Step 1: Write 3 candidates',
    passed: true,
    details: 'Successfully wrote 3 candidate memories'
  });

  // Test 2: Recall for a prompt
  console.log('\nStep 2: Recalling memories for prompt. ..');

  const recallResult = memoryApi.recall('cli', {
    prompt: 'validate input or timeout',
    limit: 5
  });

  console.log(`  Selected: ${recallResult.selected.length} memories`);
  console.log(`  Used patterns: ${recallResult.usedPatterns.join(', ') || 'none'}`);

  if (recallResult.usedPatterns.length === 0) {
    console.log('  WARNING: No patterns used in recall');
    checks.push({
      name: 'Step 2: Recall memories',
      passed: false,
      details: 'No patterns were selected for recall'
    });
  } else {
    checks.push({
      name: 'Step 2: Recall memories',
      passed: true,
      details: `Selected ${recallResult.selected.length} memories, used patterns ${recallResult.usedPatterns.join(', ')}`
    });
  }

  // Test 3: Mark outcome success for all used patterns
  console.log('\nStep 3: Marking outcome success for all used patterns. ..');

  const primaryPattern = recallResult.usedPatterns[0];
  console.log(`  Primary pattern: ${primaryPattern}`);
  console.log(`  Used patterns: ${recallResult.usedPatterns.join(', ')}`);

  // Mark primary pattern with success
  const outcomeResult = memoryApi.markOutcome(primaryPattern, 'success', {
    usedPatterns: recallResult.usedPatterns,
    primaryPatternId: primaryPattern,
    runId: 'test_run_001'
  });

  console.log(`  Primary result: ${JSON.stringify(outcomeResult)}`);

  // Mark other used patterns without primaryPatternId to avoid win/loss signals
  for (let i = 1; i < recallResult.usedPatterns.length; i++) {
    const patternId = recallResult.usedPatterns[i];
    memoryApi.markOutcome(patternId, 'success', {
      usedPatterns: [patternId],
      runId: 'test_run_001'
    });
    console.log(`  Pattern ${patternId} marked as success`);
  }

  // Verify outcome tag was set
  if (outcomeResult.updated) {
    checks.push({
      name: 'Step 3: Mark outcome success',
      passed: true,
      details: `Outcome updated for pattern ${primaryPattern}`
    });
  } else {
    checks.push({
      name: 'Step 3: Mark outcome success',
      passed: false,
      details: `Failed to update outcome: ${outcomeResult.reason}`
    });
    passed = false;
  }

  // Test 4: Verify signal accumulation
  console.log('\nStep 4: Verifying signal accumulation. ..');

  // Check primary pattern signals
  const primaryRow = db.prepare('SELECT source_ref FROM memory_entries WHERE id = ?').get(primaryPattern);
  const primarySrc = primaryRow?.source_ref || '';

  const hasSuccessSignal = primarySrc.includes('pattern_success:+1');
  const hasAppliedSignal = primarySrc.includes('applied_pattern:+1');
  const hasWinSignal = primarySrc.includes('pattern_win:+1');
  const hasCompetingGroup = primarySrc.includes('competing_group:test_run_001');

  console.log(`  Primary pattern signals:`);
  console.log(`    pattern_success:+1: ${hasSuccessSignal ? 'YES' : 'NO'}`);
  console.log(`    applied_pattern:+1: ${hasAppliedSignal ? 'YES' : 'NO'}`);
  console.log(`    pattern_win:+1: ${hasWinSignal ? 'YES' : 'NO'}`);
  console.log(`    competing_group:test_run_001: ${hasCompetingGroup ? 'YES' : 'NO'}`);

  if (hasSuccessSignal && hasAppliedSignal && hasWinSignal && hasCompetingGroup) {
    checks.push({
      name: 'Step 4: Primary pattern signals',
      passed: true,
      details: 'Primary pattern has all expected signals'
    });
  } else {
    checks.push({
      name: 'Step 4: Primary pattern signals',
      passed: false,
      details: 'Primary pattern missing some signals'
    });
    passed = false;
  }

  // Check non-primary used patterns
  console.log('\nStep 5: Checking non-primary used patterns. ..');

  const nonPrimaryPatterns = recallResult.usedPatterns.filter(id => id !== primaryPattern);
  for (const nonPrimaryId of nonPrimaryPatterns) {
    const nonPrimaryRow = db.prepare('SELECT source_ref FROM memory_entries WHERE id = ?').get(nonPrimaryId);
    const nonPrimarySrc = nonPrimaryRow?.source_ref || '';

    const hasNonPrimaryApplied = nonPrimarySrc.includes('applied_pattern:+1');
    const hasNonPrimaryCompeting = nonPrimarySrc.includes('competing_group:test_run_001');

    console.log(`  Pattern ${nonPrimaryId}:`);
    console.log(`    applied_pattern:+1: ${hasNonPrimaryApplied ? 'YES' : 'NO'}`);
    console.log(`    competing_group:test_run_001: ${hasNonPrimaryCompeting ? 'YES' : 'NO'}`);

    if (hasNonPrimaryApplied && hasNonPrimaryCompeting) {
      checks.push({
        name: `Step 5: Non-primary pattern ${nonPrimaryId}`,
        passed: true,
        details: `Non-primary pattern has applied and competing_group signals`
      });
    } else {
      checks.push({
        name: `Step 5: Non-primary pattern ${nonPrimaryId}`,
        passed: false,
        details: `Non-primary pattern missing some signals`
      });
      passed = false;
    }
  }

  // Check unused patterns should NOT have signals
  console.log('\nStep 6: Checking unused patterns. ..');

  // Find a pattern that was NOT used in recall - these are truly unused
  // Skip patterns with low IDs that might be from previous tests
  const allPatternIds = db.prepare('SELECT id FROM memory_entries WHERE category = ?').all('execution').map(r => r.id);
  const recentPatternIds = allPatternIds.filter(id => id > 20); // Skip old patterns from harness
  const unusedPatterns = recentPatternIds.filter(id => !recallResult.usedPatterns.includes(id)).slice(0, 2);

  console.log(`  Unused patterns: ${unusedPatterns.join(', ') || 'none'}`);

  for (const unusedId of unusedPatterns) {
    const unusedRow = db.prepare('SELECT source_ref FROM memory_entries WHERE id = ?').get(unusedId);
    const unusedSrc = unusedRow?.source_ref || '';

    // Check that unused patterns didn't get applied_pattern or win/loss
    const hasApplied = unusedSrc.includes('applied_pattern:+1');
    const hasWin = unusedSrc.includes('pattern_win:+1');
    const hasLoss = unusedSrc.includes('pattern_loss:+1');

    if (!hasApplied && !hasWin && !hasLoss) {
      checks.push({
        name: `Step 6: Unused pattern ${unusedId}`,
        passed: true,
        details: 'Unused pattern correctly has no applied/win/loss signals'
      });
    } else {
      checks.push({
        name: `Step 6: Unused pattern ${unusedId}`,
        passed: false,
        details: 'Unused pattern incorrectly has signals'
      });
      passed = false;
    }
  }

  // Test 7: Failure outcome test
  console.log('\nStep 7: Testing failure outcome. ..');

  const failureResult = memoryApi.markOutcome(primaryPattern, 'failure', {
    usedPatterns: [primaryPattern],
    primaryPatternId: primaryPattern,
    runId: 'test_run_002'
  });

  const primaryAfter = db.prepare('SELECT source_ref FROM memory_entries WHERE id = ?').get(primaryPattern);
  const primaryAfterSrc = primaryAfter?.source_ref || '';

  const hasFailureSignal = primaryAfterSrc.includes('pattern_failure:+1');
  const hasLossSignal = primaryAfterSrc.includes('pattern_loss:+1');
  const hasCompetingGroup2 = primaryAfterSrc.includes('competing_group:test_run_002');

  console.log(`  Pattern signals after failure:`);
  console.log(`    pattern_failure:+1: ${hasFailureSignal ? 'YES' : 'NO'}`);
  console.log(`    pattern_loss:+1: ${hasLossSignal ? 'YES' : 'NO'}`);
  console.log(`    competing_group:test_run_002: ${hasCompetingGroup2 ? 'YES' : 'NO'}`);

  if (hasFailureSignal && hasLossSignal && hasCompetingGroup2) {
    checks.push({
      name: 'Step 7: Failure outcome signals',
      passed: true,
      details: 'Failure outcome correctly updates signals'
    });
  } else {
    checks.push({
      name: 'Step 7: Failure outcome signals',
      passed: false,
      details: 'Failure outcome not correctly updating signals'
    });
    passed = false;
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Passed: ${passed ? 'YES' : 'NO'}`);
  console.log('\nChecks:');
  checks.forEach(c => {
    console.log(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.name}: ${c.details}`);
  });

  return {
    passed,
    checks
  };
}

// Run check
const result = checkAttribution();

// Exit with appropriate code
process.exit(result.passed ? 0 : 1);
