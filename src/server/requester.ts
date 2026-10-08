import type { Payload, TypedUser } from 'payload'

import type { Requester } from './localeRun.js'

/** The requester as the job input carries it; `null` when the input is malformed. */
export const requesterOf = (raw: unknown): Requester | null => {
  const value = raw as { collection?: unknown; id?: unknown; strategy?: unknown } | null
  if (!value || typeof value.collection !== 'string') return null
  if (typeof value.id !== 'string' && typeof value.id !== 'number') return null
  return {
    collection: value.collection,
    id: String(value.id),
    ...(typeof value.strategy === 'string' ? { strategy: value.strategy } : {}),
  }
}

// Payload binds `req.user` with the auth collection's `auth.depth` (unset, it falls back
// to `defaultDepth` like any read), and stamps it with its collection and strategy.
const authDepthOf = (payload: Payload, collection: string): number | undefined => {
  const registered = payload.collections as unknown as Record<
    string,
    { config: { auth?: { depth?: number } } } | undefined
  >
  return registered[collection]?.config.auth?.depth
}

// The job runs outside the request that queued it, so the requester is loaded again on
// every attempt; a user deleted in the meantime can no longer translate anything. The user
// is shaped as the admin's request had it, so access rules that look at populated
// relations (a role's slug) or at the auth strategy decide the same way in the job. A job
// queued before the strategy was recorded falls back to Payload's own `local-jwt`.
export const loadRequester = async (
  payload: Payload,
  requester: Requester | null,
): Promise<TypedUser | null> => {
  if (!requester) return null
  const user = (await payload.findByID({
    collection: requester.collection as never,
    id: requester.id,
    depth: authDepthOf(payload, requester.collection),
    overrideAccess: true,
    disableErrors: true,
  })) as unknown as Record<string, unknown> | null
  if (!user) return null
  return {
    ...user,
    collection: requester.collection,
    _strategy: requester.strategy ?? 'local-jwt',
  } as unknown as TypedUser
}
