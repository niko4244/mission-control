import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT: BACKLOG_AGENT,
  LABEL: BACKLOG_LABEL,
  VALID_CATEGORIES,
  VALID_RISK_LEVELS,
  VALID_STATUSES,
  buildStatusMode: backlogStatus,
  buildListMode,
  buildAddMode,
  buildPrioritizeMode,
  createItem,
  loadItems,
  saveItems,
  prioritizeItems,
} = require('../../../scripts/backlog-reconciler.cjs')

const {
  AGENT: ESCALATION_AGENT,
  LABEL: ESCALATION_LABEL,
  VALID_REASONS,
  SUBMIT_STATUS,
  buildStatusMode: escalationStatus,
  buildSubmitMode,
  buildListMode: escalationList,
  buildInspectMode,
  readEscalations,
  submitEscalation,
  validateEscalation,
} = require('../../../scripts/escalation-protocol.cjs')

// ---- helpers ---------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-esc-test-'))
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tmpDir() {
  const dir = makeTempDir()
  tempDirs.push(dir)
  return dir
}

// ============================================================================
// BACKLOG RECONCILER TESTS
// ============================================================================

describe('backlog reconciler', () => {
  // 1. Agent identity
  it('exports correct AGENT and LABEL', () => {
    expect(BACKLOG_AGENT).toBe('Backlog Reconciler v1')
    expect(BACKLOG_LABEL).toBe('OBSERVE ONLY / BACKLOG MANAGER')
  })

  // 2. status mode on empty data dir
  it('status mode reports zero items when data file is absent', () => {
    const dir = tmpDir()
    const result = backlogStatus(dir)
    expect(result.agent).toBe(BACKLOG_AGENT)
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
    expect(result.total).toBe(0)
    expect(result.by_status).toEqual({})
    expect(result.by_category).toEqual({})
  })

  // 3. createItem fills defaults
  it('createItem fills all required schema fields with defaults', () => {
    const item = createItem({ title: 'Hello', description: 'World' })
    expect(item.id).toMatch(/^bl-/)
    expect(item.title).toBe('Hello')
    expect(item.description).toBe('World')
    expect(item.source).toBe('manual')
    expect(item.category).toBe('feature')
    expect(item.risk_level).toBe('Medium')
    expect(item.status).toBe('new')
    expect(item.priority).toBe(3)
    expect(typeof item.autonomous_safe).toBe('boolean')
    expect(typeof item.requires_governor_or_arbiter).toBe('boolean')
    expect(Array.isArray(item.likely_files)).toBe(true)
    expect(item.estimated_complexity).toBe('medium')
    expect(typeof item.created_at).toBe('string')
    expect(typeof item.updated_at).toBe('string')
    expect(typeof item.notes).toBe('string')
  })

  // 4. saveItems / loadItems round-trip
  it('saveItems writes and loadItems reads back items correctly', () => {
    const dir = tmpDir()
    const item = createItem({ title: 'Test', description: 'Desc' })
    saveItems([item], dir)
    const loaded = loadItems(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(item.id)
    expect(loaded[0].title).toBe('Test')
  })

  // 5. loadItems on nonexistent file returns empty array
  it('loadItems returns empty array when backlog file does not exist', () => {
    const dir = tmpDir()
    const items = loadItems(dir)
    expect(items).toEqual([])
  })

  // 6. add mode creates item with required fields
  it('add mode creates item and writes to disk', () => {
    const dir = tmpDir()
    const result = buildAddMode(dir, { title: 'My Feature', description: 'Do the thing' })
    expect(result.status).toBe('PASS')
    expect(result.item.title).toBe('My Feature')
    expect(result.item.description).toBe('Do the thing')
    expect(result.item.status).toBe('new')
    const items = loadItems(dir)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(result.item.id)
  })

  // 7. add mode with optional category and risk
  it('add mode accepts optional category and risk flags', () => {
    const dir = tmpDir()
    const result = buildAddMode(dir, {
      title: 'Governance Task',
      description: 'Update policy',
      category: 'governance',
      risk: 'High',
      priority: '1',
    })
    expect(result.status).toBe('PASS')
    expect(result.item.category).toBe('governance')
    expect(result.item.risk_level).toBe('High')
    expect(result.item.priority).toBe(1)
  })

  // 8. add mode fails without title
  it('add mode returns FAIL when --title is missing', () => {
    const dir = tmpDir()
    const result = buildAddMode(dir, { description: 'No title' })
    expect(result.status).toBe('FAIL')
    expect(result.error).toMatch(/title/)
  })

  // 9. add mode fails without description
  it('add mode returns FAIL when --description is missing', () => {
    const dir = tmpDir()
    const result = buildAddMode(dir, { title: 'No desc' })
    expect(result.status).toBe('FAIL')
    expect(result.error).toMatch(/description/)
  })

  // 10. list mode returns all items by default
  it('list mode returns all items when no filters supplied', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'A', description: 'd', status: 'new', category: 'security' }),
      createItem({ title: 'B', description: 'd', status: 'planned', category: 'ui' }),
    ], dir)
    const result = buildListMode(dir, {})
    expect(result.status).toBe('PASS')
    expect(result.count).toBe(2)
  })

  // 11. list mode filters by status
  it('list mode filters items by status', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'A', description: 'd', status: 'new' }),
      createItem({ title: 'B', description: 'd', status: 'done' }),
      createItem({ title: 'C', description: 'd', status: 'new' }),
    ], dir)
    const result = buildListMode(dir, { status: 'new' })
    expect(result.count).toBe(2)
    expect(result.items.every((i: any) => i.status === 'new')).toBe(true)
  })

  // 12. list mode filters by category
  it('list mode filters items by category', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'A', description: 'd', category: 'governance' }),
      createItem({ title: 'B', description: 'd', category: 'feature' }),
      createItem({ title: 'C', description: 'd', category: 'governance' }),
    ], dir)
    const result = buildListMode(dir, { category: 'governance' })
    expect(result.count).toBe(2)
    expect(result.items.every((i: any) => i.category === 'governance')).toBe(true)
  })

  // 13. list mode sorts by priority then created_at
  it('list mode returns items sorted by priority then created_at', () => {
    const dir = tmpDir()
    const now = Date.now()
    const items = [
      createItem({ title: 'Low', description: 'd', priority: 5, created_at: new Date(now).toISOString() }),
      createItem({ title: 'High', description: 'd', priority: 1, created_at: new Date(now + 1000).toISOString() }),
      createItem({ title: 'Mid', description: 'd', priority: 3, created_at: new Date(now + 2000).toISOString() }),
    ]
    saveItems(items, dir)
    const result = buildListMode(dir, {})
    expect(result.items[0].title).toBe('High')
    expect(result.items[2].title).toBe('Low')
  })

  // 14. prioritize puts governance above feature
  it('prioritize re-ranks governance items above feature items', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'Feature Task', description: 'd', category: 'feature', risk_level: 'Low', estimated_complexity: 'trivial' }),
      createItem({ title: 'Governance Task', description: 'd', category: 'governance', risk_level: 'Low', estimated_complexity: 'trivial' }),
    ], dir)
    const result = buildPrioritizeMode(dir)
    expect(result.status).toBe('PASS')
    expect(result.items[0].category).toBe('governance')
    expect(result.items[1].category).toBe('feature')
  })

  // 15. prioritize ranks Critical risk above Medium within same category
  it('prioritize ranks Critical risk above Medium within same category', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'Med', description: 'd', category: 'security', risk_level: 'Medium', estimated_complexity: 'trivial' }),
      createItem({ title: 'Crit', description: 'd', category: 'security', risk_level: 'Critical', estimated_complexity: 'trivial' }),
    ], dir)
    const result = buildPrioritizeMode(dir)
    expect(result.items[0].title).toBe('Crit')
    expect(result.items[1].title).toBe('Med')
  })

  // 16. prioritize ranks trivial complexity before large within same risk
  it('prioritize ranks trivial complexity before large within same risk level', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'Large', description: 'd', category: 'testing', risk_level: 'High', estimated_complexity: 'large' }),
      createItem({ title: 'Trivial', description: 'd', category: 'testing', risk_level: 'High', estimated_complexity: 'trivial' }),
    ], dir)
    const result = buildPrioritizeMode(dir)
    expect(result.items[0].title).toBe('Trivial')
    expect(result.items[1].title).toBe('Large')
  })

  // 17. prioritize mode on empty backlog
  it('prioritize mode on empty backlog returns PASS with zero items', () => {
    const dir = tmpDir()
    const result = buildPrioritizeMode(dir)
    expect(result.status).toBe('PASS')
    expect(result.reranked).toBe(0)
    expect(result.items).toEqual([])
  })

  // 18. status mode counts by status and category
  it('status mode correctly counts items by status and category', () => {
    const dir = tmpDir()
    saveItems([
      createItem({ title: 'A', description: 'd', status: 'new', category: 'governance' }),
      createItem({ title: 'B', description: 'd', status: 'new', category: 'security' }),
      createItem({ title: 'C', description: 'd', status: 'done', category: 'governance' }),
    ], dir)
    const result = backlogStatus(dir)
    expect(result.by_status.new).toBe(2)
    expect(result.by_status.done).toBe(1)
    expect(result.by_category.governance).toBe(2)
    expect(result.by_category.security).toBe(1)
  })

  // 19. VALID_CATEGORIES and VALID_RISK_LEVELS exported correctly
  it('exports expected category and risk level constants', () => {
    expect(VALID_CATEGORIES).toContain('governance')
    expect(VALID_CATEGORIES).toContain('security')
    expect(VALID_RISK_LEVELS).toContain('Critical')
    expect(VALID_RISK_LEVELS).toContain('Low')
  })

  // 20. CLI output is valid JSON
  it('CLI for backlog-reconciler returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/backlog-reconciler.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(BACKLOG_AGENT)
    expect(parsed.mode).toBe('status')
  })
})

