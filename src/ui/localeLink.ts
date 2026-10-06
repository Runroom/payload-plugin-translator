import { formatAdminURL } from 'payload/shared'

import type { Target } from './target.js'

export type LocaleLink = { href: string; newTab: boolean }

// On the document page changing `?locale=` in the current URL is enough. In a relationship
// drawer (`editDepth > 1`) the current URL is the parent document's: the document's own URL
// is built as Payload does (`formatAdminURL` + `/collections/…` or `/globals/…`) and opened
// in another tab, because navigating here would close the parent with whatever it has
// unsaved.
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
