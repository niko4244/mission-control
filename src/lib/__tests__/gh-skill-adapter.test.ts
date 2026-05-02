import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/gh-skill-adapter.cjs')
const FIXTURE_PATH = path.resolve(__dirname, '../../../data/mission-control/gh-skills/documentation-writer.md')
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

const FORBIDDEN_COMMANDS = [
  'gh skill install', 'gh auth', 'fetch(', 'http.get', 'https.get',
  'axios', 'node-fetch', 'XMLHttpRequest', 'execSync', 'spawnSync', 'exec(',
  'spawn(', 'eval(', 'Function(',
]

function runAdapter(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    timeout: 10000,
  })
  return { stdout: r.stdout || '', status: r.status }
}

describe('gh-skill-adapter', () => {
  it('emits valid JSON for documentation-writer fixture', () => {
    const { stdout } = runAdapter([FIXTURE_PATH, '--name', 'documentation-writer', '--source', 'github/awesome-copilot'])
    expect(() => JSON.parse(stdout)).not.toThrow()
  })

  it('status is ok', () => {
    const { stdout } = runAdapter([FIXTURE_PATH])
    expect(JSON.parse(stdout).status).toBe('ok')
  })

  it('exits 0 on valid input', () => {
    expect(runAdapter([FIXTURE_PATH]).status).toBe(0)
  })

  it('exits 1 with no arguments', () => {
    expect(runAdapter([]).status).toBe(1)
  })

  it('skill.type is gh-skill', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(skill.type).toBe('gh-skill')
  })

  it('extracts title from h1', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(skill.title).toBe('Diátaxis Documentation Expert')
  })

  it('extracted_sections.principles is populated', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(skill.extracted_sections.principles).toBeTruthy()
    expect(skill.extracted_sections.principles).toContain('Clarity')
  })

  it('extracted_sections.workflow is populated', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(skill.extracted_sections.workflow).toBeTruthy()
    expect(skill.extracted_sections.workflow).toContain('Acknowledge')
  })

  it('extracted_sections.task_definition is populated', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(skill.extracted_sections.task_definition).toBeTruthy()
    expect(skill.extracted_sections.task_definition).toContain('Diátaxis')
  })

  it('risk_level is a number 0-3', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect([0, 1, 2, 3]).toContain(skill.risk_level)
  })

  it('mc_compatibility is boolean', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(typeof skill.mc_compatibility).toBe('boolean')
  })

  it('--name flag sets skill name', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH, '--name', 'doc-writer']).stdout).skill
    expect(skill.name).toBe('doc-writer')
  })

  it('--source flag sets skill source', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH, '--source', 'github/awesome-copilot']).stdout).skill
    expect(skill.source).toBe('github/awesome-copilot')
  })

  it('--content flag works without a file', () => {
    const content = '# My Skill\n\n## GUIDING PRINCIPLES\n\nBe good.\n\n## WORKFLOW\n\nDo the thing.'
    const { stdout, status } = runAdapter(['--content', content, '--name', 'my-skill'])
    expect(status).toBe(0)
    const skill = JSON.parse(stdout).skill
    expect(skill.extracted_sections.principles).toContain('Be good')
    expect(skill.extracted_sections.workflow).toContain('Do the thing')
  })

  it('strips gh skill preview header when present', () => {
    const withHeader = 'documentation-writer/\n└── SKILL.md\n\n── SKILL.md ──\n\n# My Expert\n\n## WORKFLOW\n\nStep 1.'
    const { stdout } = runAdapter(['--content', withHeader])
    const skill = JSON.parse(stdout).skill
    expect(skill.title).toBe('My Expert')
  })

  it('all_sections lists discovered h2 headings', () => {
    const skill = JSON.parse(runAdapter([FIXTURE_PATH]).stdout).skill
    expect(Array.isArray(skill.all_sections)).toBe(true)
    expect(skill.all_sections.length).toBeGreaterThan(0)
  })

  it('does not contain forbidden commands in script source', () => {
    const source = fs.readFileSync(SCRIPT_PATH, 'utf-8')
    for (const cmd of FORBIDDEN_COMMANDS) {
      expect(source, `forbidden in source: "${cmd}"`).not.toContain(cmd)
    }
  })
})
