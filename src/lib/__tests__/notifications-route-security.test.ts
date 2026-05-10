import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  mutationLimiterMock,
  prepareMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  mutationLimiterMock: vi.fn(),
  prepareMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/rate-limit', () => ({
  mutationLimiter: mutationLimiterMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
}))

function jsonRequest(url: string, method: 'GET' | 'PUT' | 'DELETE' | 'POST', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  })
}

describe('notifications route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'operator', role: 'operator', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
    mutationLimiterMock.mockReturnValue(null)
  })

  it('denies unauthenticated GET access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/notifications/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications?recipient=neo', 'GET'),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/notifications/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications?recipient=neo', 'GET'),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('returns workspace-scoped notifications for authorized GET access', async () => {
    const notificationsAllMock = vi.fn(() => [])
    const unreadGetMock = vi.fn(() => ({ count: 0 }))
    const countGetMock = vi.fn(() => ({ total: 0 }))

    prepareMock
      .mockReturnValueOnce({ all: notificationsAllMock })
      .mockReturnValueOnce({ get: vi.fn() })
      .mockReturnValueOnce({ get: vi.fn() })
      .mockReturnValueOnce({ get: vi.fn() })
      .mockReturnValueOnce({ get: unreadGetMock })
      .mockReturnValueOnce({ get: countGetMock })

    const { GET } = await import('@/app/api/notifications/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications?recipient=neo&unread_only=true&type=assignment&limit=25&offset=0', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      notifications: [],
      total: 0,
      page: 1,
      limit: 25,
      unreadCount: 0,
    })
    expect(notificationsAllMock).toHaveBeenCalledWith('neo', 7, 'assignment', 25, 0)
    expect(unreadGetMock).toHaveBeenCalledWith('neo', 7)
    expect(countGetMock).toHaveBeenCalledWith('neo', 7, 'assignment')
  })

  it('does not leak cross-workspace notifications in GET listings', async () => {
    const notificationsAllMock = vi.fn(() => [])
    const unreadGetMock = vi.fn(() => ({ count: 0 }))
    const countGetMock = vi.fn(() => ({ total: 0 }))

    prepareMock
      .mockReturnValueOnce({ all: notificationsAllMock })
      .mockReturnValueOnce({ get: vi.fn() })
      .mockReturnValueOnce({ get: vi.fn() })
      .mockReturnValueOnce({ get: vi.fn() })
      .mockReturnValueOnce({ get: unreadGetMock })
      .mockReturnValueOnce({ get: countGetMock })

    const { GET } = await import('@/app/api/notifications/route')
    const response = await GET(
      jsonRequest('http://localhost/api/notifications?recipient=other-agent', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      notifications: [],
      total: 0,
      page: 1,
      limit: 50,
      unreadCount: 0,
    })
    expect(notificationsAllMock).toHaveBeenCalledWith('other-agent', 7, 50, 0)
  })

  it('marks notifications as read for workspace-scoped PUT access', async () => {
    const runMock = vi.fn(() => ({ changes: 2 }))
    prepareMock.mockReturnValueOnce({ run: runMock })

    const { PUT } = await import('@/app/api/notifications/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/notifications', 'PUT', { ids: [10, 11] }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      markedAsRead: 2,
    })
    expect(runMock).toHaveBeenCalledWith(expect.any(Number), 10, 11, 7)
  })

  it('does not mark cross-workspace notifications as read in PUT', async () => {
    const runMock = vi.fn(() => ({ changes: 0 }))
    prepareMock.mockReturnValueOnce({ run: runMock })

    const { PUT } = await import('@/app/api/notifications/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/notifications', 'PUT', { ids: [999] }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      markedAsRead: 0,
    })
    expect(runMock).toHaveBeenCalledWith(expect.any(Number), 999, 7)
  })

  it('deletes notifications for workspace-scoped DELETE access', async () => {
    requireRoleMock.mockReturnValueOnce({
      user: { username: 'admin', role: 'admin', workspace_id: 7 },
    })
    const runMock = vi.fn(() => ({ changes: 1 }))
    prepareMock.mockReturnValueOnce({ run: runMock })

    const { DELETE } = await import('@/app/api/notifications/route')
    const response = await DELETE(
      jsonRequest('http://localhost/api/notifications', 'DELETE', { ids: [22] }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      deleted: 1,
    })
    expect(runMock).toHaveBeenCalledWith(22, 7)
  })

  it('marks agent notifications delivered for workspace-scoped POST access', async () => {
    const runMock = vi.fn(() => ({ changes: 1 }))
    const allMock = vi.fn(() => [{
      id: 5,
      recipient: 'neo',
      delivered_at: 123,
      workspace_id: 7,
    }])

    prepareMock
      .mockReturnValueOnce({ run: runMock })
      .mockReturnValueOnce({ all: allMock })

    const { POST } = await import('@/app/api/notifications/route')
    const response = await POST(
      jsonRequest('http://localhost/api/notifications', 'POST', {
        action: 'mark-delivered',
        agent: 'neo',
      }),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      success: true,
      delivered: 1,
      notifications: [{
        id: 5,
        recipient: 'neo',
        delivered_at: 123,
        workspace_id: 7,
      }],
    })
    expect(runMock).toHaveBeenCalledWith(expect.any(Number), 'neo', 7)
    expect(allMock).toHaveBeenCalledWith('neo', expect.any(Number), 7)
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/notifications/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
