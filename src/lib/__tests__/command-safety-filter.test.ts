import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  LABEL,
  SAFETY_RULES,
  checkCommand,
  filterCommands,
  isCommandSafe,
  main,
  parseArgs,
  runCheckMode,
  runFilterMode,
  runStatusMode,
} = require('../../../scripts/command-safety-filter.cjs')

describe('command safety filter — isCommandSafe', () => {
  it('isCommandSafe("git add .") returns false', () => {
    expect(isCommandSafe('git add .')).toBe(false)
  })

  it('isCommandSafe("git add src/lib/utils.ts") returns true', () => {
    expect(isCommandSafe('git add src/lib/utils.ts')).toBe(true)
  })

  it('isCommandSafe("git add -- src/lib/utils.ts") returns true', () => {
    expect(isCommandSafe('git add -- src/lib/utils.ts')).toBe(true)
  })

  it('isCommandSafe("git push --force") returns false', () => {
    expect(isCommandSafe('git push --force')).toBe(false)
  })

  it('isCommandSafe("git push -f") returns false', () => {
    expect(isCommandSafe('git push -f')).toBe(false)
  })

  it('isCommandSafe("git push") returns true', () => {
    // push alone (without --force) is allowed by the safety filter (governance is separate)
    expect(isCommandSafe('git push')).toBe(true)
  })

  it('isCommandSafe("pnpm test") returns true', () => {
    expect(isCommandSafe('pnpm test')).toBe(true)
  })

  it('isCommandSafe("pnpm vitest run src/lib/__tests__/foo.test.ts") returns true', () => {
    expect(isCommandSafe('pnpm vitest run src/lib/__tests__/foo.test.ts')).toBe(true)
  })

  it('isCommandSafe("git commit --no-verify") returns false', () => {
    expect(isCommandSafe('git commit --no-verify')).toBe(false)
  })

  it('isCommandSafe("git reset --hard") returns false', () => {
    expect(isCommandSafe('git reset --hard')).toBe(false)
  })

  it('isCommandSafe("git reset --hard HEAD~1") returns false', () => {
    expect(isCommandSafe('git reset --hard HEAD~1')).toBe(false)
  })

  it('isCommandSafe("git rebase -i HEAD~5") returns false', () => {
    expect(isCommandSafe('git rebase -i HEAD~5')).toBe(false)
  })

  it('isCommandSafe("git rebase --interactive HEAD~3") returns false', () => {
    expect(isCommandSafe('git rebase --interactive HEAD~3')).toBe(false)
  })

  it('isCommandSafe("git filter-branch --tree-filter ...") returns false', () => {
    expect(isCommandSafe('git filter-branch --tree-filter rm -f secrets.txt -- --all')).toBe(false)
  })

  it('isCommandSafe("rm -rf /") returns false', () => {
    expect(isCommandSafe('rm -rf /')).toBe(false)
  })

  it('isCommandSafe("rm -rf ~/projects") returns false', () => {
    expect(isCommandSafe('rm -rf ~/projects')).toBe(false)
  })

  it('isCommandSafe("DROP TABLE users") returns false', () => {
    expect(isCommandSafe('DROP TABLE users')).toBe(false)
  })

  it('isCommandSafe("DROP DATABASE mission_control") returns false', () => {
    expect(isCommandSafe('DROP DATABASE mission_control')).toBe(false)
  })

  it('isCommandSafe("git push --force-with-lease") returns false', () => {
    expect(isCommandSafe('git push --force-with-lease')).toBe(false)
  })

  it('isCommandSafe("git commit -m feat: something") returns true', () => {
    expect(isCommandSafe('git commit -m "feat: something"')).toBe(true)
  })

  it('isCommandSafe("git status") returns true', () => {
    expect(isCommandSafe('git status')).toBe(true)
  })

  it('isCommandSafe("git diff") returns true', () => {
    expect(isCommandSafe('git diff')).toBe(true)
  })

  it('isCommandSafe("git log --oneline -5") returns true', () => {
    expect(isCommandSafe('git log --oneline -5')).toBe(true)
  })

  it('isCommandSafe("node scripts/release-governor.cjs") returns true', () => {
    expect(isCommandSafe('node scripts/release-governor.cjs')).toBe(true)
  })
})

