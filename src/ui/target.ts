// What identifies, for the endpoints, what is being edited: a global by its slug, a
// document by collection and id. `null` while Payload does not know it yet (a new document).
export type Target = Record<string, string>

export const targetOf = ({
  id,
  collectionSlug,
  globalSlug,
}: {
  id: number | string | undefined
  collectionSlug: string | undefined
  globalSlug: string | undefined
}): Target | null => {
  if (globalSlug) return { global: globalSlug }
  if (collectionSlug && id !== undefined)
    return { collection: collectionSlug, id: String(id) }
  return null
}
