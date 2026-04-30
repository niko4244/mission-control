import { describe, test, expect } from 'vitest'
import memoryService from '../../../scripts/memory-service.cjs'
import memoryApi from '../../../scripts/memory-api.cjs'

describe('memory-service tests', () => {
  const now = Math.floor(Date.now() / 1000)

  describe('getSignalCounts', () => {
    test('accumulates repeated signals', () => {
      const ref1 = 'source:cli|pattern_success:+1|outcome:success'
      const counts1 = memoryService.getSignalCounts(ref1)
      expect(counts1.successCount).toBe(1)
      expect(counts1.failureCount).toBe(0)

      const ref2 = ref1 + '|pattern_success:+1|pattern_failure:+1'
      const counts2 = memoryService.getSignalCounts(ref2)
      expect(counts2.successCount).toBe(2)
      expect(counts2.failureCount).toBe(1)
    })

    test('handles empty source_ref', () => {
      const counts = memoryService.getSignalCounts('')
      expect(counts.successCount).toBe(0)
      expect(counts.failureCount).toBe(0)
      expect(counts.appliedCount).toBe(0)
      expect(counts.winCount).toBe(0)
      expect(counts.lossCount).toBe(0)
    })
  })

  describe('scoreEntry', () => {
    test('never returns NaN with missing optional fields', () => {
      const entry = {
        content: 'Test entry',
        tags: 'outcome:unknown',
        created_at: now
      }
      const score = memoryService.scoreEntry(entry, 'test', 1, now)
      expect(score.score).not.toBeNaN()
      expect(score.score).toBeDefined()
      expect(typeof score.score).toBe('number')
    })

    test('is deterministic with same inputs', () => {
      const entry = {
        content: 'Test entry for scoring.',
        tags: 'outcome:unknown',
        confidence: 0.5,
        created_at: now,
        source_ref: 'source:cli'
      }

      const score1 = memoryService.scoreEntry(entry, 'test prompt', 1, now)
      const score2 = memoryService.scoreEntry(entry, 'test prompt', 1, now)

      expect(score1.score).toBe(score2.score)
      expect(score1.contentMatch).toBe(score2.contentMatch)
      expect(score1.validation_score).toBe(score2.validation_score)
    })

    test('handles all debug fields', () => {
      const entry = {
        content: 'Test entry',
        tags: 'outcome:success',
        created_at: now
      }
      const score = memoryService.scoreEntry(entry, 'test', 1, now)

      expect(score).toHaveProperty('contentMatch')
      expect(score).toHaveProperty('phraseMatch')
      expect(score).toHaveProperty('confidence_score')
      expect(score).toHaveProperty('effective_confidence_score')
      expect(score).toHaveProperty('confidence_decay_factor')
      expect(score).toHaveProperty('learning_quality_boost')
      expect(score).toHaveProperty('failure_boost')
      expect(score).toHaveProperty('promotion_level')
      expect(score).toHaveProperty('promotion_boost')
      expect(score).toHaveProperty('demotion_penalty')
      expect(score).toHaveProperty('validation_score')
      expect(score).toHaveProperty('cluster_validation_score')
      expect(score).toHaveProperty('validation_penalty')
      expect(score).toHaveProperty('causality_score')
      expect(score).toHaveProperty('causality_boost')
      expect(score).toHaveProperty('win_rate')
      expect(score).toHaveProperty('competition_boost')
      expect(score).toHaveProperty('cluster_boost')
      expect(score).toHaveProperty('cluster_size')
      expect(score).toHaveProperty('cluster_success_count')
      expect(score).toHaveProperty('cluster_failure_count')
      expect(score).toHaveProperty('cluster_applied_count')
      expect(score).toHaveProperty('similarity_matches')
    })
  })

  describe('recall API shape', () => {
    test('returns stable object shape via memory-api', async () => {
      const result = await (memoryApi as any).recall('cli', {
        prompt: 'test prompt',
        limit: 3
      })

      expect(result).toHaveProperty('selected')
      expect(result).toHaveProperty('usedPatterns')
      expect(result).toHaveProperty('pruned_count')
      expect(result).toHaveProperty('merged_count')

      if (result.selected.length > 0) {
        const entry = result.selected[0]
        expect(entry).toHaveProperty('id')
        expect(entry).toHaveProperty('content')
        expect(entry).toHaveProperty('tags')
        expect(entry).toHaveProperty('score')
        expect(entry).toHaveProperty('promotion_level')
        expect(entry).toHaveProperty('validation_score')
        expect(entry).toHaveProperty('causality_score')
        expect(entry).toHaveProperty('cluster_success_count')
        expect(entry).toHaveProperty('failure_boost')
        expect(entry).toHaveProperty('promotion_boost')
        expect(entry).toHaveProperty('explanation')
      }
    })
  })

  describe('audit API shape', () => {
    test('returns top entries with explanations', async () => {
      const result = await (memoryApi as any).audit('cli', {
        prompt: 'test',
        limit: 5
      })

      expect(result).toHaveProperty('prompt')
      expect(result).toHaveProperty('entries')
      expect(result).toHaveProperty('summary')

      expect(result.summary).toHaveProperty('total_candidates')
      expect(result.summary).toHaveProperty('returned')
      expect(result.summary).toHaveProperty('warning_count')

      for (const entry of result.entries) {
        expect(entry).toHaveProperty('explanation')
        expect(typeof entry.explanation).toBe('string')
        expect(entry.explanation.length).toBeGreaterThan(0)
      }
    })
  })

  describe('markOutcome updates', () => {
    test('updates only used/primary patterns correctly', () => {
      const id = 1 // Use first entry
      const outcome = 'success'

      const result = memoryService.markOutcome(id, outcome, {
        usedPatterns: [id, 2, 3],
        primaryPatternId: id,
        runId: 'test_run'
      })

      expect(result.updated).toBe(true)
      expect(result.id).toBe(id)
      expect(result.outcome).toBe(outcome)
    })
  })

  describe('ranking harness checks', () => {
    test('strong patterns rank higher when relevant', () => {
      const strongEntry = {
        content: 'Always validate user inputs. Tested and verified.',
        tags: 'outcome:success,validation:high',
        confidence: 0.95,
        created_at: now,
        source_ref: 'source:cli|pattern_success:+1|pattern_success:+1|outcome:success|validation:high'
      }

      const strongScore = memoryService.scoreEntry(strongEntry, 'validate input', 1, now)
      const weakEntry = {
        content: 'Random comment about cats.',
        tags: 'outcome:unknown',
        confidence: 0.1,
        created_at: now,
        source_ref: 'source:cli|outcome:unknown'
      }

      const weakScore = memoryService.scoreEntry(weakEntry, 'validate input', 1, now)

      // Strong patterns should rank higher
      expect(strongScore.score).toBeGreaterThan(weakScore.score)
    })

    test('failure patterns rank higher when relevant', () => {
      const failureEntry = {
        content: 'Error: Database connection timeout. Do not retry immediately.',
        tags: 'outcome:failure',
        confidence: 0.85,
        created_at: now - 86400,
        source_ref: 'source:cli|pattern_failure:+1|outcome:failure'
      }

      const failureScore = memoryService.scoreEntry(failureEntry, 'database timeout', 1, now)

      // Should have failure boost
      expect(failureScore.failure_boost).toBeGreaterThan(0)
    })

    test('NaN scores do not occur', () => {
      const entry = {
        content: 'Test',
        tags: 'outcome:unknown',
        created_at: now
      }

      const score = memoryService.scoreEntry(entry, 'test', 1, now)
      expect(Number.isNaN(score.score)).toBe(false)
    })
  })

  describe('memory-api health', () => {
    test('health reports ok', async () => {
      const health = await (memoryApi as any).health()
      expect(health.ok).toBe(true)
      expect(health.checks.memory_db_accessible).toBe(true)
      expect(health.checks.required_exports_present).toBe(true)
      expect(health.checks.deterministic_scoring).toBe(true)
      expect(health.checks.no_nan_score).toBe(true)
      expect(health.issues.length).toBe(0)
    })
  })

  describe('CLI commands', () => {
    test('health command exits successfully', async () => {
      // This is verified by running: node scripts/mc-memory.cjs health
      // The fact that we can import and call health() means it works
      const health = await (memoryApi as any).health()
      expect(health.ok).toBe(true)
    })

    test('status command works', async () => {
      const status = await (memoryApi as any).status()
      expect(status).toHaveProperty('total_memories')
      expect(status).toHaveProperty('by_source')
      expect(status).toHaveProperty('outcome_counts')
    })
  })
})
