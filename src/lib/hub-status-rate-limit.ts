import { NextResponse } from 'next/server'
import type { User } from '@/lib/auth'
import { extractClientIp } from '@/lib/rate-limit'

/**
 * Read-only in-memory limiter for hub visibility endpoints.
 * This is appropriate for local and single-instance deployments.
 * Multi-instance deployments should replace this with a shared backing store.
 */
const WINDOW_MS = 60_000
const MAX_REQUESTS = 30
const MAX_ENTRIES = 10_000

type RateLimitEntry = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

const cleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key)
  }
}, 60_000)

if (cleanupInterval.unref) cleanupInterval.unref()

function evictOldest() {
  let oldestKey: string | null = null
  let oldestResetAt = Infinity

  for (const [key, entry] of store) {
    if (entry.resetAt < oldestResetAt) {
      oldestKey = key
      oldestResetAt = entry.resetAt
    }
  }

  if (oldestKey) store.delete(oldestKey)
}

export function buildHubStatusRateLimitKey(
  request: Request,
  user: Pick<User, 'id' | 'agent_id' | 'role'>,
  workspaceId: number,
): string {
  const ip = extractClientIp(request)
  const actorId =
    typeof user.agent_id === 'number' && user.agent_id > 0
      ? `agent:${user.agent_id}`
      : `user:${user.id}`

  return `hub-view:ws:${workspaceId}:${actorId}:role:${user.role}:ip:${ip}`
}

export function checkHubStatusRateLimit(
  request: Request,
  user: Pick<User, 'id' | 'agent_id' | 'role'>,
  workspaceId: number,
): NextResponse | null {
  const key = buildHubStatusRateLimitKey(request, user, workspaceId)
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    if (!entry && store.size >= MAX_ENTRIES) evictOldest()
    store.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return null
  }

  entry.count++
  if (entry.count > MAX_REQUESTS) {
    return NextResponse.json(
      { error: 'Remote hub status rate limit exceeded. Please try again later.' },
      { status: 429 },
    )
  }

  return null
}
