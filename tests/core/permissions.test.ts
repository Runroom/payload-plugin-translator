import { describe, expect, it } from 'vitest'

import { mergeFieldPermissions } from '../../src/core/permissions.js'

describe('mergeFieldPermissions', () => {
  it('keeps full permissions when both sides allow everything', () => {
    expect(mergeFieldPermissions(true, true)).toBe(true)
  })

  it('takes read from the source side and update from the target side', () => {
    const read = { title: true, note: { read: true, create: true }, hidden: {} }
    const update = { title: true, note: true, hidden: true }

    expect(mergeFieldPermissions(read as never, update as never)).toEqual({
      title: true,
      note: { create: true, read: true, update: true, fields: {} },
    })
  })

  it('drops a field one side does not mention at all', () => {
    expect(mergeFieldPermissions({ title: true, note: true }, { title: true })).toEqual({
      title: true,
    })
    expect(mergeFieldPermissions(true, { title: true })).toEqual({ title: true })
    expect(mergeFieldPermissions({ title: true }, true)).toEqual({ title: true })
  })

  it('merges nested fields and blocks level by level', () => {
    const read = {
      agenda: {
        read: true,
        create: true,
        update: true,
        fields: { label: true, secret: { create: true, update: true } },
      },
      layout: {
        read: true,
        create: true,
        update: true,
        blocks: { hero: true, quote: { fields: { text: true, author: true } } },
      },
    }
    const update = {
      agenda: true,
      layout: {
        read: true,
        create: true,
        update: true,
        blocks: {
          hero: { fields: { heading: true } },
          quote: { fields: { text: true } },
        },
      },
    }

    expect(mergeFieldPermissions(read as never, update as never)).toEqual({
      agenda: { create: true, read: true, update: true, fields: { label: true } },
      layout: {
        create: true,
        read: true,
        update: true,
        fields: {},
        blocks: {
          hero: { fields: { heading: true } },
          quote: { fields: { text: true } },
        },
      },
    })
  })
})
