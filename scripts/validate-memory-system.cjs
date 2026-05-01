#!/usr/bin/env node
/**
 * validate-memory-system.cjs
 * Full validation: recall, audit, attribution, learning loop, failure handling.
 * No code modification — observation only.
 */
'use strict';

const memoryApi = require('./memory-api.cjs');
const memoryService = require('./memory-service.cjs');

// ============================================================================
// HELPERS
// ============================================================================

function sep(title) {
  console.log('\n' + '='.repeat(60));
  console.log(' ' + title);
  console.log('='.repeat(60));
}

function sub(label) {
  console.log('\n--- ' + label + ' ---');
}

function fmt(val, digits = 3) {
  if (val == null) return 'null';
  if (typeof val === 'number') return val.toFixed(digits);
  return String(val);
}

function printEntry(rank, e) {
  console.log(`  [${rank}] id=${e.id} score=${fmt(e.score)} promo=${e.promotion_level}`);
  console.log(`       valid=${fmt(e.validation_score)} causality=${fmt(e.causality_score)} clust_s=${e.cluster_success_count} clust_f=${e.cluster_failure_count}`);
  console.log(`       win_rate=${fmt(e.win_rate)} fail_boost=${fmt(e.failure_boost)} expl: "${e.explanation}"`);
  console.log(`       content: "${(e.content || '').substring(0, 100)}"`);
}

function printAuditEntry(rank, e) {
  const warn = (e.score > 4 && e.validation_score <= 1) ? ' ⚠ HIGH_SCORE_LOW_VALID' : '';
  const warn2 = (e.score > 4 && e.cluster_failure_count > e.cluster_success_count) ? ' ⚠ FAILURE_HEAVY' : '';
  const warn3 = (e.score > 4 && e.contentMatch < 0.3) ? ' ⚠ LOW_CONTENT_MATCH' : '';
  console.log(`  [${rank}] id=${e.id} score=${fmt(e.score)} promo=${e.promotion_level}${warn}${warn2}${warn3}`);
  console.log(`       valid=${fmt(e.validation_score)} causality=${fmt(e.causality_score)} content_match=${fmt(e.contentMatch || 0)}`);
  console.log(`       content: "${(e.content || '').substring(0, 100)}"`);
}

// ============================================================================
// PHASE 1: RECALL — 5 REAL PROMPTS
// ============================================================================

const AGENT = 'cli';   // all entries use source='cli'
const PROMPTS = [
  'compressor not running thermal fuse blown',
  'timeout error in node script',
  'agent loop not terminating',
  'UI not rendering after state update',
  'dryer overheating multiple thermal failures',
];

sep('PHASE 1 — RECALL: 5 REAL PROMPTS');

const recallResults = {};

for (const prompt of PROMPTS) {
  sub(`PROMPT: "${prompt}"`);

  const result = memoryApi.recall(AGENT, { prompt, limit: 3, runId: `val_run_${Date.now()}` });

  recallResults[prompt] = result;

  console.log(`  total candidates matched → selected: ${result.selected.length}, pruned: ${result.pruned_count}, merged: ${result.merged_count}`);
  console.log(`  usedPatterns: [${result.usedPatterns.join(', ')}]`);

  if (result.selected.length === 0) {
    console.log('  !! NO RESULTS — no entries matched this prompt');
  } else {
    result.selected.forEach((e, i) => printEntry(i + 1, e));
  }

  // Evaluation notes
  const hasFailurePattern = result.selected.some(e => e.failure_boost > 0);
  const hasNoise = result.selected.some(e => (e.contentMatch || 0) < 0.1 && e.score < 1);
  console.log(`  [EVAL] failure patterns surfaced: ${hasFailurePattern} | noise entries: ${hasNoise}`);
}

// ============================================================================
// PHASE 2: AUDIT RANKING
// ============================================================================

sep('PHASE 2 — AUDIT RANKING');

const auditResults = {};

