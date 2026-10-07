import type { EntityQuery } from '../shared/api.js'

// `null` while Payload does not know the entity yet (a new document).
export const targetOf = ({
  id,
  collectionSlug,
  globalSlug,
}: {
  id: number | string | undefined
  collectionSlug: string | undefined
  globalSlug: string | undefined
}): EntityQuery | null => {
  if (globalSlug) return { global: globalSlug }
  if (collectionSlug && id !== undefined)
    return { collection: collectionSlug, id: String(id) }
  return null
}
