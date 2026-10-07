import type {
  Block,
  CollectionConfig,
  Field,
  GlobalConfig,
  PayloadComponent,
} from 'payload'

import { findLocalizedContainers } from '../core/schema.js'

const CONTROL_COMPONENT = '@runroom/payload-plugin-translator/client#TranslateControl'

const refuseLocalizedContainers = ({
  slug,
  fields,
  blocks,
}: {
  slug: string
  fields: Field[]
  blocks: Block[]
}): void => {
  const containers = findLocalizedContainers(fields, blocks)
  if (containers.length > 0) {
    throw new Error(
      `translatorPlugin does not support localized containers in ${slug}: ${containers.join(', ')}`,
    )
  }
}

// Collections and globals both append the control to a `beforeDocumentControls` list; only
// the slot that holds it differs.
const withBeforeDocumentControls = <
  T extends { beforeDocumentControls?: PayloadComponent[] },
>(
  slot: T | undefined,
): T & { beforeDocumentControls: PayloadComponent[] } =>
  ({
    ...slot,
    beforeDocumentControls: [...(slot?.beforeDocumentControls ?? []), CONTROL_COMPONENT],
  }) as T & { beforeDocumentControls: PayloadComponent[] }

// A collection without drafts is translated too: the job writes directly and the drawer
// warns that it goes live at once (see `server/entity.ts`).
export const withControl = ({
  collection,
  blocks,
}: {
  collection: CollectionConfig
  blocks: Block[]
}): CollectionConfig => {
  refuseLocalizedContainers({ slug: collection.slug, fields: collection.fields, blocks })
  return {
    ...collection,
    admin: {
      ...collection.admin,
      components: {
        ...collection.admin?.components,
        edit: withBeforeDocumentControls(collection.admin?.components?.edit),
      },
    },
  }
}

// Payload 3.90 renders a global's `beforeDocumentControls` from `admin.components.elements`,
// not from `edit` as it does for collections.
export const withGlobalControl = ({
  global,
  blocks,
}: {
  global: GlobalConfig
  blocks: Block[]
}): GlobalConfig => {
  refuseLocalizedContainers({ slug: global.slug, fields: global.fields, blocks })
  return {
    ...global,
    admin: {
      ...global.admin,
      components: {
        ...global.admin?.components,
        elements: withBeforeDocumentControls(global.admin?.components?.elements),
      },
    },
  }
}
