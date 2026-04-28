import { describe, it, expect } from 'vitest'
import { inferTaskWorkloadProfile, resolveTaskImplementationTarget } from '@/lib/task-routing'

describe('resolveTaskImplementationTarget', () => {
  it('returns explicit implementation target metadata when present', () => {
    const result = resolveTaskImplementationTarget({
      metadata: {
        implementation_repo: 'builderz-labs/mission-control',
        code_location: '/apps/api',
      },
    })

    expect(result).toEqual({
      implementation_repo: 'builderz-labs/mission-control',
      code_location: '/apps/api',
    })
  })

  it('supports legacy metadata keys for backward compatibility', () => {
    const result = resolveTaskImplementationTarget({
      metadata: {
        github_repo: 'builderz-labs/mission-control',
        path: '/packages/core',
      },
    })

    expect(result).toEqual({
      implementation_repo: 'builderz-labs/mission-control',
      code_location: '/packages/core',
    })
  })

  it('prefers explicit implementation target metadata over legacy fallback keys', () => {
    const result = resolveTaskImplementationTarget({
      metadata: {
        implementation_repo: 'builderz-labs/mission-control',
        github_repo: 'legacy/repo',
        code_location: '/apps/api',
        path: '/legacy/path',
      },
    })

    expect(result).toEqual({
      implementation_repo: 'builderz-labs/mission-control',
      code_location: '/apps/api',
    })
  })

  it('returns empty object for missing metadata', () => {
    expect(resolveTaskImplementationTarget({ metadata: null })).toEqual({})
  })

  it('infers coding tasks that need code tools', () => {
    const profile = inferTaskWorkloadProfile({
      title: 'Debug duplicate background job processing',
      description: 'Inspect the repo and propose a debugging plan for a background worker bug',
    })

    expect(profile.primaryLane).toBe('coding')
    expect(profile.needsCodeTools).toBe(true)
    expect(profile.recommendedAgentRoles).toContain('developer')
  })

  it('infers mixed routing tasks and prioritizes orchestration', () => {
    const profile = inferTaskWorkloadProfile({
      title: 'Route a mixed task with fresh news, code changes, and an illustration',
      description: 'Decide what should be handled by search, code tools, and an image tool',
    })

    expect(profile.primaryLane).toBe('tool_routing')
    expect(profile.recommendedAgentRoles[0]).toBe('orchestrator')
    expect(profile.recommendedFunctions).toContain('tool_routing')
  })

  it('flags freshness-aware lookup tasks', () => {
    const profile = inferTaskWorkloadProfile({
      title: 'Is this newly announced model worth trying on a consumer PC?',
      description: 'Need a quick answer with caveats and current specs awareness',
    })

    expect(profile.primaryLane).toBe('lookup')
    expect(profile.needsFreshnessCheck).toBe(true)
    expect(profile.recommendedFunctions).toContain('search')
  })
})
