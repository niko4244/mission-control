import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  buildStatusMode,
  buildReviewMode,
  main,
} = require('../../../scripts/documentation-governor.cjs')

describe('documentation governor', () => {
  it('exports AGENT correctly', () => {
    expect(AGENT).toBe('Documentation Governor v1')
  })

  it('buildReviewMode with "fix typo" returns Docs risk', () => {
    const result = buildReviewMode(ROOT, 'fix typo in README')
    expect(result.risk_level).toBe('Docs')
  })

  it('buildReviewMode with "policy doc" returns Medium risk or higher', () => {
    const result = buildReviewMode(ROOT, 'update policy doc for security governance')
    expect(['Medium', 'High', 'Critical']).toContain(result.risk_level)
  })

  it('buildReviewMode always includes requires_human_for', () => {
    const result = buildReviewMode(ROOT, 'add new section to guide')
    expect(Array.isArray(result.requires_human_for)).toBe(true)
    expect(result.requires_human_for).toContain('push')
    expect(result.requires_human_for).toContain('merge')
  })

  it('CLI status returns valid JSON with correct agent and mode', () => {
    const execution = spawnSync(process.execPath, ['scripts/documentation-governor.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
  })
})
