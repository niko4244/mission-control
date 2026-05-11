import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  buildStatusMode,
  buildPrepareMode,
  validateDocFiles,
  main,
} = require('../../../scripts/documentation-executor.cjs')

describe('documentation executor', () => {
  it('exports AGENT correctly', () => {
    expect(AGENT).toBe('Documentation Executor v1')
  })

  it('validateDocFiles accepts .md and docs/ files', () => {
    const { approved, blocked } = validateDocFiles(['README.md', 'docs/guide.md'])
    expect(approved).toContain('README.md')
    expect(approved).toContain('docs/guide.md')
    expect(blocked).toHaveLength(0)
  })

  it('validateDocFiles rejects .ts files', () => {
    const { approved, blocked } = validateDocFiles(['src/lib/utils.ts'])
    expect(approved).toHaveLength(0)
    expect(blocked.length).toBeGreaterThan(0)
  })

  it('validateDocFiles rejects .json config files', () => {
    const { approved, blocked } = validateDocFiles(['config/settings.json'])
    expect(approved).toHaveLength(0)
    expect(blocked.length).toBeGreaterThan(0)
  })

  it('buildPrepareMode with valid md file returns recommended_commands', () => {
    const result = buildPrepareMode(ROOT, JSON.stringify(['docs/guide.md']), '')
    expect(Array.isArray(result.recommended_commands)).toBe(true)
    expect(result.recommended_commands.length).toBeGreaterThan(0)
  })

  it('buildPrepareMode always includes requires_human_for push/pr/merge', () => {
    const result = buildPrepareMode(ROOT, JSON.stringify(['README.md']), '')
    expect(result.requires_human_for).toContain('push')
    expect(result.requires_human_for).toContain('create_pr')
    expect(result.requires_human_for).toContain('merge')
  })

  it('CLI status returns valid JSON with correct agent and mode', () => {
    const execution = spawnSync(process.execPath, ['scripts/documentation-executor.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout)
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
  })
})
