// Lo que identifica en los endpoints lo que se está editando: un global por su slug, un
// documento por colección e id. `null` mientras Payload aún no lo sabe (un alta nueva).
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
