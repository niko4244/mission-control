import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  prepareMock,
  logActivityMock,
  broadcastMock,
  runOpenClawMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  prepareMock: vi.fn(),
  logActivityMock: vi.fn(),
  broadcastMock: vi.fn(),
  runOpenClawMock: vi.fn(),
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

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: broadcastMock },
}))

vi.mock('@/lib/command', () => ({
  runOpenClaw: runOpenClawMock,
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

describe('pipeline run route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'operator', role: 'operator', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
    runOpenClawMock.mockResolvedValue({ stdout: '{"ok":true}', stderr: '' })
  })

  it('denies unauthenticated GET access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/pipelines/run/route')
    const response = await GET(
      jsonRequest('http://localhost/api/pipelines/run', 'GET'),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for GET', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/pipelines/run/route')
    const response = await GET(
      jsonRequest('http://localhost/api/pipelines/run', 'GET'),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('returns workspace-scoped runs for authorized GET access', async () => {
    const runsAllMock = vi.fn(() => [{
      id: 4,
      pipeline_id: 11,
      status: 'running',
      current_step: 0,
      steps_snapshot: JSON.stringify([{ step_index: 0, status: 'running' }]),
      started_at: 100,
      completed_at: null,
      triggered_by: 'operator',
      created_at: 100,
    }])
    const pipelineNamesAllMock = vi.fn(() => [{ id: 11, name: 'Nightly' }])

    prepareMock
      .mockReturnValueOnce({ all: runsAllMock })
      .mockReturnValueOnce({ all: pipelineNamesAllMock })

    const { GET } = await import('@/app/api/pipelines/run/route')
    const response = await GET(
      jsonRequest('http://localhost/api/pipelines/run?pipeline_id=11&limit=5', 'GET'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      runs: [{
        id: 4,
        pipeline_id: 11,
        pipeline_name: 'Nightly',
        status: 'running',
        current_step: 0,
        steps_snapshot: [{ step_index: 0, status: 'running' }],
        started_at: 100,
        completed_at: null,
        triggered_by: 'operator',
        created_at: 100,
      }],
    })
    expect(runsAllMock).toHaveBeenCalledWith(7, 11, 5)
    expect(pipelineNamesAllMock).toHaveBeenCalledWith(7, 11)
  })

  it('does not leak cross-workspace run details in GET', async () => {
    const runGetMock = vi.fn(() => undefined)
    prepareMock.mockReturnValueOnce({ get: runGetMock })

    const { GET } = await import('@/app/api/pipelines/run/route')
    const response = await GET(
      jsonRequest('http://localhost/api/pipelines/run?id=999', 'GET'),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Run not found' })
    expect(runGetMock).toHaveBeenCalledWith(999, 7)
  })

  it('denies unauthenticated POST access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { POST } = await import('@/app/api/pipelines/run/route')
    const response = await POST(
      jsonRequest('http://localhost/api/pipelines/run', 'POST', { action: 'start', pipeline_id: 11 }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing for POST', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { POST } = await import('@/app/api/pipelines/run/route')
    const response = await POST(
      jsonRequest('http://localhost/api/pipelines/run', 'POST', { action: 'start', pipeline_id: 11 }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('allows authorized workspace-scoped pipeline start', async () => {
    const pipelineGetMock = vi.fn(() => ({
      id: 11,
      name: 'Nightly',
      steps: JSON.stringify([{ template_id: 101, on_failure: 'stop' }]),
    }))
    const templatesAllMock = vi.fn(() => [{
      id: 101,
      name: 'Step A',
      model: 'sonnet',
      task_prompt: 'do thing',
      timeout_seconds: 60,
    }])
    const insertRunMock = vi.fn(() => ({ lastInsertRowid: 44 }))
    const updatePipelineRunMock = vi.fn(() => ({ changes: 1 }))
    const templateByIdGetMock = vi.fn(() => ({
      id: 101,
      name: 'Step A',
      model: 'sonnet',
      task_prompt: 'do thing',
      timeout_seconds: 60,
    }))
    const pipelineNameGetMock = vi.fn(() => ({ name: 'Nightly' }))

    prepareMock
      .mockReturnValueOnce({ get: pipelineGetMock })
      .mockReturnValueOnce({ all: templatesAllMock })
      .mockReturnValueOnce({ run: insertRunMock })
      .mockReturnValueOnce({ run: updatePipelineRunMock })
      .mockReturnValueOnce({ run: vi.fn(() => ({ changes: 1 })) })

    const { POST } = await import('@/app/api/pipelines/run/route')
    const response = await POST(
      jsonRequest('http://localhost/api/pipelines/run', 'POST', { action: 'start', pipeline_id: 11 }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.run).toEqual(expect.objectContaining({
      id: 44,
      pipeline_id: 11,
      status: 'running',
      current_step: 0,
    }))
    expect(pipelineGetMock).toHaveBeenCalledWith(11, 7)
    expect(insertRunMock).toHaveBeenCalledWith(
      11,
      expect.any(String),
      expect.any(Number),
      'operator',
      7,
    )
    expect(runOpenClawMock).toHaveBeenCalled()
  })

  it('does not allow cross-workspace POST run access', async () => {
    const runGetMock = vi.fn(() => undefined)
    prepareMock.mockReturnValueOnce({ get: runGetMock })

    const { POST } = await import('@/app/api/pipelines/run/route')
    const response = await POST(
      jsonRequest('http://localhost/api/pipelines/run', 'POST', { action: 'cancel', run_id: 999 }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Run not found' })
    expect(runGetMock).toHaveBeenCalledWith(999, 7)
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/pipelines/run/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
