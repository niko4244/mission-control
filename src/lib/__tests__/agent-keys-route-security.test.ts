import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { requireRoleMock, requireWorkspaceIdMock, prepareMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  prepareMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
}))

function jsonRequest(url: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  })
}

describe('agent key route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'admin', role: 'admin', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
  })

  it('denies unauthenticated GET access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/agents/[id]/keys/route')
    const response = await GET(
      jsonRequest('http://localhost/api/agents/neo/keys', 'GET'),
      { params: Promise.resolve({ id: 'neo' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('denies non-admin GET access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Insufficient permissions', status: 403 })

    const { GET } = await import('@/app/api/agents/[id]/keys/route')
    const response = await GET(
      jsonRequest('http://localhost/api/agents/neo/keys', 'GET'),
      { params: Promise.resolve({ id: 'neo' }) },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Insufficient permissions' })
  })

  it('fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/agents/[id]/keys/route')
    const response = await GET(
      jsonRequest('http://localhost/api/agents/neo/keys', 'GET'),
      { params: Promise.resolve({ id: 'neo' }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('lists keys for a valid admin within the caller workspace', async () => {
    const agentGetMock = vi.fn(() => ({ id: 5, name: 'neo', workspace_id: 7 }))
    const keysAllMock = vi.fn(() => [{
      id: 12,
      name: 'ops',
      key_prefix: 'mca_12345678',
      scopes: '["viewer","agent:self"]',
      created_by: 'admin',
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      created_at: 111,
      updated_at: 111,
    }])
    prepareMock
      .mockReturnValueOnce({ get: agentGetMock })
      .mockReturnValueOnce({ all: keysAllMock })

    const { GET } = await import('@/app/api/agents/[id]/keys/route')
    const response = await GET(
      jsonRequest('http://localhost/api/agents/neo/keys', 'GET'),
      { params: Promise.resolve({ id: 'neo' }) },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      agent: { id: 5, name: 'neo' },
      keys: [{
        id: 12,
        name: 'ops',
        key_prefix: 'mca_12345678',
        scopes: ['viewer', 'agent:self'],
        created_by: 'admin',
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
        created_at: 111,
        updated_at: 111,
      }],
    })
    expect(agentGetMock).toHaveBeenCalledWith('neo', 7)
    expect(keysAllMock).toHaveBeenCalledWith(5, 7)
  })

  it('creates a key for a valid admin within the caller workspace', async () => {
    const agentGetMock = vi.fn(() => ({ id: 5, name: 'neo', workspace_id: 7 }))
    const runMock = vi.fn(() => ({ lastInsertRowid: 44 }))
    prepareMock
      .mockReturnValueOnce({ get: agentGetMock })
      .mockReturnValueOnce({ run: runMock })

    const { POST } = await import('@/app/api/agents/[id]/keys/route')
    const response = await POST(
      jsonRequest('http://localhost/api/agents/neo/keys', 'POST', {
        name: 'ops key',
        scopes: ['viewer', 'agent:self'],
      }),
      { params: Promise.resolve({ id: 'neo' }) },
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.key).toEqual(expect.objectContaining({
      id: 44,
      name: 'ops key',
      key_prefix: expect.any(String),
      scopes: ['viewer', 'agent:self'],
    }))
    expect(body.api_key).toMatch(/^mca_/)
    expect(agentGetMock).toHaveBeenCalledWith('neo', 7)
    expect(runMock).toHaveBeenCalled()
  })

  it('revokes a key for a valid admin within the caller workspace', async () => {
    const agentGetMock = vi.fn(() => ({ id: 5, name: 'neo', workspace_id: 7 }))
    const runMock = vi.fn(() => ({ changes: 1 }))
    prepareMock
      .mockReturnValueOnce({ get: agentGetMock })
      .mockReturnValueOnce({ run: runMock })

    const { DELETE } = await import('@/app/api/agents/[id]/keys/route')
    const response = await DELETE(
      jsonRequest('http://localhost/api/agents/neo/keys', 'DELETE', { key_id: 44 }),
      { params: Promise.resolve({ id: 'neo' }) },
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(expect.objectContaining({ success: true, key_id: 44, revoked_at: expect.any(Number) }))
    expect(agentGetMock).toHaveBeenCalledWith('neo', 7)
    expect(runMock).toHaveBeenCalled()
  })

  it('returns not found for cross-workspace agent access', async () => {
    const agentGetMock = vi.fn(() => null)
    prepareMock.mockReturnValueOnce({ get: agentGetMock })

    const { GET } = await import('@/app/api/agents/[id]/keys/route')
    const response = await GET(
      jsonRequest('http://localhost/api/agents/other/keys', 'GET'),
      { params: Promise.resolve({ id: 'other' }) },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Agent not found' })
    expect(agentGetMock).toHaveBeenCalledWith('other', 7)
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/agents/[id]/keys/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
