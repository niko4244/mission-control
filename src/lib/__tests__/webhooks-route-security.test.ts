import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { requireRoleMock, mutationLimiterMock, prepareMock, requireWorkspaceIdMock, deliverWebhookPublicMock } =
  vi.hoisted(() => ({
    requireRoleMock: vi.fn(),
    mutationLimiterMock: vi.fn(() => null),
    prepareMock: vi.fn(),
    requireWorkspaceIdMock: vi.fn(),
    deliverWebhookPublicMock: vi.fn(),
  }))

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mutationLimiterMock }))
vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))
vi.mock('@/lib/validation', () => ({
  validateBody: vi.fn(),
  createWebhookSchema: {},
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/webhooks', () => ({
  deliverWebhookPublic: deliverWebhookPublicMock,
}))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
}))

describe('webhooks route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mutationLimiterMock.mockReturnValue(null)
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
    requireRoleMock.mockReturnValue({
      user: { username: 'admin', role: 'admin', workspace_id: 7 },
    })
  })

  it('PUT fails closed when workspace_id is missing', async () => {
    requireRoleMock.mockReturnValue({
      user: { username: 'admin', role: 'admin' },
    })
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { PUT } = await import('@/app/api/webhooks/route')
    const response = await PUT(
      new NextRequest('http://localhost/api/webhooks', {
        method: 'PUT',
        body: JSON.stringify({ id: 22 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('DELETE fails closed when workspace_id is missing', async () => {
    requireRoleMock.mockReturnValue({
      user: { username: 'admin', role: 'admin' },
    })
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { DELETE } = await import('@/app/api/webhooks/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/webhooks', {
        method: 'DELETE',
        body: JSON.stringify({ id: 22 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('PUT scopes webhook lookup to the caller workspace', async () => {
    const getMock = vi.fn(() => undefined)
    prepareMock.mockReturnValue({ get: getMock })

    const { PUT } = await import('@/app/api/webhooks/route')
    const response = await PUT(
      new NextRequest('http://localhost/api/webhooks', {
        method: 'PUT',
        body: JSON.stringify({ id: 22 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Webhook not found' })
    expect(getMock).toHaveBeenCalledWith(22, 7)
  })

  it('retry denies unauthenticated requests', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { POST } = await import('@/app/api/webhooks/retry/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/retry', {
        method: 'POST',
        body: JSON.stringify({ delivery_id: 22 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' })
  })

  it('retry fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { POST } = await import('@/app/api/webhooks/retry/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/retry', {
        method: 'POST',
        body: JSON.stringify({ delivery_id: 22 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('retry scopes delivery lookup to the caller workspace and succeeds for valid admin access', async () => {
    const getMock = vi.fn(() => ({
      id: 22,
      webhook_id: 11,
      workspace_id: 7,
      payload: JSON.stringify({ data: { ok: true } }),
      event_type: 'task.created',
      attempt: 1,
      w_id: 11,
      w_name: 'Ops webhook',
      w_url: 'https://example.com/webhook',
      w_secret: 'secret',
      w_events: '["task.created"]',
      w_enabled: 1,
      w_workspace_id: 7,
    }))
    prepareMock.mockReturnValueOnce({ get: getMock })
    deliverWebhookPublicMock.mockResolvedValueOnce({ success: true, status: 200 })

    const { POST } = await import('@/app/api/webhooks/retry/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/retry', {
        method: 'POST',
        body: JSON.stringify({ delivery_id: 22 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, status: 200 })
    expect(getMock).toHaveBeenCalledWith(22, 7)
    expect(deliverWebhookPublicMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, workspace_id: 7 }),
      'task.created',
      { ok: true },
      expect.objectContaining({ allowRetry: false, parentDeliveryId: 22 }),
    )
  })

  it('retry denies cross-workspace access by returning not found', async () => {
    const getMock = vi.fn(() => undefined)
    prepareMock.mockReturnValueOnce({ get: getMock })

    const { POST } = await import('@/app/api/webhooks/retry/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/retry', {
        method: 'POST',
        body: JSON.stringify({ delivery_id: 99 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Delivery not found' })
    expect(getMock).toHaveBeenCalledWith(99, 7)
  })

  it('test route denies unauthenticated requests', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { POST } = await import('@/app/api/webhooks/test/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/test', {
        method: 'POST',
        body: JSON.stringify({ id: 11 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' })
  })

  it('test route fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { POST } = await import('@/app/api/webhooks/test/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/test', {
        method: 'POST',
        body: JSON.stringify({ id: 11 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('test route scopes webhook lookup to the caller workspace and avoids real network delivery', async () => {
    const getMock = vi.fn(() => ({
      id: 11,
      name: 'Ops webhook',
      url: 'https://example.com/webhook',
      secret: 'secret',
      workspace_id: 7,
    }))
    prepareMock.mockReturnValueOnce({ get: getMock })
    deliverWebhookPublicMock.mockResolvedValueOnce({ success: true, status: 200 })

    const { POST } = await import('@/app/api/webhooks/test/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/test', {
        method: 'POST',
        body: JSON.stringify({ id: 11 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, status: 200 })
    expect(getMock).toHaveBeenCalledWith(11, 7)
    expect(deliverWebhookPublicMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, workspace_id: 7 }),
      'test.ping',
      expect.objectContaining({
        webhook_id: 11,
        webhook_name: 'Ops webhook',
        triggered_by: 'admin',
      }),
      { allowRetry: false },
    )
  })

  it('test route denies cross-workspace access by returning not found', async () => {
    const getMock = vi.fn(() => undefined)
    prepareMock.mockReturnValueOnce({ get: getMock })

    const { POST } = await import('@/app/api/webhooks/test/route')
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/test', {
        method: 'POST',
        body: JSON.stringify({ id: 11 }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Webhook not found' })
    expect(getMock).toHaveBeenCalledWith(11, 7)
  })

  it('deliveries route denies unauthenticated requests', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/webhooks/deliveries/route')
    const response = await GET(new NextRequest('http://localhost/api/webhooks/deliveries'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' })
  })

  it('deliveries route fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/webhooks/deliveries/route')
    const response = await GET(new NextRequest('http://localhost/api/webhooks/deliveries'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('deliveries route scopes listing to the caller workspace', async () => {
    const allMock = vi.fn(() => [{ id: 1, webhook_id: 11, workspace_id: 7 }])
    const getMock = vi.fn(() => ({ count: 1 }))
    prepareMock
      .mockReturnValueOnce({ all: allMock })
      .mockReturnValueOnce({ get: getMock })

    const { GET } = await import('@/app/api/webhooks/deliveries/route')
    const response = await GET(
      new NextRequest('http://localhost/api/webhooks/deliveries?webhook_id=11&limit=25&offset=0'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      deliveries: [{ id: 1, webhook_id: 11, workspace_id: 7 }],
      total: 1,
    })
    expect(allMock).toHaveBeenCalledWith(7, '11', 25, 0)
    expect(getMock).toHaveBeenCalledWith(7, '11')
  })

  it('deliveries route does not leak other workspace data', async () => {
    const allMock = vi.fn(() => [])
    const getMock = vi.fn(() => ({ count: 0 }))
    prepareMock
      .mockReturnValueOnce({ all: allMock })
      .mockReturnValueOnce({ get: getMock })

    const { GET } = await import('@/app/api/webhooks/deliveries/route')
    const response = await GET(
      new NextRequest('http://localhost/api/webhooks/deliveries?webhook_id=999'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ deliveries: [], total: 0 })
    expect(allMock).toHaveBeenCalledWith(7, '999', 50, 0)
    expect(getMock).toHaveBeenCalledWith(7, '999')
  })

  it('touched webhook auxiliary routes no longer contain workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const paths = [
      'src/app/api/webhooks/retry/route.ts',
      'src/app/api/webhooks/test/route.ts',
      'src/app/api/webhooks/deliveries/route.ts',
    ]

    for (const path of paths) {
      const source = await fs.readFile(path, 'utf8')
      expect(source).not.toContain('workspace_id ?? 1')
      expect(source).not.toContain('workspaceId ?? 1')
    }
  })
})
