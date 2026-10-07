import type { Block, Field, SanitizedFieldsPermissions } from 'payload'
import { describe, expect, it } from 'vitest'

import { collectTranslatables, findLocalizedContainers } from '../../src/core/schema.js'

const fields: Field[] = [
  {
    type: 'tabs',
    tabs: [
      {
        label: 'General',
        fields: [
          { name: 'title', type: 'text', localized: true },
          { name: 'internal', type: 'text' },
          {
            name: 'searchText',
            type: 'text',
            localized: true,
            custom: { translator: 'exclude' },
          },
        ],
      },
      {
        name: 'meta',
        label: 'SEO',
        fields: [{ name: 'description', type: 'textarea', localized: true }],
      },
    ],
  },
  {
    type: 'collapsible',
    label: 'Programa',
    fields: [{ name: 'syllabus', type: 'richText', localized: true }],
  },
  {
    name: 'agenda',
    type: 'group',
    fields: [
      {
        name: 'days',
        type: 'array',
        fields: [
          { name: 'label', type: 'text', localized: true },
          {
            name: 'activities',
            type: 'array',
            fields: [
              { name: 'title', type: 'text', localized: true },
              { name: 'startTime', type: 'text' },
            ],
          },
        ],
      },
    ],
  },
]

const data = {
  title: 'Curso',
  internal: 'x',
  searchText: 'curso',
  meta: { description: 'Descripción' },
  syllabus: { root: { type: 'root', children: [] } },
  agenda: {
    days: [
      {
        id: 'd1',
        label: 'Día 1',
        activities: [
          { id: 'a1', title: 'Apertura', startTime: '09:00' },
          { id: 'a2', title: 'Cierre', startTime: '13:00' },
        ],
      },
    ],
  },
}

describe('collectTranslatables', () => {
  const pathsWith = (permissions: SanitizedFieldsPermissions): string[] =>
    collectTranslatables({ fields, data, permissions }).map(value => value.path)

  it('accepts true permissions for every translatable field', () => {
    expect(pathsWith(true)).toEqual(
      collectTranslatables({ fields, data }).map(value => value.path),
    )
  })

  it('skips a denied leaf and a read-only leaf', () => {
    expect(pathsWith({ title: { read: true } } as never)).toEqual([])
    expect(pathsWith({ title: true })).toEqual(['title'])
  })

  it('skips denied groups and arrays', () => {
    expect(
      pathsWith({ agenda: { read: true, update: true, fields: {} } } as never),
    ).toEqual([])
    expect(
      pathsWith({
        agenda: { read: true, update: true, fields: { days: { read: true } } },
      } as never),
    ).toEqual([])
  })

  it('passes permissions through unnamed rows and collapsibles', () => {
    const paths = collectTranslatables({
      fields: [
        { type: 'row', fields: [{ name: 'title', type: 'text', localized: true }] },
        {
          type: 'collapsible',
          label: 'More',
          fields: [{ name: 'subtitle', type: 'text', localized: true }],
        },
      ],
      data: { title: 'Hola', subtitle: 'Sub' },
      permissions: { title: true },
    }).map(value => value.path)
    expect(paths).toEqual(['title'])
  })

  it('steps into a named tab permission entry', () => {
    expect(
      pathsWith({
        meta: { read: true, update: true, fields: { description: true } },
      } as never),
    ).toEqual(['meta.description'])
  })

  it('checks permissions for each block slug', () => {
    const paths = collectTranslatables({
      fields: [
        {
          name: 'layout',
          type: 'blocks',
          blocks: [
            {
              slug: 'hero',
              fields: [{ name: 'heading', type: 'text', localized: true }],
            },
            { slug: 'quote', fields: [{ name: 'text', type: 'text', localized: true }] },
            { slug: 'card', fields: [{ name: 'label', type: 'text', localized: true }] },
          ],
        },
      ],
      data: {
        layout: [
          { id: 'h1', blockType: 'hero', heading: 'Hola' },
          { id: 'q1', blockType: 'quote', text: 'Cita' },
          { id: 'c1', blockType: 'card', label: 'Tarjeta' },
        ],
      },
      permissions: {
        layout: {
          read: true,
          update: true,
          blocks: { hero: true, quote: { fields: { text: true } } },
        },
      } as never,
    }).map(value => value.path)
    expect(paths).toEqual(['layout.h1.heading', 'layout.q1.text'])
  })

  it('finds localized text, textarea and richText fields at any depth', () => {
    const paths = collectTranslatables({ fields, data }).map(value => value.path)

    expect(paths).toEqual([
      'title',
      'meta.description',
      'syllabus',
      'agenda.days.d1.label',
      'agenda.days.d1.activities.a1.title',
      'agenda.days.d1.activities.a2.title',
    ])
  })

  it('keys array rows by id, so reordering does not change the paths', () => {
    const reordered = {
      ...data,
      agenda: {
        days: [
          {
            ...data.agenda.days[0],
            activities: [...data.agenda.days[0]!.activities].reverse(),
          },
        ],
      },
    }

    const paths = collectTranslatables({ fields, data: reordered }).map(
      value => value.path,
    )

    expect(paths).toContain('agenda.days.d1.activities.a1.title')
    expect(paths).toContain('agenda.days.d1.activities.a2.title')
  })

  it('returns the value, kind and segments needed to write it back', () => {
    const activity = collectTranslatables({ fields, data }).find(
      value => value.path === 'agenda.days.d1.activities.a2.title',
    )

    expect(activity).toEqual({
      path: 'agenda.days.d1.activities.a2.title',
      kind: 'text',
      value: 'Cierre',
      segments: [
        { key: 'agenda' },
        { key: 'days', rowId: 'd1' },
        { key: 'activities', rowId: 'a2' },
        { key: 'title' },
      ],
    })
  })

  it('still lists a field whose value is empty, so the target can be compared', () => {
    const values = collectTranslatables({ fields, data: { title: null } })

    expect(values.find(value => value.path === 'title')?.value).toBeNull()
  })

  it('walks blocks by blockType, including referenced blocks', () => {
    const blockFields: Field[] = [
      {
        name: 'layout',
        type: 'blocks',
        blocks: [],
        blockReferences: ['hero' as never],
      },
    ]
    const values = collectTranslatables({
      fields: blockFields,
      data: { layout: [{ id: 'b1', blockType: 'hero', heading: 'Hola' }] },
      blocks: [
        { slug: 'hero', fields: [{ name: 'heading', type: 'text', localized: true }] },
      ],
    })

    expect(values.map(value => value.path)).toEqual(['layout.b1.heading'])
  })
})

