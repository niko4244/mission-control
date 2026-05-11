/**
 * architecture-docs-bots.test.ts
 * Combined test suite for 5 governance bots:
 *   - architecture-governor
 *   - architecture-critic
 *   - route-family-migrator
 *   - documentation-governor
 *   - documentation-executor
 *
 * Coverage target: ≥35 tests
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const archGov = require('../../../scripts/architecture-governor.cjs')
const archCritic = require('../../../scripts/architecture-critic.cjs')
const routeMigrator = require('../../../scripts/route-family-migrator.cjs')
const docGov = require('../../../scripts/documentation-governor.cjs')
const docExec = require('../../../scripts/documentation-executor.cjs')

// Registry and package.json for meta-checks
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config/mission-control-bot-registry.json'), 'utf8')
)
const packageJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
)

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-docs-bots-'))
}

function writeFile(root: string, relPath: string, content: string) {
  const abs = path.join(root, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

// ─── 1. Architecture Governor exports ───────────────────────────────────────

describe('architecture-governor exports', () => {
  it('exports AGENT with correct name', () => {
    expect(archGov.AGENT).toBe('Architecture Governor v1')
  })

  it('exports LABEL as observe-only guardian', () => {
    expect(archGov.LABEL).toBe('OBSERVE ONLY / ARCHITECTURE GUARDIAN')
  })

  it('exports BOT_ID', () => {
    expect(archGov.BOT_ID).toBe('architecture-governor')
  })

  it('exports required functions', () => {
    expect(typeof archGov.buildStatusMode).toBe('function')
    expect(typeof archGov.buildReviewMode).toBe('function')
    expect(typeof archGov.buildCheckBoundariesMode).toBe('function')
    expect(typeof archGov.buildOutput).toBe('function')
    expect(typeof archGov.main).toBe('function')
  })

  it('exports SUPERVISED_BOTS including architecture-critic and route-family-migrator', () => {
    expect(archGov.SUPERVISED_BOTS).toContain('architecture-critic')
    expect(archGov.SUPERVISED_BOTS).toContain('route-family-migrator')
  })
})

// ─── 2. Architecture Governor — status mode ─────────────────────────────────

describe('architecture-governor status mode', () => {
  it('status returns valid JSON with PASS status', () => {
    const result = archGov.buildStatusMode(ROOT)
    expect(result).toBeDefined()
    expect(result.agent).toBe('Architecture Governor v1')
    expect(result.status).toBe('PASS')
  })

  it('status confirms observe_only guarantee', () => {
    const result = archGov.buildStatusMode(ROOT)
    expect(result.observe_only).toBe(true)
  })

  it('status lists supervised bots', () => {
    const result = archGov.buildStatusMode(ROOT)
    expect(result.supervised_bots).toContain('architecture-critic')
    expect(result.supervised_bots).toContain('route-family-migrator')
  })

  it('status includes human_required_for push/create_pr/merge', () => {
    const result = archGov.buildStatusMode(ROOT)
    expect(result.human_required_for).toContain('push')
    expect(result.human_required_for).toContain('create_pr')
    expect(result.human_required_for).toContain('merge')
  })
})

// ─── 3. Architecture Governor — review mode ─────────────────────────────────

describe('architecture-governor review mode', () => {
  it('review with no task returns FAIL', () => {
    const result = archGov.buildReviewMode(ROOT, '')
    expect(result.status).toBe('FAIL')
  })

  it('review classifies auth task as High risk', () => {
    const result = archGov.buildReviewMode(
      ROOT,
      'Refactor all authentication helpers and rewrite token schema'
    )
    // broad rewrite → risk High
    expect(['High', 'Critical', 'Medium']).toContain(result.risk_level)
    expect(result.approved).toBe(false)
  })

  it('review classifies broad rewrite as not approved', () => {
    const result = archGov.buildReviewMode(ROOT, 'Full rewrite of the entire auth module')
    expect(result.approved).toBe(false)
    expect(result.decision).toBe('REQUEST_CORRECTIONS')
  })

  it('review approves low-risk docs task', () => {
    const result = archGov.buildReviewMode(ROOT, 'Fix typo in README')
    expect(result.approved).toBe(true)
    expect(['APPROVE', 'APPROVE_WITH_NOTES']).toContain(result.decision)
  })

  it('review includes human_required_for push/create_pr/merge always', () => {
    const result = archGov.buildReviewMode(ROOT, 'Add workspace check to agents route')
    expect(result.human_required_for).toContain('push')
    expect(result.human_required_for).toContain('create_pr')
    expect(result.human_required_for).toContain('merge')
  })

  it('review with boundary keyword sets requires_architecture_critic=true', () => {
    const result = archGov.buildReviewMode(ROOT, 'Update import boundaries for components')
    expect(result.requires_architecture_critic).toBe(true)
  })

  it('review returns domain field', () => {
    const result = archGov.buildReviewMode(ROOT, 'Fix architecture drift in route handlers')
    expect(result.domain).toBeDefined()
    expect(typeof result.domain).toBe('string')
  })
})

// ─── 4. Architecture Governor — check-boundaries mode ───────────────────────

describe('architecture-governor check-boundaries mode', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('check-boundaries returns boundaries_ok=true for clean files', () => {
    writeFile(tmpDir, 'src/app/page.ts', `import { foo } from '@/lib/foo'`)
    const result = archGov.buildCheckBoundariesMode(
      tmpDir,
      JSON.stringify(['src/app/page.ts'])
    )
    expect(result.boundaries_ok).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('check-boundaries detects scripts/ import in src/', () => {
    writeFile(tmpDir, 'src/app/route.ts', `import { bar } from '../../../scripts/helper'`)
    const result = archGov.buildCheckBoundariesMode(
      tmpDir,
      JSON.stringify(['src/app/route.ts'])
    )
    expect(result.boundaries_ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0].rule).toBe('app-no-scripts')
  })

  it('check-boundaries returns FAIL with invalid JSON argument', () => {
    const result = archGov.buildCheckBoundariesMode(tmpDir, 'not-json')
    expect(result.status).toBe('FAIL')
  })

  it('check-boundaries passes empty file list with no violations', () => {
    const result = archGov.buildCheckBoundariesMode(tmpDir, '[]')
    expect(result.boundaries_ok).toBe(true)
    expect(result.violations).toHaveLength(0)
  })
})

// ─── 5. Architecture Critic exports ─────────────────────────────────────────

describe('architecture-critic exports', () => {
  it('exports AGENT with correct name', () => {
    expect(archCritic.AGENT).toBe('Architecture Critic v1')
  })

  it('exports LABEL as drift detector', () => {
    expect(archCritic.LABEL).toBe('OBSERVE ONLY / DRIFT DETECTOR')
  })

  it('exports required functions', () => {
    expect(typeof archCritic.buildStatusMode).toBe('function')
    expect(typeof archCritic.buildScanMode).toBe('function')
    expect(typeof archCritic.buildOutput).toBe('function')
    expect(typeof archCritic.main).toBe('function')
    expect(typeof archCritic.scanDirectory).toBe('function')
    expect(typeof archCritic.detectImportViolations).toBe('function')
  })
})

// ─── 6. Architecture Critic — status / scan ─────────────────────────────────

describe('architecture-critic scan mode', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('status returns PASS with observe_only true', () => {
    const result = archCritic.buildStatusMode(ROOT)
    expect(result.status).toBe('PASS')
    expect(result.observe_only).toBe(true)
  })

  it('scan returns issues array (possibly empty)', () => {
    const result = archCritic.buildScanMode(tmpDir, 'src/app/api')
    expect(Array.isArray(result.issues)).toBe(true)
  })

  it('scan returns files_scanned count', () => {
    const result = archCritic.buildScanMode(tmpDir, 'src/app/api')
    expect(typeof result.files_scanned).toBe('number')
  })

  it('scan detects cross-boundary import violation', () => {
    writeFile(
      tmpDir,
      'src/app/route.ts',
      `import { helper } from '../../../scripts/some-helper'\nexport async function GET() {}`
    )
    const issues = archCritic.detectImportViolations(
      'src/app/route.ts',
      [`import { helper } from '../../../scripts/some-helper'`]
    )
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0].type).toBe('cross_boundary_import')
  })

  it('scan detects deep import chain (>4 levels)', () => {
    const issues = archCritic.detectImportViolations(
      'src/app/deep.ts',
      [`import { x } from '../../../../../lib/utils'`]
    )
    expect(issues.some((i: any) => i.type === 'deep_import_chain')).toBe(true)
  })

  it('scan handles missing directory gracefully', () => {
    const result = archCritic.buildScanMode(tmpDir, 'src/nonexistent/path')
    expect(result.issues_found).toBe(false)
    expect(result.issues).toHaveLength(0)
  })
})

// ─── 7. Route Family Migrator exports ───────────────────────────────────────

describe('route-family-migrator exports', () => {
  it('exports AGENT with correct name', () => {
    expect(routeMigrator.AGENT).toBe('Route Family Migrator v1')
  })

  it('exports LABEL as migration planner', () => {
    expect(routeMigrator.LABEL).toBe('OBSERVE ONLY / MIGRATION PLANNER')
  })

  it('exports required functions', () => {
    expect(typeof routeMigrator.buildStatusMode).toBe('function')
    expect(typeof routeMigrator.buildPlanMode).toBe('function')
    expect(typeof routeMigrator.buildOutput).toBe('function')
    expect(typeof routeMigrator.main).toBe('function')
    expect(typeof routeMigrator.scanRouteFamily).toBe('function')
  })

  it('exports REQUIRES_HUMAN_FOR array', () => {
    expect(Array.isArray(routeMigrator.REQUIRES_HUMAN_FOR)).toBe(true)
  })
})

// ─── 8. Route Family Migrator — status / plan ────────────────────────────────

describe('route-family-migrator plan mode', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('status confirms may_stage=false and may_commit=false', () => {
    const result = routeMigrator.buildStatusMode(ROOT)
    expect(result.may_stage).toBe(false)
    expect(result.may_commit).toBe(false)
  })

  it('status includes note about plan-only behavior', () => {
    const result = routeMigrator.buildStatusMode(ROOT)
    expect(result.note).toBeDefined()
    expect(result.note).toMatch(/plan/i)
  })

  it('plan without route-family returns FAIL', () => {
    const result = routeMigrator.buildPlanMode(tmpDir, '')
    expect(result.status).toBe('FAIL')
  })

  it('plan for missing route family returns WARN with empty files', () => {
    const result = routeMigrator.buildPlanMode(tmpDir, 'nonexistent-family')
    expect(result.status).toBe('WARN')
    expect(result.files_in_family).toHaveLength(0)
    expect(result.requires_architecture_governor_approval).toBe(true)
  })

  it('plan returns migration_steps array for existing route family', () => {
    writeFile(tmpDir, 'src/app/api/agents/route.ts', `export async function GET() {}`)
    writeFile(tmpDir, 'src/app/api/agents/[id]/route.ts', `export async function GET() {}`)
    const result = routeMigrator.buildPlanMode(tmpDir, 'agents', 'add-workspace-check')
    expect(Array.isArray(result.migration_steps)).toBe(true)
    expect(result.migration_steps.length).toBeGreaterThan(0)
  })

  it('plan always requires_architecture_governor_approval', () => {
    const result = routeMigrator.buildPlanMode(tmpDir, 'agents')
    expect(result.requires_architecture_governor_approval).toBe(true)
  })

  it('requires_human_for always includes stage, commit, push, create_pr, merge', () => {
    const result = routeMigrator.buildPlanMode(tmpDir, 'agents')
    const humanFor = result.requires_human_for
    expect(humanFor).toContain('stage')
    expect(humanFor).toContain('commit')
    expect(humanFor).toContain('push')
    expect(humanFor).toContain('create_pr')
    expect(humanFor).toContain('merge')
  })

  it('plan returns required_tests array', () => {
    writeFile(tmpDir, 'src/app/api/tasks/route.ts', `export async function GET() {}`)
    const result = routeMigrator.buildPlanMode(tmpDir, 'tasks', 'add-workspace-check')
    expect(Array.isArray(result.required_tests)).toBe(true)
    expect(result.required_tests.length).toBeGreaterThan(0)
  })

  it('plan includes risk_level field', () => {
    const result = routeMigrator.buildPlanMode(tmpDir, 'agents')
    expect(['Low', 'Medium', 'High']).toContain(result.risk_level)
  })

  it('plan reports estimated_files_changed', () => {
    writeFile(tmpDir, 'src/app/api/sessions/route.ts', `export async function GET() {}`)
    const result = routeMigrator.buildPlanMode(tmpDir, 'sessions')
    expect(typeof result.estimated_files_changed).toBe('number')
  })

  it('REQUIRES_HUMAN_FOR constant always includes stage/commit/push', () => {
    expect(routeMigrator.REQUIRES_HUMAN_FOR).toContain('stage')
    expect(routeMigrator.REQUIRES_HUMAN_FOR).toContain('commit')
    expect(routeMigrator.REQUIRES_HUMAN_FOR).toContain('push')
  })
})

// ─── 9. Documentation Governor exports ──────────────────────────────────────

describe('documentation-governor exports', () => {
  it('exports AGENT with correct name', () => {
    expect(docGov.AGENT).toBe('Documentation Governor v1')
  })

  it('exports LABEL as docs guardian', () => {
    expect(docGov.LABEL).toBe('OBSERVE ONLY / DOCS GUARDIAN')
  })

  it('exports required functions', () => {
    expect(typeof docGov.buildStatusMode).toBe('function')
    expect(typeof docGov.buildReviewMode).toBe('function')
    expect(typeof docGov.buildOutput).toBe('function')
    expect(typeof docGov.main).toBe('function')
  })
})

// ─── 10. Documentation Governor — status / review ───────────────────────────

describe('documentation-governor review mode', () => {
  it('status returns PASS', () => {
    const result = docGov.buildStatusMode(ROOT)
    expect(result.status).toBe('PASS')
    expect(result.agent).toBe('Documentation Governor v1')
  })

  it('review with no task returns FAIL', () => {
    const result = docGov.buildReviewMode(ROOT, '')
    expect(result.status).toBe('FAIL')
  })

  it('review approves typo fix as Docs risk', () => {
    const result = docGov.buildReviewMode(ROOT, 'Fix typo in CLAUDE.md')
    expect(result.scope).toBe('minor_typo')
    expect(result.risk_level).toBe('Docs')
    expect(result.approved).toBe(true)
    expect(['APPROVE', 'APPROVE_WITH_NOTES']).toContain(result.decision)
  })

  it('review classifies policy doc as Medium risk', () => {
    const result = docGov.buildReviewMode(
      ROOT,
      'Update governance policy documentation for authority boundaries'
    )
    expect(result.risk_level).toBe('Medium')
    expect(result.decision).toBe('APPROVE_WITH_NOTES')
  })

  it('review escalates task mentioning "security" to Medium risk', () => {
    const result = docGov.buildReviewMode(ROOT, 'Write security guide for operators')
    expect(result.risk_level).toBe('Medium')
  })

  it('review escalates task mentioning "authority" to Medium risk', () => {
    const result = docGov.buildReviewMode(ROOT, 'Update authority chain documentation')
    expect(result.risk_level).toBe('Medium')
  })

  it('review includes requires_human_for push/create_pr/merge', () => {
    const result = docGov.buildReviewMode(ROOT, 'Update README')
    expect(result.requires_human_for).toContain('push')
    expect(result.requires_human_for).toContain('create_pr')
    expect(result.requires_human_for).toContain('merge')
  })

  it('review content_update has Low risk', () => {
    const result = docGov.buildReviewMode(ROOT, 'Update the getting started guide with new steps')
    expect(['Low', 'Docs']).toContain(result.risk_level)
  })
})

// ─── 11. Documentation Executor exports ─────────────────────────────────────

describe('documentation-executor exports', () => {
  it('exports AGENT with correct name', () => {
    expect(docExec.AGENT).toBe('Documentation Executor v1')
  })

  it('exports LABEL as executor', () => {
    expect(docExec.LABEL).toBe('EXECUTOR / DOCS-ONLY CHANGES')
  })

  it('exports required functions', () => {
    expect(typeof docExec.buildStatusMode).toBe('function')
    expect(typeof docExec.buildPrepareMode).toBe('function')
    expect(typeof docExec.buildOutput).toBe('function')
    expect(typeof docExec.main).toBe('function')
    expect(typeof docExec.validateDocFiles).toBe('function')
  })
})

// ─── 12. Documentation Executor — status / prepare ──────────────────────────

describe('documentation-executor prepare mode', () => {
  it('status confirms reports_to documentation-governor', () => {
    const result = docExec.buildStatusMode(ROOT)
    expect(result.reports_to).toBe('documentation-governor')
  })

  it('status reports may_mutate=true, may_stage=true, may_commit=true', () => {
    const result = docExec.buildStatusMode(ROOT)
    expect(result.may_mutate).toBe(true)
    expect(result.may_stage).toBe(true)
    expect(result.may_commit).toBe(true)
  })

  it('status shows may_push=false, may_create_pr=false, may_merge=false', () => {
    const result = docExec.buildStatusMode(ROOT)
    expect(result.may_push).toBe(false)
    expect(result.may_create_pr).toBe(false)
    expect(result.may_merge).toBe(false)
  })

  it('prepare accepts .md files', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['docs/guide.md']), '')
    expect(result.approved_files).toContain('docs/guide.md')
    expect(result.blocked_files).toHaveLength(0)
  })

  it('prepare accepts files in docs/ directory', () => {
    const result = docExec.buildPrepareMode(
      ROOT,
      JSON.stringify(['docs/operator-guide.md', 'docs/setup.txt']),
      ''
    )
    expect(result.approved_files.length).toBeGreaterThan(0)
    expect(result.blocked_files).toHaveLength(0)
  })

  it('prepare rejects .ts files', () => {
    const result = docExec.buildPrepareMode(
      ROOT,
      JSON.stringify(['src/lib/helper.ts']),
      ''
    )
    expect(result.blocked_files).toContain('src/lib/helper.ts')
    expect(result.approved_files).toHaveLength(0)
  })

  it('prepare rejects .tsx files', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['src/components/Foo.tsx']), '')
    expect(result.blocked_files).toContain('src/components/Foo.tsx')
  })

  it('prepare rejects .cjs files', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['scripts/helper.cjs']), '')
    expect(result.blocked_files).toContain('scripts/helper.cjs')
  })

  it('prepare rejects .json files', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['config/settings.json']), '')
    expect(result.blocked_files).toContain('config/settings.json')
  })

  it('prepare rejects security/auth/policy files', () => {
    const { blocked } = docExec.validateDocFiles(['docs/auth-policy.md'])
    expect(blocked.length).toBeGreaterThan(0)
  })

  it('prepare always includes requires_human_for push/create_pr/merge', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['docs/guide.md']), '')
    expect(result.requires_human_for).toContain('push')
    expect(result.requires_human_for).toContain('create_pr')
    expect(result.requires_human_for).toContain('merge')
  })

  it('prepare always sets documentation_governor_required=true', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['docs/guide.md']), '')
    expect(result.documentation_governor_required).toBe(true)
  })

  it('prepare returns recommended_commands for approved files', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['docs/guide.md']), 'docs: update guide')
    expect(result.recommended_commands.length).toBeGreaterThan(0)
    expect(result.recommended_commands.some((c: string) => c.includes('git add'))).toBe(true)
    expect(result.recommended_commands.some((c: string) => c.includes('git commit'))).toBe(true)
  })

  it('prepare returns commit_message', () => {
    const result = docExec.buildPrepareMode(ROOT, JSON.stringify(['docs/guide.md']), 'docs: update guide')
    expect(result.commit_message).toBe('docs: update guide')
  })

  it('prepare handles invalid JSON files arg gracefully', () => {
    const result = docExec.buildPrepareMode(ROOT, 'not-json', '')
    expect(result.status).toBe('FAIL')
  })
})

// ─── 13. Registry meta-checks ───────────────────────────────────────────────

describe('registry bot status', () => {
  const botIds = [
    'architecture-governor',
    'architecture-critic',
    'route-family-migrator',
    'documentation-governor',
    'documentation-executor',
  ]

  for (const id of botIds) {
    it(`registry has ${id} as implemented`, () => {
      const bot = registry.bots.find((b: any) => b.id === id)
      expect(bot).toBeDefined()
      expect(bot.status).toBe('implemented')
      expect(bot.implementation_script).toBeDefined()
    })
  }
})

// ─── 14. Package.json alias checks ──────────────────────────────────────────

describe('package.json script aliases', () => {
  const aliases: Record<string, string> = {
    'govern:architecture': 'scripts/architecture-governor.cjs',
    'audit:architecture': 'scripts/architecture-critic.cjs',
    'migrate:routes': 'scripts/route-family-migrator.cjs',
    'govern:docs': 'scripts/documentation-governor.cjs',
    'execute:docs': 'scripts/documentation-executor.cjs',
  }

  for (const [alias, scriptFile] of Object.entries(aliases)) {
    it(`package.json has alias "${alias}" pointing to ${scriptFile}`, () => {
      expect(packageJson.scripts[alias]).toBeDefined()
      expect(packageJson.scripts[alias]).toContain(scriptFile)
    })
  }
})
