import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  listRunsMock,
  createRunMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  listRunsMock: vi.fn(),
  createRunMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/runs', () => ({
  listRuns: listRunsMock,
  createRun: createRunMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

function jsonRequest(url: string, method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  })
}

describe('v1 runs index route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'operator', role: 'operator', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
  })

  it('denies unauthenticated GET access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/v1/runs/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs', 'GET'),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for GET', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/v1/runs/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs?status=running', 'GET'),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(listRunsMock).not.toHaveBeenCalled()
  })

  it('returns workspace-scoped runs for authorized GET access', async () => {
    listRunsMock.mockReturnValueOnce({
      runs: [{ id: 'run-1', workspace_id: '7' }],
      total: 1,
    })

    const { GET } = await import('@/app/api/v1/runs/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs?agent_id=neo&status=running&since=2025-01-01&task_id=task-1&limit=10&offset=5', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Agent-Run-Protocol')).toBe('0.1.0')
    expect(await response.json()).toEqual({
      runs: [{ id: 'run-1', workspace_id: '7' }],
      total: 1,
    })
    expect(listRunsMock).toHaveBeenCalledWith({
      workspaceId: 7,
      agentId: 'neo',
      status: 'running',
      since: '2025-01-01',
      taskId: 'task-1',
      limit: 10,
      offset: 5,
    })
  })

  it('does not leak cross-workspace runs in GET results', async () => {
    listRunsMock.mockReturnValueOnce({ runs: [], total: 0 })

    const { GET } = await import('@/app/api/v1/runs/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs?agent_id=other-workspace-agent', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runs: [], total: 0 })
    expect(listRunsMock).toHaveBeenCalledWith({
      workspaceId: 7,
      agentId: 'other-workspace-agent',
      status: undefined,
      since: undefined,
      taskId: undefined,
      limit: undefined,
      offset: undefined,
    })
  })

  it('denies unauthenticated POST access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { POST } = await import('@/app/api/v1/runs/route')
    const response = await POST(
      jsonRequest('http://localhost/api/v1/runs', 'POST', { status: 'running' }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for POST', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { POST } = await import('@/app/api/v1/runs/route')
    const response = await POST(
      jsonRequest('http://localhost/api/v1/runs', 'POST', {
        agent_id: 'neo',
        status: 'running',
        started_at: '2025-01-01T00:00:00.000Z',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(createRunMock).not.toHaveBeenCalled()
  })

  it('allows authorized workspace-scoped POST access', async () => {
    createRunMock.mockReturnValueOnce({
      id: 'run-44',
      provenance: { run_hash: 'abc123' },
    })

    const { POST } = await import('@/app/api/v1/runs/route')
    const response = await POST(
      jsonRequest('http://localhost/api/v1/runs', 'POST', {
        agent_id: 'neo',
        status: 'running',
        started_at: '2025-01-01T00:00:00.000Z',
      }),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('X-Agent-Run-Protocol')).toBe('0.1.0')
    expect(await response.json()).toEqual({
      id: 'run-44',
      run_hash: 'abc123',
    })
    expect(createRunMock).toHaveBeenCalledWith({
      agent_id: 'neo',
      status: 'running',
      started_at: '2025-01-01T00:00:00.000Z',
      cost: { input_tokens: 0, output_tokens: 0 },
      provenance: {},
      steps: [],
    }, 7)
  })

  it('requires the existing POST minimum fields before createRun', async () => {
    const { POST } = await import('@/app/api/v1/runs/route')
    const response = await POST(
      jsonRequest('http://localhost/api/v1/runs', 'POST', {
        agent_id: 'neo',
        status: 'running',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Missing required fields: agent_id, status, started_at',
    })
    expect(createRunMock).not.toHaveBeenCalled()
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/v1/runs/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
