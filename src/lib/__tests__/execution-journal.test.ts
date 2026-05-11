import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  VALID_ACTIONS,
  VALID_RISK_LEVELS,
  VALID_OUTCOMES,
  REQUIRED_ENTRY_FIELDS,
  appendEntry,
  buildEntry,
  buildStatusMode,
  buildAppendMode,
  buildVerifyMode,
  buildInspectMode,
  readEntries,
  validateEntry,
  verifyJournal,
  resolveJournalPath,
  generateId,
} = require('../../../scripts/execution-journal.cjs')

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-journal-'))
}

function makeValidEntry(overrides: Partial<any> = {}) {
  return {
    actor: 'chief-arbiter',
    action: 'approve',
    task: 'harden workspace route',
    risk_level: 'High',
    outcome: 'success',
    authority_chain: ['chief-arbiter'],
    files_changed: ['src/app/api/runs/route.ts'],
    ...overrides,
  }
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('execution journal', () => {
  describe('identity', () => {
    it('exports correct agent identity', () => {
      expect(AGENT).toBe('Execution Journal v1')
    })

    it('defines all required entry fields', () => {
      expect(REQUIRED_ENTRY_FIELDS).toContain('id')
      expect(REQUIRED_ENTRY_FIELDS).toContain('actor')
      expect(REQUIRED_ENTRY_FIELDS).toContain('action')
      expect(REQUIRED_ENTRY_FIELDS).toContain('risk_level')
      expect(REQUIRED_ENTRY_FIELDS).toContain('outcome')
    })

    it('valid action set includes governance actions', () => {
      expect(VALID_ACTIONS.has('approve')).toBe(true)
      expect(VALID_ACTIONS.has('reject')).toBe(true)
      expect(VALID_ACTIONS.has('commit')).toBe(true)
      expect(VALID_ACTIONS.has('escalate')).toBe(true)
    })

    it('valid risk levels match policy', () => {
      for (const level of ['Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs', 'TestOnly']) {
        expect(VALID_RISK_LEVELS.has(level)).toBe(true)
      }
    })
  })

  describe('validateEntry', () => {
    it('accepts a valid complete entry', () => {
      const entry = buildEntry(makeValidEntry())
      expect(validateEntry(entry)).toHaveLength(0)
    })

    it('rejects entry missing required fields', () => {
      const errors = validateEntry({ actor: 'x' })
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.join(' ')).toContain('action')
    })

    it('rejects unknown action', () => {
      const entry = buildEntry(makeValidEntry({ action: 'do_magic' }))
      const errors = validateEntry(entry)
      expect(errors.join(' ')).toContain('Unknown action')
    })

    it('rejects unknown risk_level', () => {
      const entry = buildEntry(makeValidEntry({ risk_level: 'MediumHigh' }))
      expect(validateEntry(entry).join(' ')).toContain('Unknown risk_level')
    })

    it('rejects invalid outcome', () => {
      const entry = buildEntry(makeValidEntry({ outcome: 'winning' }))
      expect(validateEntry(entry).join(' ')).toContain('Unknown outcome')
    })

    it('rejects unknown extra fields', () => {
      const entry = { ...buildEntry(makeValidEntry()), undocumented_field: 'x' }
      expect(validateEntry(entry).join(' ')).toContain('Unknown fields')
    })

    it('rejects non-array authority_chain', () => {
      const entry = buildEntry(makeValidEntry({ authority_chain: 'chief-arbiter' as any }))
      expect(validateEntry(entry).join(' ')).toContain('authority_chain must be an array')
    })
  })

  describe('buildEntry', () => {
    it('generates an id when not provided', () => {
      const entry = buildEntry(makeValidEntry())
      expect(entry.id).toBeTruthy()
      expect(entry.id.startsWith('ej-')).toBe(true)
    })

    it('uses provided id', () => {
      const entry = buildEntry(makeValidEntry({ id: 'custom-id' }))
      expect(entry.id).toBe('custom-id')
    })

    it('uses provided timestamp', () => {
      const ts = '2026-05-10T12:00:00.000Z'
      const entry = buildEntry(makeValidEntry({ timestamp: ts }))
      expect(entry.timestamp).toBe(ts)
    })
  })

  describe('generateId', () => {
    it('generates unique ids', () => {
      const ids = new Set(Array.from({ length: 20 }, () => generateId()))
      expect(ids.size).toBe(20)
    })

    it('starts with ej- prefix', () => {
      expect(generateId().startsWith('ej-')).toBe(true)
    })
  })

  describe('appendEntry and readEntries', () => {
    it('appends a valid entry and reads it back', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      const result = appendEntry(journalPath, makeValidEntry())
      expect(result.ok).toBe(true)
      expect(result.entry).toBeDefined()

      const entries = readEntries(journalPath)
      expect(entries).toHaveLength(1)
      expect(entries[0].actor).toBe('chief-arbiter')
    })

    it('rejects invalid entry without writing', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      const result = appendEntry(journalPath, { actor: 'x' })
      expect(result.ok).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(fs.existsSync(journalPath)).toBe(false)
    })

    it('appends multiple entries sequentially', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      appendEntry(journalPath, makeValidEntry({ action: 'approve' }))
      appendEntry(journalPath, makeValidEntry({ action: 'commit', outcome: 'success' }))
      appendEntry(journalPath, makeValidEntry({ action: 'route', risk_level: 'Low' }))

      const entries = readEntries(journalPath)
      expect(entries).toHaveLength(3)
    })
  })

  describe('readEntries filtering', () => {
    it('filters by actor', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      appendEntry(journalPath, makeValidEntry({ actor: 'security-governor' }))
      appendEntry(journalPath, makeValidEntry({ actor: 'release-governor' }))

      expect(readEntries(journalPath, { actor: 'security-governor' })).toHaveLength(1)
      expect(readEntries(journalPath, { actor: 'release-governor' })).toHaveLength(1)
    })

    it('filters by outcome', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      appendEntry(journalPath, makeValidEntry({ outcome: 'success' }))
      appendEntry(journalPath, makeValidEntry({ outcome: 'failure' }))

      expect(readEntries(journalPath, { outcome: 'failure' })).toHaveLength(1)
    })

    it('returns empty array when journal does not exist', () => {
      expect(readEntries('/nonexistent/path/journal.jsonl')).toHaveLength(0)
    })
  })

  describe('verifyJournal', () => {
    it('reports valid entries as valid', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      appendEntry(journalPath, makeValidEntry())
      appendEntry(journalPath, makeValidEntry({ action: 'commit' }))

      const result = verifyJournal(journalPath)
      expect(result.total).toBe(2)
      expect(result.valid).toBe(2)
      expect(result.invalid).toBe(0)
    })

    it('detects invalid entries in journal', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      fs.mkdirSync(path.dirname(journalPath), { recursive: true })
      fs.writeFileSync(journalPath, JSON.stringify({ actor: 'x' }) + '\n', 'utf8')

      const result = verifyJournal(journalPath)
      expect(result.invalid).toBe(1)
    })
  })

  describe('status mode', () => {
    it('returns correct shape when journal missing', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const result = buildStatusMode(root, { dataDir: '.data' })

      expect(result.agent).toBe(AGENT)
      expect(result.mode).toBe('status')
      expect(result.metadata.journal_exists).toBe(false)
      expect(result.metadata.total_entries).toBe(0)
    })

    it('reflects entry count after writes', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })

      appendEntry(journalPath, makeValidEntry())
      appendEntry(journalPath, makeValidEntry({ action: 'commit' }))

      const result = buildStatusMode(root, { dataDir: '.data' })
      expect(result.metadata.total_entries).toBe(2)
      expect(result.metadata.journal_exists).toBe(true)
    })
  })

  describe('append mode', () => {
    it('writes a valid entry and returns PASS', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const result = buildAppendMode(root, makeValidEntry(), { dataDir: '.data' })

      expect(result.status).toBe('PASS')
      expect(result.metadata.entry).toBeDefined()
      expect(result.metadata.entry.actor).toBe('chief-arbiter')
    })

    it('returns FAIL for invalid entry', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const result = buildAppendMode(root, { actor: 'only-actor' }, { dataDir: '.data' })

      expect(result.status).toBe('FAIL')
      expect(result.metadata.errors.length).toBeGreaterThan(0)
    })
  })

  describe('verify mode', () => {
    it('returns PASS when all entries are valid', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })
      appendEntry(journalPath, makeValidEntry())

      const result = buildVerifyMode(root, { dataDir: '.data' })
      expect(result.status).toBe('PASS')
      expect(result.metadata.valid).toBe(1)
    })
  })

  describe('inspect mode', () => {
    it('returns matched entries', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      const journalPath = resolveJournalPath(root, { dataDir: '.data' })
      appendEntry(journalPath, makeValidEntry({ actor: 'security-governor', action: 'approve' }))
      appendEntry(journalPath, makeValidEntry({ actor: 'release-governor', action: 'approve' }))

      const result = buildInspectMode(root, { actor: 'security-governor' }, { dataDir: '.data' })
      expect(result.metadata.count).toBe(1)
      expect(result.metadata.entries[0].actor).toBe('security-governor')
    })
  })

  describe('cli', () => {
    it('status CLI returns valid JSON', () => {
      const result = spawnSync(process.execPath, ['scripts/execution-journal.cjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.agent).toBe(AGENT)
      expect(parsed.mode).toBe('status')
    })

    it('append CLI rejects malformed entry JSON', () => {
      const result = spawnSync(
        process.execPath,
        ['scripts/execution-journal.cjs', 'append', '--entry', '{bad json'],
        { cwd: ROOT, encoding: 'utf8' },
      )
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.status).toBe('FAIL')
    })
  })
})
