import { describe, expect, it } from 'vitest'
import {
  buildAgentDailyLogEntries,
  buildStableAgentThreadId,
  isLearningActivity,
} from '@/lib/agent-daily-log'

describe('agent daily log helpers', () => {
  it('builds a stable a2a thread id regardless of order', () => {
    expect(buildStableAgentThreadId('Research', 'Builder')).toBe('a2a:Builder:Research')
    expect(buildStableAgentThreadId('Builder', 'Research')).toBe('a2a:Builder:Research')
  })

  it('recognizes learning activity types', () => {
    expect(isLearningActivity('agent_memory_updated')).toBe(true)
    expect(isLearningActivity('memory_file_saved')).toBe(true)
    expect(isLearningActivity('task_updated')).toBe(false)
  })

  it('groups work and learning by day', () => {
    const entries = buildAgentDailyLogEntries(
      'forge',
      [
        {
          id: 1,
          type: 'task_dispatched',
          description: 'Dispatched routing task to builder',
          created_at: 1_745_490_000,
        },
        {
          id: 2,
          type: 'agent_memory_updated',
          description: 'Updated memory',
          created_at: 1_745_490_100,
          data: { summary: 'Learned the repo uses pnpm and OpenClaw sessions.' },
        },
      ],
      [
        {
          id: 10,
          conversation_id: 'a2a:builder:forge',
          from_agent: 'forge',
          to_agent: 'builder',
          content: 'Please implement the routing fix.',
          message_type: 'text',
          created_at: 1_745_490_200,
        },
        {
          id: 11,
          conversation_id: 'a2a:builder:forge',
          from_agent: 'builder',
          to_agent: 'forge',
          content: 'apply_patch',
          message_type: 'tool_call',
          created_at: 1_745_490_260,
        },
      ],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      activityCount: 2,
      communicationCount: 2,
      learningCount: 1,
      toolCallCount: 1,
      peers: ['builder'],
      actions: ['Dispatched routing task to builder'],
      learned: ['Learned the repo uses pnpm and OpenClaw sessions.'],
    })
  })
})
