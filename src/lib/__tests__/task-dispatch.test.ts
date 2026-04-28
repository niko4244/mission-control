import { describe, expect, it } from 'vitest'
import { resolveTaskDispatchModelOverride, scoreAgentForTask } from '@/lib/task-dispatch'

describe('resolveTaskDispatchModelOverride', () => {
  it('returns null when the agent has no explicit dispatch model override', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: null })).toBeNull()
    expect(resolveTaskDispatchModelOverride({ agent_config: '{"openclawId":"main"}' })).toBeNull()
  })

  it('returns the explicit dispatch model override when present', () => {
    expect(
      resolveTaskDispatchModelOverride({
        agent_config: '{"openclawId":"main","dispatchModel":"openai-codex/gpt-5.4"}',
      })
    ).toBe('openai-codex/gpt-5.4')
  })

  it('ignores malformed agent config payloads', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: '{not json' })).toBeNull()
  })

  it('scores coding specialists above researchers for coding tasks', () => {
    const taskText = 'Debug a Python API bug in the repo and add a short test plan'

    const developerScore = scoreAgentForTask(
      {
        name: 'builder',
        role: 'developer',
        status: 'idle',
        config: JSON.stringify({
          workloadLanes: ['coding'],
          capabilities: ['coding', 'debugging'],
          tools: { allow: ['read', 'write', 'exec'] },
        }),
      },
      taskText,
    )

    const researcherScore = scoreAgentForTask(
      {
        name: 'researcher',
        role: 'researcher',
        status: 'idle',
        config: JSON.stringify({
          workloadLanes: ['research'],
          capabilities: ['lookup', 'research'],
          tools: { allow: ['web', 'browser'] },
        }),
      },
      taskText,
    )

    expect(developerScore).toBeGreaterThan(researcherScore)
  })

  it('rewards orchestrators for mixed routing tasks', () => {
    const taskText = 'Route a mixed request involving fresh news, code changes, and an image prompt'

    const orchestratorScore = scoreAgentForTask(
      {
        name: 'orchestrator',
        role: 'orchestrator',
        status: 'idle',
        config: JSON.stringify({
          workloadLanes: ['tool_routing', 'lookup', 'coding', 'image_prompting'],
          abilities: ['tool_selection', 'freshness_awareness'],
          tools: { allow: ['web', 'browser', 'read', 'write', 'exec'] },
        }),
      },
      taskText,
    )

    const contentScore = scoreAgentForTask(
      {
        name: 'writer',
        role: 'content-creator',
        status: 'idle',
        config: JSON.stringify({
          workloadLanes: ['image_prompting'],
          capabilities: ['image_prompting'],
          tools: { allow: ['write', 'edit'] },
        }),
      },
      taskText,
    )

    expect(orchestratorScore).toBeGreaterThan(contentScore)
  })
})