describe('command safety filter — checkCommand', () => {
  it('checkCommand returns ALLOWED verdict and no blocked_rules for safe command', () => {
    const result = checkCommand('pnpm test')

    expect(result.allowed).toBe(true)
    expect(result.verdict).toBe('ALLOWED')
    expect(result.blocked_rules).toEqual([])
    expect(result.safe_alternative).toBeNull()
  })

  it('checkCommand returns BLOCKED verdict for git add .', () => {
    const result = checkCommand('git add .')

    expect(result.allowed).toBe(false)
    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules.length).toBeGreaterThan(0)
    expect(result.blocked_rules).toContain('git-add-dot')
  })

  it('checkCommand includes safe_alternative for git add .', () => {
    const result = checkCommand('git add .')

    expect(result.safe_alternative).not.toBeNull()
    expect(typeof result.safe_alternative).toBe('string')
  })

  it('checkCommand returns BLOCKED for git reset --hard', () => {
    const result = checkCommand('git reset --hard')

    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules).toContain('git-reset-hard')
  })

  it('checkCommand returns BLOCKED for git push --force', () => {
    const result = checkCommand('git push --force')

    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules).toContain('git-push-force')
    expect(result.safe_alternative).toBeTruthy()
  })

  it('checkCommand returns BLOCKED for DROP TABLE', () => {
    const result = checkCommand('DROP TABLE sessions')

    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules).toContain('drop-table')
  })

  it('checkCommand returns BLOCKED for test.skip pattern', () => {
    const result = checkCommand('it.skip("broken test", () => {})')

    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules).toContain('test-skip-todo')
  })

  it('checkCommand returns BLOCKED for test.only pattern', () => {
    const result = checkCommand('test.only("my test", () => {})')

    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules).toContain('test-skip-only')
  })

  it('checkCommand returns BLOCKED for --no-verify in any git command', () => {
    const result = checkCommand('git merge --no-verify feature-branch')

    expect(result.verdict).toBe('BLOCKED')
    expect(result.blocked_rules).toContain('no-verify-flag')
  })

  it('checkCommand handles empty string gracefully', () => {
    const result = checkCommand('')

    expect(result.allowed).toBe(true)
    expect(result.verdict).toBe('ALLOWED')
  })

  it('checkCommand handles null/undefined gracefully', () => {
    const result = checkCommand(null as any)

    expect(result.allowed).toBe(true)
    expect(result.verdict).toBe('ALLOWED')
  })
})

describe('command safety filter — filterCommands', () => {
  it('filterCommands(["git add .", "pnpm test"]) returns safe:false and one blocked', () => {
    const result = filterCommands(['git add .', 'pnpm test'])

    expect(result.safe).toBe(false)
    const blocked = result.results.filter((r: any) => !r.allowed)
    const allowed = result.results.filter((r: any) => r.allowed)
    expect(blocked.length).toBe(1)
    expect(allowed.length).toBe(1)
    expect(blocked[0].command).toBe('git add .')
  })

  it('filterCommands with all safe commands returns safe:true', () => {
    const result = filterCommands([
      'git status',
      'pnpm test',
      'node scripts/release-governor.cjs',
      'git diff --stat',
    ])

    expect(result.safe).toBe(true)
    expect(result.results.every((r: any) => r.allowed)).toBe(true)
  })

  it('filterCommands with all blocked commands returns safe:false', () => {
    const result = filterCommands([
      'git add .',
      'git push --force',
      'git reset --hard',
    ])

    expect(result.safe).toBe(false)
    expect(result.results.every((r: any) => !r.allowed)).toBe(true)
  })

  it('filterCommands preserves the command string in each result', () => {
    const cmds = ['git status', 'git add .']
    const result = filterCommands(cmds)

    expect(result.results[0].command).toBe('git status')
    expect(result.results[1].command).toBe('git add .')
  })

  it('filterCommands returns per-command verdict and blocked_rules', () => {
    const result = filterCommands(['git push --force'])

    expect(result.results[0].verdict).toBe('BLOCKED')
    expect(Array.isArray(result.results[0].blocked_rules)).toBe(true)
    expect(result.results[0].blocked_rules.length).toBeGreaterThan(0)
  })

  it('filterCommands handles empty array', () => {
    const result = filterCommands([])

    expect(result.safe).toBe(true)
    expect(result.results).toEqual([])
  })

  it('filterCommands handles non-array gracefully', () => {
    const result = filterCommands(null as any)

    expect(result.safe).toBe(true)
    expect(result.results).toEqual([])
  })
})

describe('command safety filter — runStatusMode', () => {
  it('status mode returns correct agent and label', () => {
    const result = runStatusMode()

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe(LABEL)
    expect(result.mode).toBe('status')
    expect(result.status).toBe('PASS')
  })

  it('status mode returns filter_rules_count', () => {
    const result = runStatusMode()

    expect(typeof result.filter_rules_count).toBe('number')
    expect(result.filter_rules_count).toBeGreaterThan(0)
    expect(result.filter_rules_count).toBe(SAFETY_RULES.length)
  })

  it('status mode returns rule_ids array', () => {
    const result = runStatusMode()

    expect(Array.isArray(result.rule_ids)).toBe(true)
    expect(result.rule_ids.length).toBeGreaterThan(0)
    expect(result.rule_ids).toContain('git-add-dot')
    expect(result.rule_ids).toContain('git-push-force')
  })
})

