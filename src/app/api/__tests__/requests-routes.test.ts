import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as createRoute } from '@/app/api/requests/route'
import { POST as reviewRoute } from '@/app/api/requests/[id]/review/route'
import { POST as approveRoute } from '@/app/api/requests/[id]/approve/route'
import { POST as rejectRoute } from '@/app/api/requests/[id]/reject/route'

const { requireRoleMock, requireWorkspaceIdMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Route-bound request lifecycle',
    description: 'Use API routes as the only allowed control surface.',
    risk_level: 1,
    requested_by: 'nikma',
    target_area: 'mission-control',
    proposed_prompt: 'Route all request transitions through the gateway.',
    validation_plan: 'pnpm typecheck && pnpm test && pnpm build',
    notes: 'API-only draft object flow.',
    ...overrides,
  }
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('requests API routes', () => {
  beforeEach(() => {
    requireRoleMock.mockReset()
    requireWorkspaceIdMock.mockReset()

    requireRoleMock.mockReturnValue({
      user: {
        id: 7,
        username: 'nikma',
        display_name: 'Nikma',
        role: 'admin',
        workspace_id: 5,
        tenant_id: 1,
        created_at: 0,
        updated_at: 0,
        last_login_at: null,
      },
    })

    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 5 })
  })

  it('rejects unauthenticated request creation', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const response = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput()) as any,
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context cannot be resolved for creation', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const response = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput()) as any,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
  })

  it('supports create -> review -> approve happy path', async () => {
    const createResponse = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput()) as any,
    )
    expect(createResponse.status).toBe(200)

    const createdBody = await createResponse.json()
    const created = createdBody.request

    const reviewResponse = await reviewRoute(
      jsonRequest(`http://localhost/api/requests/${created.id}/review`, { request: created }) as any,
      { params: Promise.resolve({ id: created.id }) },
    )
    expect(reviewResponse.status).toBe(200)

    const reviewBody = await reviewResponse.json()
    expect(reviewBody.request.status).toBe('REVIEW_READY')

    const approveResponse = await approveRoute(
      jsonRequest(`http://localhost/api/requests/${created.id}/approve`, { request: reviewBody.request }) as any,
      { params: Promise.resolve({ id: created.id }) },
    )
    expect(approveResponse.status).toBe(200)

    const approveBody = await approveResponse.json()
    expect(approveBody.request.status).toBe('APPROVED')
  })

  it('rejects unauthenticated review', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const response = await reviewRoute(
      jsonRequest('http://localhost/api/requests/mcr-1/review', { request: { id: 'mcr-1' } }) as any,
      { params: Promise.resolve({ id: 'mcr-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('rejects unauthenticated approve', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const response = await approveRoute(
      jsonRequest('http://localhost/api/requests/mcr-1/approve', { request: { id: 'mcr-1' } }) as any,
      { params: Promise.resolve({ id: 'mcr-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('rejects unauthenticated reject', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const response = await rejectRoute(
      jsonRequest('http://localhost/api/requests/mcr-1/reject', {
        request: { id: 'mcr-1' },
        reason: 'Denied',
      }) as any,
      { params: Promise.resolve({ id: 'mcr-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed for invalid auth/session on review', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const response = await reviewRoute(
      jsonRequest('http://localhost/api/requests/mcr-1/review', { request: { id: 'mcr-1' } }) as any,
      { params: Promise.resolve({ id: 'mcr-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('returns 400 for invalid transitions', async () => {
    const createResponse = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput()) as any,
    )
    const created = (await createResponse.json()).request

    const approveResponse = await approveRoute(
      jsonRequest(`http://localhost/api/requests/${created.id}/approve`, { request: created }) as any,
      { params: Promise.resolve({ id: created.id }) },
    )

    expect(approveResponse.status).toBe(400)
    expect(await approveResponse.json()).toEqual({
      error: 'Cannot approve request from status DRAFT.',
    })
  })

  it('keeps route/body id mismatch denied', async () => {
    const response = await approveRoute(
      jsonRequest('http://localhost/api/requests/mcr-route/approve', {
        request: { id: 'mcr-body', status: 'REVIEW_READY' },
      }) as any,
      { params: Promise.resolve({ id: 'mcr-route' }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Request id does not match route id.',
    })
  })

  it('reject works from allowed states', async () => {
    const draftCreate = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput({ title: 'Draft rejection path' })) as any,
    )
    const draft = (await draftCreate.json()).request

    const rejectedDraft = await rejectRoute(
      jsonRequest(`http://localhost/api/requests/${draft.id}/reject`, {
        request: draft,
        reason: 'Need stronger scope.',
      }) as any,
      { params: Promise.resolve({ id: draft.id }) },
    )
    expect(rejectedDraft.status).toBe(200)
    expect((await rejectedDraft.json()).request.status).toBe('REJECTED')

    const reviewCreate = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput({ title: 'Review rejection path' })) as any,
    )
    const reviewDraft = (await reviewCreate.json()).request
    const reviewReady = await reviewRoute(
      jsonRequest(`http://localhost/api/requests/${reviewDraft.id}/review`, { request: reviewDraft }) as any,
      { params: Promise.resolve({ id: reviewDraft.id }) },
    )
    const reviewRequest = (await reviewReady.json()).request

    const rejectedReview = await rejectRoute(
      jsonRequest(`http://localhost/api/requests/${reviewDraft.id}/reject`, {
        request: reviewRequest,
        reason: 'Needs revision.',
      }) as any,
      { params: Promise.resolve({ id: reviewDraft.id }) },
    )
    expect(rejectedReview.status).toBe(200)
    expect((await rejectedReview.json()).request.status).toBe('REJECTED')

    const approveCreate = await createRoute(
      jsonRequest('http://localhost/api/requests', makeInput({ title: 'Approved rejection path' })) as any,
    )
    const approveDraft = (await approveCreate.json()).request
    const approveReady = await reviewRoute(
      jsonRequest(`http://localhost/api/requests/${approveDraft.id}/review`, { request: approveDraft }) as any,
      { params: Promise.resolve({ id: approveDraft.id }) },
    )
    const approved = await approveRoute(
      jsonRequest(`http://localhost/api/requests/${approveDraft.id}/approve`, {
        request: (await approveReady.json()).request,
      }) as any,
      { params: Promise.resolve({ id: approveDraft.id }) },
    )
    const approvedRequest = (await approved.json()).request

    const rejectedApproved = await rejectRoute(
      jsonRequest(`http://localhost/api/requests/${approveDraft.id}/reject`, {
        request: approvedRequest,
        reason: 'Approval withdrawn.',
      }) as any,
      { params: Promise.resolve({ id: approveDraft.id }) },
    )
    expect(rejectedApproved.status).toBe(200)
    expect((await rejectedApproved.json()).request.status).toBe('REJECTED')
  })
})