describe('findLocalizedContainers', () => {
  it('reports arrays, blocks and groups marked localized', () => {
    expect(
      findLocalizedContainers([
        { name: 'faq', type: 'array', localized: true, fields: [] },
        { name: 'agenda', type: 'group', fields: [{ name: 'x', type: 'text' }] },
      ]),
    ).toEqual(['faq'])
  })
})

describe('collectTranslatables edge cases', () => {
  const pathsOf = (fields: Field[], data: unknown, blocks?: Block[]): string[] =>
    collectTranslatables({ fields, data, blocks }).map(value => value.path)

  it('adds no segment for an unnamed group', () => {
    const paths = pathsOf(
      [{ type: 'group', fields: [{ name: 'title', type: 'text', localized: true }] }],
      { title: 'Hola' },
    )

    expect(paths).toEqual(['title'])
  })

  it('walks an unnamed tab nested inside a named group', () => {
    const paths = pathsOf(
      [
        {
          name: 'outer',
          type: 'group',
          fields: [
            {
              type: 'tabs',
              tabs: [
                {
                  label: 'A',
                  fields: [{ name: 'title', type: 'text', localized: true }],
                },
              ],
            },
          ],
        },
      ],
      { outer: { title: 'Hola' } },
    )

    expect(paths).toEqual(['outer.title'])
  })

  it('skips array rows without an id', () => {
    const paths = pathsOf(
      [
        {
          name: 'items',
          type: 'array',
          fields: [{ name: 'label', type: 'text', localized: true }],
        },
      ],
      { items: [{ label: 'sin id' }, { id: 'r1', label: 'con id' }] },
    )

    expect(paths).toEqual(['items.r1.label'])
  })

  it('accepts a block passed as an object in blockReferences', () => {
    const hero: Block = {
      slug: 'hero',
      fields: [{ name: 'heading', type: 'text', localized: true }],
    }
    const paths = pathsOf(
      [{ name: 'layout', type: 'blocks', blocks: [], blockReferences: [hero] }],
      { layout: [{ id: 'b1', blockType: 'hero', heading: 'Hola' }] },
    )

    expect(paths).toEqual(['layout.b1.heading'])
  })

  it('skips a row whose blockType is unknown', () => {
    const paths = pathsOf(
      [
        {
          name: 'layout',
          type: 'blocks',
          blocks: [
            {
              slug: 'hero',
              fields: [{ name: 'heading', type: 'text', localized: true }],
            },
          ],
        },
      ],
      {
        layout: [
          { id: 'b1', blockType: 'gone', heading: 'Hola' },
          { id: 'b2', blockType: 'hero', heading: 'Adiós' },
        ],
      },
    )

    expect(paths).toEqual(['layout.b2.heading'])
  })

  it('does not emit text fields with hasMany, which store string[]', () => {
    const paths = pathsOf(
      [
        { name: 'tags', type: 'text', localized: true, hasMany: true },
        { name: 'title', type: 'text', localized: true },
      ],
      { tags: ['a', 'b'], title: 'Hola' },
    )

    expect(paths).toEqual(['title'])
  })
})

