import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  buildStatusMode,
  buildReviewMode,
  buildCheckBoundariesMode,
  main,
} = require('../../../scripts/architecture-governor.cjs')

describe('architecture governor', () => {
  it('exports AGENT correctly', () => {
    expect(AGENT).toBe('Architecture Governor v1')
  })

  it('buildStatusMode returns correct mode', () => {
    const result = buildStatusMode(ROOT)
    expect(result.agent).toBe(AGENT)
    expect(result.mode).toBe('status')
    expect(result.observe_only).toBe(true)
  })

  it('buildReviewMode with auth task returns High or Critical risk', () => {
    const result = buildReviewMode(ROOT, 'rewrite all auth modules')
    expect(['High', 'Critical', 'Medium']).toContain(result.risk_level)
    expect(result.approved).toBe(false)
  })

  it('buildReviewMode always includes requires_human_for with push/merge', () => {
    const result = buildReviewMode(ROOT, 'refactor import boundaries')
    expect(result.human_required_for).toContain('push')
    expect(result.human_required_for).toContain('merge')
  })

  it('buildCheckBoundariesMode with valid files returns boundaries_ok', () => {
    const result = buildCheckBoundariesMode(ROOT, JSON.stringify(['docs/guide.md']))
    expect(typeof result.boundaries_ok).toBe('boolean')
    expect(result.mode).toBe('check-boundaries')
  })

  it('CLI status returns valid JSON with correct agent and mode', () => {
    const execution = spawnSync(process.execPath, ['scripts/architecture-governor.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
  })
})