describe('command safety filter — runCheckMode', () => {
  it('check mode returns FAIL when command argument is missing', () => {
    const result = runCheckMode('')

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('check mode returns BLOCKED for git add .', () => {
    const result = runCheckMode('git add .')

    expect(result.agent).toBe(AGENT)
    expect(result.mode).toBe('check')
    expect(result.verdict).toBe('BLOCKED')
    expect(result.allowed).toBe(false)
    expect(result.status).toBe('FAIL')
  })

  it('check mode returns ALLOWED for safe command', () => {
    const result = runCheckMode('pnpm test')

    expect(result.verdict).toBe('ALLOWED')
    expect(result.allowed).toBe(true)
    expect(result.status).toBe('PASS')
  })

  it('check mode includes rule_details for blocked commands', () => {
    const result = runCheckMode('git push --force')

    expect(Array.isArray(result.rule_details)).toBe(true)
    expect(result.rule_details.length).toBeGreaterThan(0)
    expect(result.rule_details[0]).toHaveProperty('id')
    expect(result.rule_details[0]).toHaveProperty('reason')
  })
})

describe('command safety filter — runFilterMode', () => {
  it('filter mode returns FAIL when commands argument is missing', () => {
    const result = runFilterMode('')

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('filter mode returns FAIL for invalid JSON', () => {
    const result = runFilterMode('not-json')

    expect(result.status).toBe('FAIL')
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('filter mode returns safe:false when any command is blocked', () => {
    const result = runFilterMode(JSON.stringify(['git add .', 'pnpm test']))

    expect(result.safe).toBe(false)
    expect(result.blocked_count).toBe(1)
    expect(result.allowed_count).toBe(1)
  })

  it('filter mode returns safe:true when all commands are allowed', () => {
    const result = runFilterMode(JSON.stringify(['git status', 'pnpm typecheck', 'pnpm build']))

    expect(result.safe).toBe(true)
    expect(result.blocked_count).toBe(0)
  })
})

describe('command safety filter — SAFETY_RULES integrity', () => {
  it('every rule has id, reason, test function, and safe_alternative', () => {
    for (const rule of SAFETY_RULES) {
      expect(typeof rule.id).toBe('string')
      expect(rule.id.length).toBeGreaterThan(0)
      expect(typeof rule.reason).toBe('string')
      expect(rule.reason.length).toBeGreaterThan(0)
      expect(typeof rule.test).toBe('function')
      expect(rule.safe_alternative === null || typeof rule.safe_alternative === 'string').toBe(true)
    }
  })

  it('rules cover all required patterns', () => {
    const ids = SAFETY_RULES.map((r: any) => r.id)
    expect(ids).toContain('git-add-dot')
    expect(ids).toContain('git-push-force')
    expect(ids).toContain('git-commit-no-verify')
    expect(ids).toContain('git-reset-hard')
    expect(ids).toContain('git-rebase-interactive')
    expect(ids).toContain('git-filter-branch')
    expect(ids).toContain('rm-rf-slash')
    expect(ids).toContain('no-verify-flag')
    expect(ids).toContain('drop-table')
    expect(ids).toContain('drop-database')
  })
})

describe('command safety filter — CLI', () => {
  it('CLI status returns valid JSON', () => {
    const execution = spawnSync(process.execPath, ['scripts/command-safety-filter.cjs', 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
    })

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.agent).toBe(AGENT)
    expect(parsed.mode).toBe('status')
    expect(typeof parsed.filter_rules_count).toBe('number')
  })

  it('CLI check mode returns BLOCKED for git add .', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/command-safety-filter.cjs', 'check', '--command', 'git add .'],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.verdict).toBe('BLOCKED')
    expect(parsed.allowed).toBe(false)
  })

  it('CLI check mode returns ALLOWED for safe command', () => {
    const execution = spawnSync(
      process.execPath,
      ['scripts/command-safety-filter.cjs', 'check', '--command', 'pnpm test'],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.verdict).toBe('ALLOWED')
    expect(parsed.allowed).toBe(true)
  })

  it('CLI filter mode returns safe:false for mixed commands', () => {
    const commands = JSON.stringify(['git add .', 'pnpm test'])
    const execution = spawnSync(
      process.execPath,
      ['scripts/command-safety-filter.cjs', 'filter', '--commands', commands],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.safe).toBe(false)
    expect(parsed.blocked_count).toBe(1)
  })

  it('CLI filter mode returns safe:true for all safe commands', () => {
    const commands = JSON.stringify(['git status', 'pnpm typecheck'])
    const execution = spawnSync(
      process.execPath,
      ['scripts/command-safety-filter.cjs', 'filter', '--commands', commands],
      { cwd: ROOT, encoding: 'utf8' },
    )

    expect(execution.status).toBe(0)
    const parsed = JSON.parse(execution.stdout.split('\n\n')[0])
    expect(parsed.safe).toBe(true)
  })

  it('CLI main function dispatches modes correctly', () => {
    const checkResult = main(['check', '--command', 'git add .'])
    expect(checkResult.mode).toBe('check')
    expect(checkResult.verdict).toBe('BLOCKED')

    const statusResult = main(['status'])
    expect(statusResult.mode).toBe('status')
    expect(statusResult.agent).toBe(AGENT)

    const filterResult = main(['filter', '--commands', '["git status"]'])
    expect(filterResult.mode).toBe('filter')
    expect(filterResult.safe).toBe(true)
  })
})