describe('collectTranslatables exclusion of layout fields', () => {
  const exclude = { translator: 'exclude' }
  const title: Field = { name: 'title', type: 'text', localized: true }
  const kept: Field = { name: 'kept', type: 'text', localized: true }
  const data = { title: 'Hola', kept: 'Sí', meta: { title: 'Hola' } }
  const pathsOf = (fields: Field[]): string[] =>
    collectTranslatables({ fields, data }).map(value => value.path)

  it('skips everything inside an excluded collapsible', () => {
    expect(
      pathsOf([
        { type: 'collapsible', label: 'X', custom: exclude, fields: [title] },
        kept,
      ]),
    ).toEqual(['kept'])
  })

  it('skips everything inside an excluded row', () => {
    expect(pathsOf([{ type: 'row', custom: exclude, fields: [title] }, kept])).toEqual([
      'kept',
    ])
  })

  it('skips everything inside an excluded unnamed group', () => {
    expect(pathsOf([{ type: 'group', custom: exclude, fields: [title] }, kept])).toEqual([
      'kept',
    ])
  })

  it('skips every tab of an excluded tabs field', () => {
    expect(
      pathsOf([
        {
          type: 'tabs',
          custom: exclude,
          tabs: [
            { label: 'A', fields: [title] },
            { name: 'meta', label: 'B', fields: [title] },
          ],
        },
        kept,
      ]),
    ).toEqual(['kept'])
  })

  it('skips an excluded tab, named or unnamed, and walks the others', () => {
    const withTabs = (excluded: 'unnamed' | 'named'): Field[] => [
      {
        type: 'tabs',
        tabs: [
          {
            label: 'A',
            fields: [title],
            ...(excluded === 'unnamed' ? { custom: exclude } : {}),
          },
          {
            name: 'meta',
            label: 'B',
            fields: [title],
            ...(excluded === 'named' ? { custom: exclude } : {}),
          },
        ],
      },
    ]

    expect(pathsOf(withTabs('unnamed'))).toEqual(['meta.title'])
    expect(pathsOf(withTabs('named'))).toEqual(['title'])
  })
})

describe('findLocalizedContainers nesting', () => {
  const hero: Block = {
    slug: 'hero',
    fields: [{ name: 'cards', type: 'array', localized: true, fields: [] }],
  }

  it('finds a container nested in a group', () => {
    expect(
      findLocalizedContainers([
        {
          name: 'agenda',
          type: 'group',
          fields: [{ name: 'days', type: 'array', localized: true, fields: [] }],
        },
      ]),
    ).toEqual(['days'])
  })

  it('finds a container nested in a named tab', () => {
    expect(
      findLocalizedContainers([
        {
          type: 'tabs',
          tabs: [
            {
              name: 'meta',
              label: 'SEO',
              fields: [{ name: 'faq', type: 'array', localized: true, fields: [] }],
            },
          ],
        },
      ]),
    ).toEqual(['faq'])
  })

  it('finds a container nested in an inline block', () => {
    expect(
      findLocalizedContainers([{ name: 'layout', type: 'blocks', blocks: [hero] }]),
    ).toEqual(['cards'])
  })

  it('finds a container nested in a referenced block, by slug or as object', () => {
    const bySlug: Field = {
      name: 'layout',
      type: 'blocks',
      blocks: [],
      blockReferences: ['hero' as never],
    }
    const byObject: Field = { ...bySlug, blockReferences: [hero] }

    expect(findLocalizedContainers([bySlug], [hero])).toEqual(['cards'])
    expect(findLocalizedContainers([byObject])).toEqual(['cards'])
  })

  it('reports a named tab marked localized', () => {
    expect(
      findLocalizedContainers([
        {
          type: 'tabs',
          tabs: [
            { name: 'meta', label: 'SEO', localized: true, fields: [] },
            { label: 'Otra', fields: [] },
          ],
        },
      ]),
    ).toEqual(['meta'])
  })
})

describe('findLocalizedContainers with self-referencing blocks', () => {
  it('terminates when a block references itself and still reports its containers', () => {
    const section: Block = {
      slug: 'section',
      fields: [
        { name: 'cards', type: 'array', localized: true, fields: [] },
        { name: 'children', type: 'blocks', blocks: [], blockReferences: ['section'] },
      ],
    }

    expect(
      findLocalizedContainers(
        [{ name: 'layout', type: 'blocks', blocks: [], blockReferences: ['section'] }],
        [section],
      ),
    ).toEqual(['cards'])
  })
})
