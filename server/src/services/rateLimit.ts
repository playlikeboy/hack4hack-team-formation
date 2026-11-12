// In-memory fixed-window rate limits. Deliberately simple: one Map, one
// counter per key, reset when the window passes. The honest limitation is
// documented in the design doc — counters live in this process, so a
// second instance would split them. For a single-instance build that is
// the right trade-off; a shared store is the known next step.
//
// Used for: login (10 / IP / min) and join-by-invite-code (5 / IP / 10 min).
// The invite-code limit is what makes an 8-character code safe to type.

import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import type { AppEnv } from '../lib/env'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

// Sweep stale buckets every 10 minutes so the map cannot grow forever.
// unref() keeps this timer from holding the process open on shutdown.
const sweep = setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}, 10 * 60 * 1000)
sweep.unref()

/** Returns true if the attempt is allowed (and counts it), false if limited. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}

/** Test-only escape hatch: clear all counters between test cases. */
export function resetRateLimits(): void {
  buckets.clear()
}

/**
 * The client's IP for rate limiting. Behind a proxy (Hugging Face, any
 * load balancer) the real IP arrives in X-Forwarded-For; locally it is
 * the socket address. Trusting X-Forwarded-For is correct here because
 * the only proxies in front of this server are the ones deploying it —
 * and the cost of a spoofed header is a shared rate-limit bucket, not
 * access to anything.
 */
export function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}