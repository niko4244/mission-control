import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  prepareMock,
  execMock,
  getDetectedGatewayPortMock,
  getDetectedGatewayTokenMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  prepareMock: vi.fn(),
  execMock: vi.fn(),
  getDetectedGatewayPortMock: vi.fn(() => 18789),
  getDetectedGatewayTokenMock: vi.fn(() => 'seed-token'),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    exec: execMock,
    prepare: prepareMock,
  })),
}))

vi.mock('@/lib/gateway-runtime', () => ({
  getDetectedGatewayPort: getDetectedGatewayPortMock,
  getDetectedGatewayToken: getDetectedGatewayTokenMock,
}))

function jsonRequest(url: string, method: 'POST' | 'PUT', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  })
}

function installGatewayDbMocks() {
  const insertGatewayRunMock = vi.fn(() => ({ lastInsertRowid: 44 }))
  const updateGatewayRunMock = vi.fn(() => ({ changes: 1 }))
  const upsertAgentRunMock = vi.fn(() => ({ changes: 1 }))
  const auditRunMock = vi.fn(() => ({ changes: 1 }))
  const selectGatewayGetMock = vi.fn((id: number) => ({
    id: Number(id),
    name: 'ops-gateway',
    host: '10.0.0.10',
    port: 18789,
    token: 'secret-token',
    is_primary: 0,
    status: 'healthy',
    last_seen: null,
    latency: null,
    sessions_count: 0,
    agents_count: 1,
    created_at: 100,
    updated_at: 100,
  }))

  prepareMock.mockImplementation((sql: string) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.startsWith('insert into gateways')) return { run: insertGatewayRunMock }
    if (normalized.startsWith('update gateways set is_primary = 0')) return { run: vi.fn(() => ({ changes: 1 })) }
    if (normalized.startsWith('update gateways set')) return { run: updateGatewayRunMock }
    if (normalized.startsWith('insert into agents')) return { run: upsertAgentRunMock }
    if (normalized.startsWith('insert into audit_log')) return { run: auditRunMock }
    if (normalized.startsWith('select * from gateways where id = ?')) return { get: selectGatewayGetMock }

    return {
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
    }
  })

  return {
    insertGatewayRunMock,
    updateGatewayRunMock,
    upsertAgentRunMock,
    auditRunMock,
    selectGatewayGetMock,
  }
}

describe('gateways route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'admin', role: 'admin', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
  })

  it('denies unauthenticated POST access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { POST } = await import('@/app/api/gateways/route')
    const response = await POST(
      jsonRequest('http://localhost/api/gateways', 'POST', {
        name: 'ops-gateway',
        host: '10.0.0.10',
        port: 18789,
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for POST', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { POST } = await import('@/app/api/gateways/route')
    const response = await POST(
      jsonRequest('http://localhost/api/gateways', 'POST', {
        name: 'ops-gateway',
        host: '10.0.0.10',
        port: 18789,
        agents: [{ name: 'neo', role: 'operator' }],
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('allows valid authorized workspace POST behavior and does not leak cross-workspace agent registration', async () => {
    const { upsertAgentRunMock } = installGatewayDbMocks()

    const { POST } = await import('@/app/api/gateways/route')
    const response = await POST(
      jsonRequest('http://localhost/api/gateways', 'POST', {
        name: 'ops-gateway',
        host: '10.0.0.10',
        port: 18789,
        workspace_id: 999,
        agents: [{ name: 'neo', role: 'operator', workspace_id: 999 }],
      }),
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      gateway: expect.objectContaining({
        id: 44,
        name: 'ops-gateway',
        token: '--------',
        token_set: true,
      }),
      agents_registered: 1,
    })
    expect(upsertAgentRunMock).toHaveBeenCalledWith('neo', 'operator', expect.any(Number), 7, expect.any(Number))
    expect(upsertAgentRunMock).not.toHaveBeenCalledWith('neo', 'operator', expect.any(Number), 999, expect.any(Number))
  })

  it('fails closed when workspace context is missing for PUT', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { PUT } = await import('@/app/api/gateways/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/gateways', 'PUT', {
        id: 44,
        agents: [{ name: 'neo', role: 'operator' }],
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('allows valid authorized workspace PUT behavior and does not leak cross-workspace agent registration', async () => {
    const { upsertAgentRunMock, updateGatewayRunMock, selectGatewayGetMock } = installGatewayDbMocks()

    const { PUT } = await import('@/app/api/gateways/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/gateways', 'PUT', {
        id: 44,
        status: 'healthy',
        workspace_id: 999,
        agents: [{ name: 'trinity', role: 'agent', workspace_id: 999 }],
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      gateway: expect.objectContaining({
        id: 44,
        token: '--------',
        token_set: true,
      }),
      agents_registered: 1,
    })
    expect(selectGatewayGetMock).toHaveBeenCalledWith(44)
    expect(updateGatewayRunMock).toHaveBeenCalled()
    expect(upsertAgentRunMock).toHaveBeenCalledWith('trinity', 'agent', expect.any(Number), 7, expect.any(Number))
    expect(upsertAgentRunMock).not.toHaveBeenCalledWith('trinity', 'agent', expect.any(Number), 999, expect.any(Number))
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/gateways/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