for (const prompt of PROMPTS) {
  sub(`AUDIT: "${prompt}"`);

  const result = memoryApi.audit(AGENT, { prompt, limit: 5 });
  auditResults[prompt] = result;

  console.log(`  candidates: ${result.summary.total_candidates}, returned: ${result.summary.returned}, warnings: ${result.summary.warning_count}`);

  if (result.entries.length === 0) {
    console.log('  !! NO AUDIT RESULTS');
  } else {
    result.entries.forEach((e, i) => printAuditEntry(i + 1, e));
  }

  // Red flag detection
  if (result.summary.warnings.length > 0) {
    console.log('  RED FLAGS:');
    result.summary.warnings.forEach(w => console.log(`    ⚠ id=${w.entryId}: ${w.reason} [${w.severity}]`));
  }
}

// ============================================================================
// PHASE 3: ATTRIBUTION LOOP TEST (3 prompts)
// ============================================================================

sep('PHASE 3 — ATTRIBUTION LOOP TEST');

const attributionTests = [
  { prompt: 'timeout error in node script', outcome: 'success' },
  { prompt: 'agent loop not terminating', outcome: 'success' },
  { prompt: 'dryer overheating multiple thermal failures', outcome: 'success' },
];

const attributionRecords = [];

for (const test of attributionTests) {
  sub(`Attribution: "${test.prompt}"`);

  const runId = `attr_val_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const recallResult = memoryApi.recall(AGENT, { prompt: test.prompt, limit: 3, runId });

  if (recallResult.selected.length === 0) {
    console.log('  !! SKIPPING — no patterns recalled');
    attributionRecords.push({ prompt: test.prompt, skipped: true });
    continue;
  }

  const usedPatterns = recallResult.usedPatterns;
  const primaryPatternId = usedPatterns[0];  // top-ranked = primary

  console.log(`  runId: ${runId}`);
  console.log(`  usedPatterns: [${usedPatterns.join(', ')}]`);
  console.log(`  primaryPatternId: ${primaryPatternId}`);

  // Capture before-state of source_refs
  const before = {};
  for (const id of usedPatterns) {
    const entry = require('better-sqlite3')(
      require('path').join(process.env.HOME || process.env.USERPROFILE, 'mission-control', '.data', 'mission-control.db')
    ).prepare('SELECT source_ref, tags FROM memory_entries WHERE id = ?').get(id);
    before[id] = { source_ref: entry?.source_ref, tags: entry?.tags };
  }

  // Mark outcome
  const outcomeResult = memoryService.markOutcome(primaryPatternId, test.outcome, {
    usedPatterns,
    primaryPatternId,
    runId
  });

  // Also mark all used patterns (not just primary)
  for (const id of usedPatterns) {
    if (id !== primaryPatternId) {
      memoryService.markOutcome(id, test.outcome, { usedPatterns, primaryPatternId, runId });
    }
  }

  console.log(`  markOutcome result: ${JSON.stringify(outcomeResult)}`);

  // Capture after-state and verify
  const Database = require('better-sqlite3');
  const db = new Database(require('path').join(process.env.HOME || process.env.USERPROFILE, 'mission-control', '.data', 'mission-control.db'));

  let attributionPass = true;
  for (const id of usedPatterns) {
    const after = db.prepare('SELECT source_ref, tags FROM memory_entries WHERE id = ?').get(id);
    const isPrimary = id === primaryPatternId;

    const ref = after?.source_ref || '';
    const hasApplied = ref.includes('applied_pattern:+1');
    const hasWin = ref.includes('pattern_win:+1');
    const hasSuccess = ref.includes('pattern_success:+1');

    const beforeRef = before[id]?.source_ref || '';
    const newApplied = (ref.match(/applied_pattern:\+1/g) || []).length - (beforeRef.match(/applied_pattern:\+1/g) || []).length;
    const newWin = (ref.match(/pattern_win:\+1/g) || []).length - (beforeRef.match(/pattern_win:\+1/g) || []).length;
    const newSuccess = (ref.match(/pattern_success:\+1/g) || []).length - (beforeRef.match(/pattern_success:\+1/g) || []).length;

    const ok_applied = newApplied === 1;
    const ok_success = newSuccess === 1;
    const ok_win = isPrimary ? newWin === 1 : newWin === 0;

    attributionPass = attributionPass && ok_applied && ok_success && ok_win;

    console.log(`  id=${id} [${isPrimary ? 'PRIMARY' : 'USED'}]`);
    console.log(`    applied_pattern +${newApplied}: ${ok_applied ? 'PASS' : 'FAIL'}`);
    console.log(`    pattern_success +${newSuccess}: ${ok_success ? 'PASS' : 'FAIL'}`);
    if (isPrimary) {
      console.log(`    pattern_win +${newWin}: ${ok_win ? 'PASS' : 'FAIL'}`);
    }
  }

  db.close();

  attributionRecords.push({
    prompt: test.prompt, runId, primaryPatternId, usedPatterns, pass: attributionPass
  });
  console.log(`  ATTRIBUTION: ${attributionPass ? 'PASS' : 'FAIL'}`);
}

// ============================================================================
// PHASE 4: LEARNING VALIDATION
// ============================================================================

sep('PHASE 4 — LEARNING VALIDATION (recall again, check rank shift)');

for (const rec of attributionRecords) {
  if (rec.skipped) continue;
  sub(`Re-recall: "${rec.prompt}"`);

  const before = recallResults[rec.prompt];
  const after = memoryApi.recall(AGENT, { prompt: rec.prompt, limit: 3 });

  const beforeTop = before?.selected[0];
  const afterTop = after?.selected[0];

  const sameTopPattern = beforeTop?.id === afterTop?.id;
  const scoreChanged = beforeTop && afterTop && beforeTop.id === afterTop.id
    ? afterTop.score !== beforeTop.score
    : null;

  console.log(`  Before top: id=${beforeTop?.id} score=${fmt(beforeTop?.score)} promo=${beforeTop?.promotion_level}`);
  console.log(`  After  top: id=${afterTop?.id} score=${fmt(afterTop?.score)} promo=${afterTop?.promotion_level}`);
  console.log(`  Same top pattern: ${sameTopPattern}`);

  if (scoreChanged === true) {
    const delta = (afterTop?.score || 0) - (beforeTop?.score || 0);
    console.log(`  Score delta: ${delta > 0 ? '+' : ''}${fmt(delta)} → LEARNING: ${delta > 0 ? 'IMPROVED' : 'PENALIZED'}`);
  } else if (scoreChanged === false) {
    console.log(`  Score unchanged — learning loop may not be updating rank`);
  } else {
    console.log(`  Top pattern changed after outcome — ranking shifted`);
  }

  // Check if primary pattern moved up
  if (rec.primaryPatternId) {
    const primaryBefore = before?.selected.find(e => e.id === rec.primaryPatternId);
    const primaryAfter = after?.selected.find(e => e.id === rec.primaryPatternId);
    if (primaryBefore && primaryAfter) {
      const delta = primaryAfter.score - primaryBefore.score;
      console.log(`  Primary id=${rec.primaryPatternId}: score ${fmt(primaryBefore.score)} → ${fmt(primaryAfter.score)} (delta ${fmt(delta)})`);
    }
  }
}

// ============================================================================
// PHASE 5: FAILURE TEST
// ============================================================================

sep('PHASE 5 — FAILURE TEST');

// Pick the first attribution record that had a valid recall
const failureTest = attributionRecords.find(r => !r.skipped && r.primaryPatternId);

if (!failureTest) {
  console.log('No valid attribution record to run failure test on.');
} else {
  sub(`Failure test on id=${failureTest.primaryPatternId}`);

  const Database = require('better-sqlite3');
  const db = new Database(require('path').join(process.env.HOME || process.env.USERPROFILE, 'mission-control', '.data', 'mission-control.db'));
  const beforeFail = db.prepare('SELECT source_ref, tags FROM memory_entries WHERE id = ?').get(failureTest.primaryPatternId);
  db.close();

  const failRunId = `fail_val_${Date.now()}`;
  memoryService.markOutcome(failureTest.primaryPatternId, 'failure', {
    usedPatterns: [failureTest.primaryPatternId],
    primaryPatternId: failureTest.primaryPatternId,
    runId: failRunId
  });

  const db2 = new Database(require('path').join(process.env.HOME || process.env.USERPROFILE, 'mission-control', '.data', 'mission-control.db'));
  const afterFail = db2.prepare('SELECT source_ref, tags FROM memory_entries WHERE id = ?').get(failureTest.primaryPatternId);
  db2.close();

  const beforeRef = beforeFail?.source_ref || '';
  const afterRef = afterFail?.source_ref || '';

  const newFailure = (afterRef.match(/pattern_failure:\+1/g) || []).length - (beforeRef.match(/pattern_failure:\+1/g) || []).length;
  const newLoss = (afterRef.match(/pattern_loss:\+1/g) || []).length - (beforeRef.match(/pattern_loss:\+1/g) || []).length;

  console.log(`  pattern_failure +${newFailure}: ${newFailure === 1 ? 'PASS' : 'FAIL'}`);
  console.log(`  pattern_loss +${newLoss}: ${newLoss === 1 ? 'PASS' : 'FAIL'}`);

  // Re-recall to check penalty
  const beforeRecall = recallResults[failureTest.prompt];
  const afterFailRecall = memoryApi.recall(AGENT, { prompt: failureTest.prompt, limit: 3 });

  const primaryBefore = beforeRecall?.selected.find(e => e.id === failureTest.primaryPatternId);
  const primaryAfter = afterFailRecall.selected.find(e => e.id === failureTest.primaryPatternId);

  if (primaryBefore && primaryAfter) {
    const delta = primaryAfter.score - primaryBefore.score;
    console.log(`  Penalized: score ${fmt(primaryBefore.score)} → ${fmt(primaryAfter.score)} (delta ${fmt(delta)})`);
    console.log(`  Penalization: ${delta < 0 ? 'PASS' : 'NO CHANGE or INCREASE — penalty not working'}`);
  } else if (!primaryAfter) {
    console.log(`  Primary pattern dropped out of top 3 after failure — likely penalized correctly`);
  } else {
    console.log(`  Primary pattern not in before-recall set, cannot compare`);
  }
}

// ============================================================================
// PHASE 6: SYSTEM HEALTH
// ============================================================================

sep('PHASE 6 — SYSTEM HEALTH');

const memStatus = memoryApi.status();
console.log('  total_memories:', memStatus.total_memories);
console.log('  by_source:', JSON.stringify(memStatus.by_source));
console.log('  by_category:', JSON.stringify(memStatus.by_category));
console.log('  outcome_counts:', JSON.stringify(memStatus.outcome_counts));
console.log('  promoted_counts:', JSON.stringify(memStatus.promoted_counts));
console.log('  warnings:', JSON.stringify(memStatus.warnings));

const health = memoryApi.health();
console.log('\n  health.ok:', health.ok);
console.log('  checks:', JSON.stringify(health.checks));
if (health.issues.length > 0) console.log('  ISSUES:', health.issues);

// ============================================================================
// SUMMARY
// ============================================================================

sep('VALIDATION SUMMARY');

console.log('\n1. PROMPTS TESTED:');
PROMPTS.forEach(p => console.log(`   - "${p}"`));

console.log('\n2. TOP RESULTS PER PROMPT:');
for (const prompt of PROMPTS) {
  const top = recallResults[prompt]?.selected[0];
  if (top) {
    console.log(`   "${prompt}"`);
    console.log(`     → id=${top.id} score=${fmt(top.score)} promo=${top.promotion_level}: "${(top.content||'').slice(0,80)}"`);
  } else {
    console.log(`   "${prompt}" → NO RESULTS`);
  }
}

console.log('\n3. INCORRECT RANKINGS:');
let rankingIssues = [];
for (const prompt of PROMPTS) {
  const result = auditResults[prompt];
  if (result?.summary.warnings.length > 0) {
    result.summary.warnings.forEach(w => rankingIssues.push(`  id=${w.entryId} on "${prompt}": ${w.reason}`));
  }
}
if (rankingIssues.length === 0) console.log('   none detected');
else rankingIssues.forEach(i => console.log(i));

console.log('\n4. ATTRIBUTION CORRECTNESS:');
attributionRecords.forEach(r => {
  if (r.skipped) console.log(`   "${r.prompt}": SKIPPED (no recall)`);
  else console.log(`   "${r.prompt}": ${r.pass ? 'PASS' : 'FAIL'}`);
});

console.log('\n5–6. See learning loop and failure test output above.');

console.log('\n7. SYSTEM WEAKNESSES OBSERVED: (check console above for details)');
const zeroRecall = PROMPTS.filter(p => recallResults[p]?.selected.length === 0);
if (zeroRecall.length > 0) console.log(`   ⚠ No recall results for: ${zeroRecall.join(', ')}`);

const memCheck = memoryApi.health();
if (!memCheck.ok) console.log(`   ⚠ Health check issues: ${memCheck.issues.join(', ')}`);

console.log('\n');
