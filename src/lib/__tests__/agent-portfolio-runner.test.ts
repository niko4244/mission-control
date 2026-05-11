import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT_SCRIPT,
  AGENT_IDS,
  PICK_SCHEMA,
  validatePick,
  extractJson,
  parseArgs,
} = require('../../../scripts/agent-portfolio-runner.cjs')

describe('agent portfolio runner', () => {
  it('exports AGENT_SCRIPT correctly', () => {
    expect(AGENT_SCRIPT).toBe('Agent Portfolio Runner v1')
  })

  it('AGENT_IDS has SportsClaw and TradingDesk', () => {
    expect(typeof AGENT_IDS.SportsClaw).toBe('number')
    expect(typeof AGENT_IDS.TradingDesk).toBe('number')
  })

  it('PICK_SCHEMA.required contains pick_type, description, amount', () => {
    expect(PICK_SCHEMA.required).toContain('pick_type')
    expect(PICK_SCHEMA.required).toContain('description')
    expect(PICK_SCHEMA.required).toContain('amount')
  })

  it('validatePick rejects pick with amount > 10 for SportsClaw', () => {
    const pick = { pick_type: 'sports', description: 'x', amount: 11, direction: 'home', rationale: 'r', confidence: 0.7 }
    const errors = validatePick(pick, 'SportsClaw')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toMatch(/10/)
  })

  it('validatePick rejects pick with amount > 15 for TradingDesk', () => {
    const pick = { pick_type: 'stock', description: 'x', amount: 16, direction: 'buy', rationale: 'r', confidence: 0.7 }
    const errors = validatePick(pick, 'TradingDesk')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toMatch(/15/)
  })

  it('validatePick accepts a valid pick', () => {
    const pick = { pick_type: 'sports', description: 'Lakers +4.5', amount: 9, direction: 'home', rationale: 'good matchup', confidence: 0.75 }
    expect(validatePick(pick, 'SportsClaw')).toEqual([])
  })

  it('extractJson strips <think> blocks from deepseek-r1 output', () => {
    const raw = '<think>some reasoning here</think>\n{"pick_type":"sports","amount":5}'
    const result = extractJson(raw)
    expect(result.pick_type).toBe('sports')
  })

  it('extractJson parses valid JSON', () => {
    const raw = '{"pick_type":"stock","amount":12}'
    const result = extractJson(raw)
    expect(result.amount).toBe(12)
  })

  it('parseArgs defaults to dry_run=true', () => {
    const opts = parseArgs([])
    expect(opts.dryRun).toBe(true)
  })
})
