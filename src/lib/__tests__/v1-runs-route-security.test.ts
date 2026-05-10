import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  getRunMock,
  updateRunMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  getRunMock: vi.fn(),
  updateRunMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/runs', () => ({
  getRun: getRunMock,
  updateRun: updateRunMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

function jsonRequest(url: string, method: 'GET' | 'PATCH', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body == null ? undefined : JSON.stringify(body),
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  })
}

describe('v1 runs [run_id] route security', () => {
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

    const { GET } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs/run-1', 'GET'),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for GET', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs/run-1', 'GET'),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(getRunMock).not.toHaveBeenCalled()
  })

  it('returns a workspace-scoped run for authorized GET access', async () => {
    getRunMock.mockReturnValueOnce({
      id: 'run-1',
      status: 'running',
      workspace_id: '7',
    })

    const { GET } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs/run-1', 'GET'),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Agent-Run-Protocol')).toBe('0.1.0')
    expect(await response.json()).toEqual({
      id: 'run-1',
      status: 'running',
      workspace_id: '7',
    })
    expect(getRunMock).toHaveBeenCalledWith('run-1', 7)
  })

  it('does not allow cross-workspace GET run access', async () => {
    getRunMock.mockReturnValueOnce(null)

    const { GET } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await GET(
      jsonRequest('http://localhost/api/v1/runs/run-999', 'GET'),
      { params: Promise.resolve({ run_id: 'run-999' }) },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Run not found' })
    expect(getRunMock).toHaveBeenCalledWith('run-999', 7)
  })

  it('denies unauthenticated PATCH access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { PATCH } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await PATCH(
      jsonRequest('http://localhost/api/v1/runs/run-1', 'PATCH', { status: 'completed' }),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for PATCH', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { PATCH } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await PATCH(
      jsonRequest('http://localhost/api/v1/runs/run-1', 'PATCH', { status: 'completed' }),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(updateRunMock).not.toHaveBeenCalled()
  })

  it('allows authorized workspace-scoped PATCH access', async () => {
    updateRunMock.mockReturnValueOnce({
      id: 'run-1',
      status: 'completed',
      workspace_id: '7',
    })

    const { PATCH } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await PATCH(
      jsonRequest('http://localhost/api/v1/runs/run-1', 'PATCH', {
        status: 'completed',
        outcome: 'success',
      }),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Agent-Run-Protocol')).toBe('0.1.0')
    expect(await response.json()).toEqual({
      id: 'run-1',
      status: 'completed',
      workspace_id: '7',
    })
    expect(updateRunMock).toHaveBeenCalledWith('run-1', {
      status: 'completed',
      outcome: 'success',
    }, 7)
  })

  it('does not allow cross-workspace PATCH run access', async () => {
    updateRunMock.mockReturnValueOnce(null)

    const { PATCH } = await import('@/app/api/v1/runs/[run_id]/route')
    const response = await PATCH(
      jsonRequest('http://localhost/api/v1/runs/run-999', 'PATCH', { status: 'failed' }),
      { params: Promise.resolve({ run_id: 'run-999' }) },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Run not found' })
    expect(updateRunMock).toHaveBeenCalledWith('run-999', { status: 'failed' }, 7)
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/v1/runs/[run_id]/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
