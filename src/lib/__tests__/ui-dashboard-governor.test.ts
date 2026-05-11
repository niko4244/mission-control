import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  buildStatusMode,
  buildReviewMode,
  main,
} = require('../../../scripts/ui-dashboard-governor.cjs')

describe('ui dashboard governor', () => {
  it('exports AGENT correctly', () => {
    expect(AGENT).toBe('UI Dashboard Governor v1')
  })

  it('buildReviewMode with auth/token task escalates to human', () => {
    const result = buildReviewMode(ROOT, 'update auth token display on login page')
    expect(result.decision).toBe('ESCALATE_TO_HUMAN')
    expect(result.metadata.risk_level).toBe('High')
  })

  it('buildReviewMode with cosmetic task returns Low or Medium risk', () => {
    const result = buildReviewMode(ROOT, 'update chart colors in dashboard widget')
    expect(['Low', 'Medium']).toContain(result.metadata.risk_level)
  })

  it('always includes requires_human_for push/pr/merge', () => {
    const result = buildReviewMode(ROOT, 'adjust layout grid spacing')
    expect(result.metadata.requires_human_for).toContain('push')
    expect(result.metadata.requires_human_for).toContain('create_pr')
    expect(result.metadata.requires_human_for).toContain('merge')
  })

  it('CLI status returns valid JSON with correct agent and mode', () => {
    const execution = spawnSync(process.execPath, ['scripts/ui-dashboard-governor.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    // ui-dashboard-governor outputs JSON + summary separated by \n\n
    const jsonPart = execution.stdout.split('\n\n')[0]
    const parsed = JSON.parse(jsonPart)
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
  })
})
