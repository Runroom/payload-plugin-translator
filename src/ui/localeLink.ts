import { formatAdminURL } from 'payload/shared'

import type { Target } from './target.js'

export type LocaleLink = { href: string; newTab: boolean }

// En la página del documento basta con cambiar `?locale=` de la URL actual. En un drawer
// de relación (`editDepth > 1`) la URL actual es la del documento padre: se construye la
// del propio documento como hace Payload (`formatAdminURL` + `/collections/…` o
// `/globals/…`) y se abre en otra pestaña, porque navegar aquí cerraría el padre con lo que
// tenga sin guardar.
export const localeLinkOf =
  ({
    editDepth,
    adminRoute,
    target,
  }: {
    editDepth: number
    adminRoute: string
    target: Target | null
  }): ((locale: string) => LocaleLink | null) =>
  locale => {
    const query = `?locale=${encodeURIComponent(locale)}`
    if (editDepth <= 1) return { href: query, newTab: false }
    const path: `/${string}` | null = target?.global
      ? `/globals/${encodeURIComponent(target.global)}`
      : target?.collection && target.id
        ? `/collections/${encodeURIComponent(target.collection)}/${encodeURIComponent(target.id)}`
        : null
    if (!path) return null
    return {
      href: formatAdminURL({ adminRoute, path: `${path}${query}` }),
      newTab: true,
    }
  }
