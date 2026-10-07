import { formatAdminURL } from 'payload/shared'

import type { EntityQuery } from '../shared/api.js'

export type LocaleLink = { href: string; newTab: boolean }

// On the document page, changing `?locale=` in the current URL is enough. In a relationship
// drawer (`editDepth > 1`) the current URL belongs to the parent document, so the link is
// built as Payload does (`formatAdminURL` + `/collections/…` or `/globals/…`) and opened in
// a new tab; navigating away would close the parent and lose its unsaved changes.
export const localeLinkOf =
  ({
    editDepth,
    adminRoute,
    target,
  }: {
    editDepth: number
    adminRoute: string
    target: EntityQuery | null
  }): ((locale: string) => LocaleLink | null) =>
  locale => {
    const query = `?locale=${encodeURIComponent(locale)}`
    if (editDepth <= 1) return { href: query, newTab: false }
    const path: `/${string}` | null = !target
      ? null
      : 'global' in target
        ? `/globals/${encodeURIComponent(target.global)}`
        : `/collections/${encodeURIComponent(target.collection)}/${encodeURIComponent(target.id)}`
    if (!path) return null
    return {
      href: formatAdminURL({ adminRoute, path: `${path}${query}` }),
      newTab: true,
    }
  }
