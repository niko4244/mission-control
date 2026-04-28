import { test, expect } from '@playwright/test'
import { API_KEY_HEADER, createTestAgent, deleteTestAgent } from './helpers'

test.describe('Agent Comms Feed', () => {
  const agentCleanup: number[] = []

  test.afterEach(async ({ request }) => {
    while (agentCleanup.length > 0) {
      await deleteTestAgent(request, agentCleanup.pop()!)
    }
  })

  test('includes coordinator session traffic and tool-call events', async ({ request }) => {
    const stamp = Date.now()
    const from = `e2e-operator-${stamp}`
    const coordinator = 'coordinator'
    const conv = `coord:${from}:${coordinator}`
    const since = Math.floor(stamp / 1000) - 2

    const first = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from,
        to: coordinator,
        content: 'Kick off orchestration for this task.',
        message_type: 'text',
        conversation_id: conv,
        metadata: { channel: 'coordinator-inbox' },
      },
    })
    expect(first.status()).toBe(201)

    const second = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from: coordinator,
        to: from,
        content: 'Received. Coordinating now.',
        message_type: 'status',
        conversation_id: conv,
        metadata: { status: 'accepted' },
      },
    })
    expect(second.status()).toBe(201)

    const third = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from: coordinator,
        to: from,
        content: 'search_web',
        message_type: 'tool_call',
        conversation_id: conv,
        metadata: {
          event: 'tool_call',
          toolName: 'search_web',
          input: '{"query":"mission control agent comms"}',
          output: '{"results":3}',
          status: 'ok',
        },
      },
    })
    expect(third.status()).toBe(201)

    const res = await request.get(`/api/agents/comms?agent=${encodeURIComponent(coordinator)}&since=${since}&limit=200`, {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    const threadRows = (body.messages || []).filter((m: any) => m.conversation_id === conv)
    expect(threadRows.length).toBeGreaterThanOrEqual(3)

    const toolEvent = threadRows.find((m: any) => m.message_type === 'tool_call')
    expect(toolEvent).toBeTruthy()
    expect(toolEvent.metadata).toBeTruthy()
    expect(toolEvent.metadata.toolName).toBe('search_web')
    expect(toolEvent.metadata.input).toContain('agent comms')
  })

  test('includes session-thread traffic for gateway/local mode compatibility', async ({ request }) => {
    const stamp = Date.now()
    const conv = `session:gateway:e2e-${stamp}`
    const since = Math.floor(Date.now() / 1000) - 60

    const sent = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from: 'coordinator',
        to: 'builder',
        content: 'Session-scoped runtime message',
        message_type: 'text',
        conversation_id: conv,
      },
    })
    expect(sent.status()).toBe(201)
    const sentBody = await sent.json()
    expect(sentBody?.message?.conversation_id).toBe(conv)

    const rawRes = await request.get(`/api/chat/messages?conversation_id=${encodeURIComponent(conv)}&limit=20`, {
      headers: API_KEY_HEADER,
    })
    expect(rawRes.status()).toBe(200)
    const rawBody = await rawRes.json()
    expect((rawBody.messages || []).length).toBeGreaterThanOrEqual(1)

    const res = await request.get(`/api/agents/comms?since=${since}&limit=200`, {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    const threadRows = (body.messages || []).filter((m: any) => m.conversation_id === conv)
    expect(threadRows.length).toBeGreaterThanOrEqual(1)
    expect(threadRows[0].content).toContain('Session-scoped')
  })

  test('accepts explicit agent-to-agent messages for allowed peers', async ({ request }) => {
    const sender = await createTestAgent(request, {
      role: 'builder engineer',
      config: {
        communication: {
          mode: 'direct',
          canInitiateDirect: true,
          canReceiveDirect: true,
          allowedRoles: ['research', 'analyst'],
        },
      },
    })
    const recipient = await createTestAgent(request, {
      role: 'research analyst',
      config: {
        communication: {
          mode: 'direct',
          canInitiateDirect: true,
          canReceiveDirect: true,
          allowedRoles: ['developer', 'builder'],
        },
      },
    })
    agentCleanup.push(sender.id, recipient.id)

    const conversationId = `a2a:${sender.name}:${recipient.name}:${Date.now()}`
    const res = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from: sender.name,
        to: recipient.name,
        content: 'Need a research pass on this implementation.',
        conversation_id: conversationId,
        metadata: { channel: 'agent-to-agent' },
      },
    })

    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.message.from_agent).toBe(sender.name)
    expect(body.message.to_agent).toBe(recipient.name)
    expect(body.message.conversation_id).toBe(conversationId)
    expect(body.message.metadata.channel).toBe('agent-to-agent')
  })

  test('blocks explicit agent-to-agent messages for disallowed pairs', async ({ request }) => {
    const sender = await createTestAgent(request, {
      role: 'tester',
      config: {
        communication: {
          mode: 'isolated',
          canInitiateDirect: false,
          canReceiveDirect: true,
        },
      },
    })
    const recipient = await createTestAgent(request, {
      role: 'research analyst',
      config: {
        communication: {
          mode: 'direct',
          canInitiateDirect: true,
          canReceiveDirect: true,
          allowedRoles: ['developer', 'builder'],
        },
      },
    })
    agentCleanup.push(sender.id, recipient.id)

    const res = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from: sender.name,
        to: recipient.name,
        content: 'Trying to route without permission.',
        conversation_id: `a2a:${sender.name}:${recipient.name}:${Date.now()}`,
        metadata: { channel: 'agent-to-agent' },
      },
    })

    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('blocked')
  })
})
