import { describe, expect, it } from 'vitest'

import { buildUpdateData } from '../../src/core/apply.js'

const targetDoc = {
  id: 'evt-1',
  title: null,
  slug: 'curso',
  agenda: {
    title: null,
    days: [
      {
        id: 'd1',
        date: '2026-11-01',
        label: null,
        activities: [
          { id: 'a1', startTime: '09:00', title: null, speakers: ['p1'] },
          { id: 'a2', startTime: '10:00', title: null, speakers: [] },
        ],
      },
    ],
  },
}

describe('buildUpdateData', () => {
  it('only sends the top-level keys that hold a translated field', () => {
    const data = buildUpdateData({
      targetDoc,
      writes: [{ segments: [{ key: 'title' }], value: 'Course' }],
    })

    expect(data).toEqual({ title: 'Course' })
  })

  it('keeps every row id and non-localized value inside nested arrays', () => {
    const data = buildUpdateData({
      targetDoc,
      writes: [
        {
          segments: [
            { key: 'agenda' },
            { key: 'days', rowId: 'd1' },
            { key: 'activities', rowId: 'a2' },
            { key: 'title' },
          ],
          value: 'Closing',
        },
      ],
    })

    expect(data.agenda).toEqual({
      title: null,
      days: [
        {
          id: 'd1',
          date: '2026-11-01',
          label: null,
          activities: [
            { id: 'a1', startTime: '09:00', title: null, speakers: ['p1'] },
            { id: 'a2', startTime: '10:00', title: 'Closing', speakers: [] },
          ],
        },
      ],
    })
  })

  it('does not mutate the target document', () => {
    const before = JSON.stringify(targetDoc)
    buildUpdateData({
      targetDoc,
      writes: [{ segments: [{ key: 'agenda' }, { key: 'title' }], value: 'Programme' }],
    })
    expect(JSON.stringify(targetDoc)).toBe(before)
  })

  it('creates a missing group on the way to a field', () => {
    const data = buildUpdateData({
      targetDoc: { meta: null },
      writes: [{ segments: [{ key: 'meta' }, { key: 'description' }], value: 'Desc' }],
    })
    expect(data).toEqual({ meta: { description: 'Desc' } })
  })

  it('throws when a row no longer exists in the target', () => {
    expect(() =>
      buildUpdateData({
        targetDoc,
        writes: [
          {
            segments: [
              { key: 'agenda' },
              { key: 'days', rowId: 'gone' },
              { key: 'label' },
            ],
            value: 'Day',
          },
        ],
      }),
    ).toThrow(/gone/)
  })

  it('writes multiple fields on the same top-level key', () => {
    const data = buildUpdateData({
      targetDoc,
      writes: [
        { segments: [{ key: 'agenda' }, { key: 'title' }], value: 'Programme' },
        {
          segments: [
            { key: 'agenda' },
            { key: 'days', rowId: 'd1' },
            { key: 'activities', rowId: 'a1' },
            { key: 'title' },
          ],
          value: 'Opening',
        },
      ],
    })

    expect((data.agenda as Record<string, unknown>).title).toBe('Programme')
    const days = (data.agenda as Record<string, unknown>).days as Array<
      Record<string, unknown>
    >
    const day = days[0] as Record<string, unknown>
    const activities = day.activities as Array<Record<string, unknown>>
    const activity = activities[0] as Record<string, unknown>
    expect(activity.title).toBe('Opening')
  })

  it('throws when a segment without rowId points to an array', () => {
    expect(() =>
      buildUpdateData({
        targetDoc,
        writes: [
          {
            segments: [{ key: 'agenda' }, { key: 'days' }, { key: 'title' }],
            value: 'Day Title',
          },
        ],
      }),
    ).toThrow(/days is not an object/)
  })

  it('throws when a segment with rowId points to a non-array', () => {
    expect(() =>
      buildUpdateData({
        targetDoc: { nested: { title: 'not-an-array' } },
        writes: [
          {
            segments: [{ key: 'nested' }, { key: 'title', rowId: 'x' }, { key: 'label' }],
            value: 'Label',
          },
        ],
      }),
    ).toThrow(/title is not an array/)
  })
})
