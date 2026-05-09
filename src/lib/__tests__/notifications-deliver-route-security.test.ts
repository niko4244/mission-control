import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  runOpenClawMock,
  prepareMock,
  logActivityMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  runOpenClawMock: vi.fn(),
  prepareMock: vi.fn(),
  logActivityMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/command', () => ({
  runOpenClaw: runOpenClawMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
  db_helpers: {
    logActivity: logActivityMock,
  },
}))

function jsonRequest(url: string, method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  })
}

describe('notifications deliver route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'operator', role: 'operator', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
  })

  it('denies unauthenticated POST access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { POST } = await import('@/app/api/notifications/deliver/route')
    const response = await POST(
      jsonRequest('http://localhost/api/notifications/deliver', 'POST', { dry_run: true }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for POST', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { POST } = await import('@/app/api/notifications/deliver/route')
    const response = await POST(
      jsonRequest('http://localhost/api/notifications/deliver', 'POST', { dry_run: true }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('allows valid workspace-scoped dry-run delivery without executing commands', async () => {
    const allMock = vi.fn(() => [{
      id: 9,
      recipient: 'neo',
      type: 'assignment',
      title: 'Assigned',
      message: 'Review this task',
      created_at: 100,
      workspace_id: 7,
      session_key: 'sess-1',
      delivered_at: null,
    }])
    prepareMock
      .mockReturnValueOnce({ all: allMock })

    const { POST } = await import('@/app/api/notifications/deliver/route')
    const response = await POST(
      jsonRequest('http://localhost/api/notifications/deliver', 'POST', {
        dry_run: true,
        limit: 10,
      }),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(expect.objectContaining({
      status: 'success',
      total_processed: 1,
      delivered: 1,
      errors: 0,
      dry_run: true,
    }))
    expect(allMock).toHaveBeenCalledWith(7, 10)
    expect(runOpenClawMock).not.toHaveBeenCalled()
  })

  it('does not leak cross-workspace notifications in POST delivery lookup', async () => {
    const allMock = vi.fn(() => [])
    prepareMock.mockReturnValueOnce({ all: allMock })

    const { POST } = await import('@/app/api/notifications/deliver/route')
    const response = await POST(
      jsonRequest('http://localhost/api/notifications/deliver', 'POST', {
        dry_run: true,
        agent_filter: 'other-agent',
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'success',
      message: 'No undelivered notifications found',
      processed: 0,
      delivered: 0,
      errors: [],
    })
    expect(allMock).toHaveBeenCalledWith(7, 'other-agent', 50)
  })

  it('denies unauthenticated GET access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/notifications/deliver/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications/deliver', 'GET'),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for GET', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/notifications/deliver/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications/deliver', 'GET'),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('returns workspace-scoped delivery statistics for authorized access', async () => {
    const totalGetMock = vi.fn(() => ({ count: 4 }))
    const undeliveredGetMock = vi.fn(() => ({ count: 1 }))
    const deliveredGetMock = vi.fn(() => ({ count: 3 }))
    const recentAllMock = vi.fn(() => [{ recipient: 'neo', type: 'assignment', title: 'Assigned', delivered_at: 10, created_at: 5 }])
    const pendingAllMock = vi.fn(() => [{ recipient: 'neo', session_key: 'sess-1', pending_count: 1 }])

    prepareMock
      .mockReturnValueOnce({ get: totalGetMock })
      .mockReturnValueOnce({ get: undeliveredGetMock })
      .mockReturnValueOnce({ get: deliveredGetMock })
      .mockReturnValueOnce({ all: recentAllMock })
      .mockReturnValueOnce({ all: pendingAllMock })

    const { GET } = await import('@/app/api/notifications/deliver/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications/deliver?agent=neo', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      statistics: {
        total: 4,
        delivered: 3,
        undelivered: 1,
        delivery_rate: 75,
      },
      agents_with_pending: [{ recipient: 'neo', session_key: 'sess-1', pending_count: 1 }],
      recent_deliveries: [{ recipient: 'neo', type: 'assignment', title: 'Assigned', delivered_at: 10, created_at: 5 }],
      agent_filter: 'neo',
    })
    expect(totalGetMock).toHaveBeenCalledWith(7, 'neo')
    expect(undeliveredGetMock).toHaveBeenCalledWith(7, 'neo')
    expect(deliveredGetMock).toHaveBeenCalledWith(7, 'neo')
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/notifications/deliver/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
