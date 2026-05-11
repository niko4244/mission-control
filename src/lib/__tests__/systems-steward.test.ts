import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  BOT_ID,
  MARKER_PATTERNS,
  buildRecommendMode,
  buildRecommendations,
  buildScanMode,
  buildStatusMode,
  detectGovernanceScriptsWithoutTests,
  detectMissingPackageAliases,
  detectOrphanedScripts,
  detectPlannedBotsWithoutScripts,
  loadBotSystem,
  runScan,
  scanFileForMarkers,
} = require('../../../scripts/systems-steward.cjs')

const {
  loadRegistry,
} = require('../../../scripts/mission-control-bot-system.cjs')

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'systems-steward-'))
}

function writeTempFile(root: string, relative: string, content: string) {
  const absolute = path.join(root, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('systems steward', () => {
  describe('identity', () => {
    it('exports correct agent identity', () => {
      expect(AGENT).toBe('Systems Steward v1')
      expect(LABEL).toContain('OBSERVE ONLY')
      expect(BOT_ID).toBe('systems-steward')
    })

    it('exports all required functions', () => {
      expect(typeof buildStatusMode).toBe('function')
      expect(typeof buildScanMode).toBe('function')
      expect(typeof buildRecommendMode).toBe('function')
      expect(typeof runScan).toBe('function')
      expect(typeof buildRecommendations).toBe('function')
    })

    it('defines marker patterns for key signals', () => {
      const labels = MARKER_PATTERNS.map((p: any) => p.label)
      expect(labels).toContain('TODO')
      expect(labels).toContain('FIXME')
      expect(labels).toContain('placeholder')
      expect(labels).toContain('stub')
    })
  })

  describe('status mode', () => {
    it('returns canonical output shape', () => {
      const result = buildStatusMode(ROOT)

      expect(result.agent).toBe(AGENT)
      expect(result.label).toBe(LABEL)
      expect(result.mode).toBe('status')
      expect(result.observe_only).toBe(true)
      expect(['PASS', 'WARN', 'FAIL']).toContain(result.status)
      expect(Array.isArray(result.warnings)).toBe(true)
      expect(typeof result.summary).toBe('string')
    })

    it('reports observe-only explicitly', () => {
      const result = buildStatusMode(ROOT)
      expect(result.observe_only).toBe(true)
      expect(result.metadata.observe_only).toBe(true)
    })

    it('detects planned bots remaining', () => {
      const result = buildStatusMode(ROOT)
      expect(Array.isArray(result.metadata.planned_bots)).toBe(true)
      expect(result.metadata.planned_bots.length).toBeGreaterThan(0)
    })

    it('reports key system availability', () => {
      const result = buildStatusMode(ROOT)
      const systems = result.metadata.key_systems as any[]

      expect(Array.isArray(systems)).toBe(true)
      expect(systems.length).toBeGreaterThan(0)
      expect(systems.every((s: any) => typeof s.script === 'string' && typeof s.available === 'boolean')).toBe(true)
    })

    it('warns when planned bots exist', () => {
      const result = buildStatusMode(ROOT)
      const hasPlanWarning = result.warnings.some((w: string) => w.includes('planned bot'))
      expect(hasPlanWarning).toBe(true)
    })
  })

  describe('scan mode', () => {
    it('returns canonical output shape', () => {
      const result = buildScanMode(ROOT)

      expect(result.agent).toBe(AGENT)
      expect(result.mode).toBe('scan')
      expect(result.observe_only).toBe(true)
      expect(typeof result.metadata.files_scanned).toBe('number')
      expect(typeof result.metadata.total_markers).toBe('number')
      expect(typeof result.metadata.marker_summary).toBe('object')
    })

    it('scans a meaningful number of files', () => {
      const result = buildScanMode(ROOT)
      expect(result.metadata.files_scanned).toBeGreaterThan(10)
    })

    it('detects planned bots without scripts', () => {
      const result = buildScanMode(ROOT)
      expect(Array.isArray(result.metadata.planned_bots_without_scripts)).toBe(true)
      expect(result.metadata.planned_bots_without_scripts.length).toBeGreaterThan(0)
    })

    it('planned bot entries include required fields', () => {
      const result = buildScanMode(ROOT)
      const bots = result.metadata.planned_bots_without_scripts as any[]
      for (const bot of bots.slice(0, 3)) {
        expect(typeof bot.id).toBe('string')
        expect(typeof bot.script_expected).toBe('string')
        expect(typeof bot.script_exists).toBe('boolean')
      }
    })

    it('scan detects marker presence across known files', () => {
      const result = buildScanMode(ROOT)
      expect(result.metadata.total_markers).toBeGreaterThan(0)
      expect(typeof result.metadata.marker_summary.TODO).toBe('number')
      expect(typeof result.metadata.marker_summary.placeholder).toBe('number')
    })

    it('does not authorize any mutation', () => {
      const result = buildScanMode(ROOT)
      expect(result.observe_only).toBe(true)
      expect(result).not.toHaveProperty('authorization')
    })
  })

  describe('recommend mode', () => {
    it('returns canonical output with selected_next_task', () => {
      const result = buildRecommendMode(ROOT)

      expect(result.agent).toBe(AGENT)
      expect(result.mode).toBe('recommend')
      expect(result.observe_only).toBe(true)
      expect(typeof result.metadata.total_recommendations).toBe('number')
      expect(result.metadata.selected_next_task).not.toBeNull()
    })

    it('selected_next_task has required fields', () => {
      const result = buildRecommendMode(ROOT)
      const task = result.metadata.selected_next_task as any

      expect(typeof task.title).toBe('string')
      expect(typeof task.reason).toBe('string')
      expect(typeof task.evidence).toBe('string')
      expect(typeof task.risk_level).toBe('string')
      expect(Array.isArray(task.likely_files)).toBe(true)
      expect(Array.isArray(task.validation_commands)).toBe(true)
      expect(typeof task.requires_governor_or_arbiter).toBe('boolean')
      expect(typeof task.autonomous_safe).toBe('boolean')
    })

    it('all recommendations include validation commands', () => {
      const result = buildRecommendMode(ROOT)
      const recs = result.metadata.recommendations as any[]

      for (const rec of recs) {
        expect(rec.validation_commands.length).toBeGreaterThan(0)
        expect(rec.evidence.length).toBeGreaterThan(0)
      }
    })

    it('does not authorize mutation', () => {
      const result = buildRecommendMode(ROOT)
      expect(result.observe_only).toBe(true)
      expect(result).not.toHaveProperty('authorization')
    })
  })

  describe('scanFileForMarkers', () => {
    it('detects TODO in file content', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      writeTempFile(root, 'scripts/example.cjs', '// TODO: implement this\nconst x = 1;\n')

      const hits = scanFileForMarkers(path.join(root, 'scripts/example.cjs'), root)
      expect(hits.length).toBe(1)
      expect(hits[0].marker).toBe('TODO')
      expect(hits[0].line).toBe(1)
    })

    it('detects placeholder in file content', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      writeTempFile(root, 'src/lib/example.ts', 'function foo() { /* placeholder */ }\n')

      const hits = scanFileForMarkers(path.join(root, 'src/lib/example.ts'), root)
      expect(hits.length).toBe(1)
      expect(hits[0].marker).toBe('placeholder')
    })

    it('returns empty for clean file', () => {
      const root = makeTempRoot()
      tempRoots.push(root)
      writeTempFile(root, 'scripts/clean.cjs', '\'use strict\';\nconst x = 1;\nexport default x;\n')

      const hits = scanFileForMarkers(path.join(root, 'scripts/clean.cjs'), root)
      expect(hits).toHaveLength(0)
    })
  })

  describe('detectPlannedBotsWithoutScripts', () => {
    it('returns bots from registry that are not implemented', () => {
      const registry = loadRegistry(ROOT)
      const result = detectPlannedBotsWithoutScripts(registry, ROOT)

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
      expect(result.every((b: any) => b.id && b.script_expected)).toBe(true)
    })

    it('does not include implemented bots', () => {
      const registry = loadRegistry(ROOT)
      const result = detectPlannedBotsWithoutScripts(registry, ROOT)
      const ids = result.map((b: any) => b.id)

      expect(ids).not.toContain('security-governor')
      expect(ids).not.toContain('release-governor')
    })
  })

  describe('detectGovernanceScriptsWithoutTests', () => {
    it('returns scripts missing test coverage', () => {
      const result = detectGovernanceScriptsWithoutTests(ROOT)
      expect(Array.isArray(result)).toBe(true)
      expect(result.every((s: any) => s.script && s.expected_test)).toBe(true)
    })
  })

  describe('detectMissingPackageAliases', () => {
    it('does not flag already-aliased scripts', () => {
      const result = detectMissingPackageAliases(ROOT)
      const aliasNames = result.map((a: any) => a.expected_alias)
      // govern:release is already wired
      expect(aliasNames).not.toContain('govern:release')
      expect(aliasNames).not.toContain('govern:bot-system')
    })
  })

  describe('detectOrphanedScripts', () => {
    it('returns scripts not in registry', () => {
      const registry = loadRegistry(ROOT)
      const result = detectOrphanedScripts(registry, ROOT)
      expect(Array.isArray(result)).toBe(true)
      expect(result.every((o: any) => o.script && o.status)).toBe(true)
    })
  })

  describe('bot system integration', () => {
    it('loads bot system successfully', () => {
      const state = loadBotSystem(ROOT)
      expect(state.available).toBe(true)
      expect(typeof state.api.buildStatusMode).toBe('function')
    })
  })

  describe('cli', () => {
    it('status CLI returns valid JSON with correct agent', () => {
      const result = spawnSync(process.execPath, ['scripts/systems-steward.cjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.agent).toBe(AGENT)
      expect(parsed.mode).toBe('status')
      expect(parsed.observe_only).toBe(true)
    })

    it('scan CLI returns valid JSON with files_scanned', () => {
      const result = spawnSync(process.execPath, ['scripts/systems-steward.cjs', 'scan'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30000,
      })
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.mode).toBe('scan')
      expect(typeof parsed.metadata.files_scanned).toBe('number')
    })

    it('recommend CLI returns valid JSON with selected_next_task', () => {
      const result = spawnSync(process.execPath, ['scripts/systems-steward.cjs', 'recommend'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30000,
      })
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout.split('\n\n')[0])
      expect(parsed.mode).toBe('recommend')
      expect(parsed.metadata.selected_next_task).not.toBeNull()
    })
  })
})
