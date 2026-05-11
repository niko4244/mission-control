import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../')

const {
  AGENT,
  buildStatusMode,
  buildRoutingDecision,
  detectImplementedBots,
  getAuthorityView,
  loadPolicy,
  loadRegistry,
  validateAuthorityClaims,
  validateRequiredCoreBots,
} = require('../../../scripts/mission-control-bot-system.cjs')

describe('mission control bot system', () => {
  it('loads registry and policy', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)

    expect(Array.isArray(registry.bots)).toBe(true)
    expect(Array.isArray(policy.risk_classes)).toBe(true)
  })

  it('validates required core bots exist in registry', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)

    expect(validateRequiredCoreBots(registry, policy)).toEqual([])
  })

  it('validates chief-arbiter outranks governors', () => {
    const registry = loadRegistry(ROOT)
    const chief = registry.bots.find((bot: any) => bot.id === 'chief-arbiter')
    const governors = registry.bots.filter((bot: any) => bot.category === 'governor' || bot.category === 'domain-arbiter')

    expect(chief.authority_level).toBeLessThan(Math.min(...governors.map((bot: any) => bot.authority_level)))
  })

  it('validates governors outrank runners and executors', () => {
    const registry = loadRegistry(ROOT)
    const securityGovernor = registry.bots.find((bot: any) => bot.id === 'security-governor')
    const runner = registry.bots.find((bot: any) => bot.id === 'security-hardening-runner')
    const executor = registry.bots.find((bot: any) => bot.id === 'security-executor')

    expect(securityGovernor.authority_level).toBeLessThan(runner.authority_level)
    expect(securityGovernor.authority_level).toBeLessThan(executor.authority_level)
  })

  it('validates executors may not push or merge by default', () => {
    const registry = loadRegistry(ROOT)
    const executors = registry.bots.filter((bot: any) => bot.category === 'executor')

    expect(executors.every((bot: any) => bot.may_push === false && bot.may_merge === false)).toBe(true)
  })

  it('validates merge authority is human-only by default', () => {
    const registry = loadRegistry(ROOT)
    const mergingBots = registry.bots.filter((bot: any) => bot.may_merge === true)

    expect(mergingBots.map((bot: any) => bot.id)).toEqual(['human-owner'])
  })

  it('validates Critical risk requires Arbiter and human for push pr and merge', () => {
    const policy = loadPolicy(ROOT)
    const critical = policy.approval_matrix.Critical

    expect(critical.can_auto_plan).toContain('chief-arbiter')
    expect(critical.can_auto_push).toEqual([])
    expect(critical.can_auto_create_pr).toEqual([])
    expect(critical.can_auto_merge).toEqual([])
    expect(critical.human_required_for).toEqual(
      expect.arrayContaining(['push', 'create_pr', 'merge']),
    )
  })

  it('validates Tooling and TestOnly can be arbiter-authorized for stage and commit', () => {
    const policy = loadPolicy(ROOT)

    expect(policy.approval_matrix.Tooling.can_auto_stage).toContain('chief-arbiter')
    expect(policy.approval_matrix.Tooling.can_auto_commit).toContain('chief-arbiter')
    expect(policy.approval_matrix.TestOnly.can_auto_stage).toContain('chief-arbiter')
    expect(policy.approval_matrix.TestOnly.can_auto_commit).toContain('chief-arbiter')
  })

  it('detects implemented bot scripts that are missing from registry', () => {
    const registry = loadRegistry(ROOT)
    const registryWithoutReleaseManager = {
      ...registry,
      bots: registry.bots.filter((bot: any) => bot.id !== 'release-manager'),
    }

    const detected = detectImplementedBots(ROOT, registryWithoutReleaseManager, {
      observedScriptFiles: [
        'scripts/release-manager.cjs',
        'scripts/security-governor.cjs',
      ],
    })

    expect(detected.unregistered_implemented_scripts).toEqual([
      {
        inferred_bot_id: 'release-manager',
        script: 'scripts/release-manager.cjs',
      },
    ])
  })

  it('detects registry bots claiming authority disallowed by policy', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)
    const mutatedRegistry = {
      ...registry,
      bots: registry.bots.map((bot: any) => (
        bot.id === 'security-executor'
          ? { ...bot, may_push: true }
          : bot
      )),
    }

    const violations = validateAuthorityClaims(mutatedRegistry, policy)

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bot_id: 'security-executor',
        }),
      ]),
    )
  })

  it('routes security hardening task to security stack', () => {
    const policy = loadPolicy(ROOT)
    const route = buildRoutingDecision('harden workspace fallback in tokens route', policy)

    expect(route.domain).toBe('security/workspace')
    expect(route.risk).toBe('Critical')
    expect(route.governor).toBe('security-governor')
    expect(route.runner).toBe('security-hardening-runner')
    expect(route.executor).toBe('security-executor')
    expect(route.human_required_for).toEqual(expect.arrayContaining(['push', 'create_pr', 'merge']))
  })

  it('routes docs typo task to docs stack', () => {
    const policy = loadPolicy(ROOT)
    const route = buildRoutingDecision('fix typo in docs', policy)

    expect(route.domain).toBe('docs')
    expect(route.risk).toBe('Docs')
    expect(route.governor).toBe('documentation-governor')
    expect(route.executor).toBe('documentation-executor')
  })

  it('routes auth helper change to Critical and human-required flow', () => {
    const policy = loadPolicy(ROOT)
    const route = buildRoutingDecision('change auth helper', policy)

    expect(route.domain).toBe('security/auth')
    expect(route.risk).toBe('Critical')
    expect(route.human_required_for).toEqual(expect.arrayContaining(['stage', 'commit', 'push', 'create_pr', 'merge']))
    expect(route.blocked_actions).toEqual(expect.arrayContaining(['autonomous stage', 'autonomous commit']))
  })

  it('authority lookup for security-executor shows local mutation allowed but no push pr or merge', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)
    const authority = getAuthorityView('security-executor', registry, policy)

    expect(authority.may_do).toEqual(expect.arrayContaining(['mutate', 'stage', 'commit']))
    expect(authority.may_not_do).toEqual(expect.arrayContaining(['push', 'create pr', 'merge']))
  })

  it('authority lookup for chief-arbiter shows authorization and rejection power but no merge over human', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)
    const authority = getAuthorityView('chief-arbiter', registry, policy)

    expect(authority.may_do).toEqual(expect.arrayContaining(['authorize', 'reject', 'request corrections']))
    expect(authority.may_not_do).toEqual(expect.arrayContaining(['merge']))
    expect(authority.override_chain).toContain('human-owner')
  })

  it('authority lookup for release-governor shows observe-only release authorization without merge power', () => {
    const registry = loadRegistry(ROOT)
    const policy = loadPolicy(ROOT)
    const authority = getAuthorityView('release-governor', registry, policy)

    expect(authority.may_do).toEqual(expect.arrayContaining(['authorize', 'reject', 'request corrections']))
    expect(authority.may_not_do).toEqual(expect.arrayContaining(['mutate', 'push', 'merge']))
  })

  it('output shape includes required fields', () => {
    const result = buildStatusMode(ROOT)

    expect(result.agent).toBe(AGENT)
    expect(result.label).toBe('BOT OPERATING SYSTEM / OBSERVE ONLY')
    expect(result.mode).toBe('status')
    expect(typeof result.registry.loaded).toBe('boolean')
    expect(Array.isArray(result.registry.implemented)).toBe(true)
    expect(Array.isArray(result.policy.risk_classes)).toBe(true)
    expect(result.hierarchy.root).toBe('human-owner')
    expect(result.routing).toEqual(
      expect.objectContaining({
        task: expect.any(String),
        human_required_for: expect.any(Array),
      }),
    )
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(Array.isArray(result.blocking_conditions)).toBe(true)
    expect(typeof result.summary).toBe('string')
  })
})
