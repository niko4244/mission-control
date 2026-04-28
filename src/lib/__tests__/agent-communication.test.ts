import { describe, expect, it } from 'vitest'
import {
  canAgentsCommunicate,
  enrichConfigWithCommunication,
  getAgentCommunicationConfig,
  isAgentToAgentRequest,
} from '@/lib/agent-communication'

describe('agent communication helpers', () => {
  it('derives direct messaging support from tools and subagent allow list', () => {
    const config = getAgentCommunicationConfig({
      tools: { allow: ['agents_list', 'sessions_send'], deny: [] },
      subagents: { allowAgents: ['researcher'] },
    })

    expect(config.canInitiateDirect).toBe(true)
    expect(config.canReceiveDirect).toBe(true)
    expect(config.allowedAgents).toContain('researcher')
  })

  it('allows direct communication when either side permits the pair', () => {
    const result = canAgentsCommunicate(
      {
        name: 'builder',
        role: 'builder engineer',
        config: {
          communication: {
            mode: 'direct',
            canInitiateDirect: true,
            canReceiveDirect: true,
            allowedRoles: ['research'],
          },
        },
      },
      {
        name: 'researcher',
        role: 'research analyst',
        config: {
          communication: {
            mode: 'direct',
            canInitiateDirect: true,
            canReceiveDirect: true,
          },
        },
      },
    )

    expect(result).toEqual({ allowed: true })
  })

  it('blocks direct communication when sender cannot initiate', () => {
    const result = canAgentsCommunicate(
      {
        name: 'isolated',
        role: 'tester',
        config: {
          communication: {
            mode: 'isolated',
            canInitiateDirect: false,
            canReceiveDirect: true,
          },
        },
      },
      {
        name: 'researcher',
        role: 'research analyst',
        config: {
          communication: {
            mode: 'direct',
            canInitiateDirect: true,
            canReceiveDirect: true,
            allowedRoles: ['developer'],
          },
        },
      },
    )

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('sender_direct_messaging_disabled')
  })

  it('tags explicit a2a requests only when both agents exist', () => {
    expect(isAgentToAgentRequest({
      requestedFrom: 'builder',
      conversationId: 'a2a:builder:researcher',
      metadata: { channel: 'agent-to-agent' },
      senderExists: true,
      recipientExists: true,
    })).toBe(true)

    expect(isAgentToAgentRequest({
      requestedFrom: 'builder',
      conversationId: 'a2a:builder:researcher',
      metadata: { channel: 'agent-to-agent' },
      senderExists: false,
      recipientExists: true,
    })).toBe(false)
  })

  it('enriches config with normalized communication data', () => {
    const enriched = enrichConfigWithCommunication(
      {
        tools: { allow: ['sessions_send'], deny: [] },
      },
      { allowedRoles: ['research'] },
    )

    expect(enriched.communication).toMatchObject({
      canInitiateDirect: true,
      allowedRoles: ['research'],
    })
  })
})