// ============================================================================
// ESCALATION PROTOCOL TESTS
// ============================================================================

describe('escalation protocol', () => {
  // 21. Agent identity
  it('exports correct AGENT and LABEL', () => {
    expect(ESCALATION_AGENT).toBe('Escalation Protocol v1')
    expect(ESCALATION_LABEL).toBe('OBSERVE ONLY / ESCALATION HANDLER')
  })

  // 22. status mode on empty data dir
  it('status mode reports zero escalations when file is absent', () => {
    const dir = tmpDir()
    const result = escalationStatus(dir)
    expect(result.agent).toBe(ESCALATION_AGENT)
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
    expect(result.total).toBe(0)
    expect(result.pending_count).toBe(0)
    expect(result.pending).toEqual([])
  })

  // 23. validateEscalation rejects missing fields
  it('validateEscalation rejects missing governor', () => {
    const errors = validateEscalation({
      governor: '',
      reason: 'failed_validation',
      task: 'task',
      evidence: 'evidence',
      requested_action: 'action',
    })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toMatch(/governor/)
  })

  // 24. validateEscalation rejects invalid reason
  it('validateEscalation rejects invalid reason', () => {
    const errors = validateEscalation({
      governor: 'security-governor',
      reason: 'bad_reason_value',
      task: 'task',
      evidence: 'evidence',
      requested_action: 'action',
    })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(' ')).toMatch(/reason/)
  })

  // 25. validateEscalation accepts all valid reasons
  it('validateEscalation accepts every VALID_REASONS entry', () => {
    for (const reason of VALID_REASONS) {
      const errors = validateEscalation({
        governor: 'security-governor',
        reason,
        task: 'some task',
        evidence: 'some evidence',
        requested_action: 'some action',
      })
      expect(errors).toHaveLength(0)
    }
  })

  // 26. submitEscalation with valid fields appends to file
  it('submitEscalation with valid fields appends record to escalations.jsonl', () => {
    const dir = tmpDir()
    const result = submitEscalation({
      governor: 'security-governor',
      reason: 'failed_validation',
      task: 'Fix lint failures in auth module',
      evidence: 'eslint reported 3 errors',
      requested_action: 'Approve lint fix plan',
    }, dir)
    expect(result.ok).toBe(true)
    expect(result.id).toMatch(/^esc-/)
    expect(result.arbiter_required).toBe(true)
    const records = readEscalations(dir)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe(result.id)
  })

  // 27. submitted escalation always has status pending
  it('all submitted escalations have status pending — bot cannot self-approve', () => {
    const dir = tmpDir()
    for (const reason of ['failed_validation', 'broad_rewrite', 'dependency_change']) {
      submitEscalation({
        governor: 'release-governor',
        reason,
        task: `task for ${reason}`,
        evidence: 'some evidence',
        requested_action: 'approve it',
      }, dir)
    }
    const records = readEscalations(dir)
    expect(records).toHaveLength(3)
    expect(records.every((r: any) => r.status === SUBMIT_STATUS)).toBe(true)
    expect(records.every((r: any) => r.status === 'pending')).toBe(true)
  })

  // 28. submitEscalation with invalid fields returns errors
  it('submitEscalation with invalid fields returns ok=false and errors array', () => {
    const dir = tmpDir()
    const result = submitEscalation({
      governor: '',
      reason: 'failed_validation',
      task: '',
      evidence: '',
      requested_action: '',
    }, dir)
    expect(result.ok).toBe(false)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  // 29. buildSubmitMode returns FAIL with validation errors
  it('buildSubmitMode returns FAIL status when fields are invalid', () => {
    const dir = tmpDir()
    const result = buildSubmitMode(dir, { governor: 'security-governor' })
    expect(result.status).toBe('FAIL')
    expect(result.arbiter_required).toBe(true)
    expect(Array.isArray(result.errors)).toBe(true)
  })

  // 30. buildSubmitMode always returns arbiter_required true — break-glass
  it('buildSubmitMode always returns arbiter_required=true on successful submit', () => {
    const dir = tmpDir()
    const result = buildSubmitMode(dir, {
      governor: 'release-governor',
      reason: 'broad_rewrite',
      task: 'Rewrite 25 files',
      evidence: '26 files changed in diff',
      requested_action: 'Approve or reject the rewrite plan',
    })
    expect(result.status).toBe('PASS')
    expect(result.arbiter_required).toBe(true)
    expect(result.escalation_status).toBe('pending')
  })

  // 31. list mode returns all escalations when no filter
  it('escalation list mode returns all records when no filter is applied', () => {
    const dir = tmpDir()
    submitEscalation({ governor: 'g1', reason: 'failed_validation', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    submitEscalation({ governor: 'g2', reason: 'policy_edit', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    const result = escalationList(dir, {})
    expect(result.status).toBe('PASS')
    expect(result.count).toBe(2)
  })

  // 32. list mode filters by status
  it('escalation list mode filters by status', () => {
    const dir = tmpDir()
    submitEscalation({ governor: 'g1', reason: 'failed_validation', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    submitEscalation({ governor: 'g2', reason: 'policy_edit', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    const result = escalationList(dir, { status: 'pending' })
    expect(result.count).toBe(2)
    expect(result.escalations.every((e: any) => e.status === 'pending')).toBe(true)
  })

  // 33. list mode filters by governor
  it('escalation list mode filters by governor', () => {
    const dir = tmpDir()
    submitEscalation({ governor: 'security-governor', reason: 'failed_validation', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    submitEscalation({ governor: 'release-governor', reason: 'broad_rewrite', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    const result = escalationList(dir, { governor: 'security-governor' })
    expect(result.count).toBe(1)
    expect(result.escalations[0].governor).toBe('security-governor')
  })

  // 34. inspect returns single escalation by id
  it('buildInspectMode returns a single escalation by id', () => {
    const dir = tmpDir()
    const { id } = submitEscalation({
      governor: 'security-governor',
      reason: 'failed_validation',
      task: 'Fix typecheck failures',
      evidence: 'tsc reported 5 errors',
      requested_action: 'Approve fix plan',
    }, dir)
    const result = buildInspectMode(dir, id)
    expect(result.status).toBe('PASS')
    expect(result.escalation.id).toBe(id)
    expect(result.escalation.governor).toBe('security-governor')
    expect(result.escalation.reason).toBe('failed_validation')
  })

  // 35. inspect returns FAIL for unknown id
  it('buildInspectMode returns FAIL for unknown escalation id', () => {
    const dir = tmpDir()
    const result = buildInspectMode(dir, 'esc-does-not-exist')
    expect(result.status).toBe('FAIL')
    expect(result.error).toMatch(/not found/i)
  })

  // 36. inspect returns FAIL when id is missing
  it('buildInspectMode returns FAIL when id is omitted', () => {
    const dir = tmpDir()
    const result = buildInspectMode(dir, '')
    expect(result.status).toBe('FAIL')
    expect(result.error).toMatch(/--id/)
  })

  // 37. status mode lists pending escalations correctly
  it('status mode lists pending escalations', () => {
    const dir = tmpDir()
    submitEscalation({ governor: 'g1', reason: 'failed_validation', task: 'task1', evidence: 'e1', requested_action: 'a1' }, dir)
    submitEscalation({ governor: 'g2', reason: 'cross_domain', task: 'task2', evidence: 'e2', requested_action: 'a2' }, dir)
    const result = escalationStatus(dir)
    expect(result.pending_count).toBe(2)
    expect(result.pending.length).toBe(2)
    expect(result.by_status.pending).toBe(2)
  })

  // 38. multiple escalations appended to JSONL without corruption
  it('multiple escalations can be appended and read back in order', () => {
    const dir = tmpDir()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const { id } = submitEscalation({
        governor: `gov-${i}`,
        reason: 'other',
        task: `task ${i}`,
        evidence: `evidence ${i}`,
        requested_action: `action ${i}`,
      }, dir)
      ids.push(id as string)
    }
    const records = readEscalations(dir)
    expect(records).toHaveLength(5)
    expect(records.map((r: any) => r.id)).toEqual(ids)
  })

  // 39. CLI for escalation-protocol returns valid JSON
  it('CLI for escalation-protocol returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/escalation-protocol.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(ESCALATION_AGENT)
    expect(parsed.mode).toBe('status')
  })

  // 40. resolved_at is null on all freshly submitted escalations
  it('resolved_at is null on all freshly submitted escalations', () => {
    const dir = tmpDir()
    submitEscalation({ governor: 'g1', reason: 'failed_validation', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    submitEscalation({ governor: 'g2', reason: 'policy_edit', task: 't', evidence: 'e', requested_action: 'a' }, dir)
    const records = readEscalations(dir)
    expect(records.every((r: any) => r.resolved_at === null)).toBe(true)
  })
})
