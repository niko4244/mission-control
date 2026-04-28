import { describe, expect, it } from 'vitest'
import { buildCompanionBrief, resolveCompanionTargetAgent } from '@/lib/ambient-companion'

describe('ambient companion helpers', () => {
  it('prefers an orchestrator-like agent as the default target', () => {
    expect(resolveCompanionTargetAgent([
      { id: 1, name: 'builder', role: 'builder engineer', status: 'idle', created_at: 0, updated_at: 0 },
      { id: 2, name: 'forge', role: 'operator strategist', status: 'busy', created_at: 0, updated_at: 0 },
    ])).toBe('forge')
  })

  it('falls back to coordinator when no orchestrator-like agent exists', () => {
    expect(resolveCompanionTargetAgent([
      { id: 1, name: 'builder', role: 'builder engineer', status: 'idle', created_at: 0, updated_at: 0 },
    ])).toBe('coordinator')
  })

  it('adapts the brief for the agents tab', () => {
    const brief = buildCompanionBrief({
      activeTab: 'agents',
      agents: [
        { id: 1, name: 'forge', role: 'operator strategist', status: 'busy', created_at: 0, updated_at: 0 },
        { id: 2, name: 'research', role: 'research analyst', status: 'offline', created_at: 0, updated_at: 0 },
      ],
      unreadNotifications: 0,
      unreadConversations: 0,
    })

    expect(brief.headline).toContain('team')
    expect(brief.targetAgent).toBe('forge')
    expect(brief.suggestions[0].label).toBe('Review load')
  })

  it('prioritizes notification triage when alerts are unread', () => {
    const brief = buildCompanionBrief({
      activeTab: 'overview',
      agents: [],
      unreadNotifications: 3,
      unreadConversations: 0,
    })

    expect(brief.headline).toContain('signals')
    expect(brief.suggestions[0].label).toBe('Triage alerts')
    expect(brief.status).toContain('3')
  })
})
