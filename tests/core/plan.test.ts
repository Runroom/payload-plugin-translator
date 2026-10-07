import { describe, expect, it } from 'vitest'

import { fingerprint, fingerprintOf } from '../../src/core/fingerprint.js'
import { countChanged, countMissing, planTranslation } from '../../src/core/plan.js'
import type { TranslatableValue } from '../../src/core/types.js'
import { unitsOf } from '../../src/core/units.js'

const field = (path: string, value: unknown): TranslatableValue => ({
  path,
  segments: [{ key: path }],
  kind: 'text',
  value,
})

const hashOf = (value: string): string => fingerprint(unitsOf(field('x', value)))!

describe('planTranslation', () => {
  it('translates fields whose target is empty', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso')],
      target: [field('title', null)],
      overwriteEdited: false,
    })

    expect(plan.translate.map(value => value.path)).toEqual(['title'])
  })

  it('skips empty source fields without touching the target', () => {
    const plan = planTranslation({
      source: [field('title', '  ')],
      target: [field('title', 'Course')],
      overwriteEdited: false,
    })

    expect(plan.translate).toEqual([])
    expect(plan.kept).toEqual([])
  })

  it('leaves untouched a field still holding its last output when the source did not change', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso')],
      target: [field('title', 'Course')],
      previous: { title: { source: hashOf('Curso'), output: hashOf('Course') } },
      overwriteEdited: false,
    })

    expect(plan.translate).toEqual([])
    expect(plan.hashes.title).toEqual({
      source: hashOf('Curso'),
      output: hashOf('Course'),
    })
  })

  it('re-translates a field still holding its last output when the source changed', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso nuevo')],
      target: [field('title', 'Course')],
      previous: { title: { source: hashOf('Curso'), output: hashOf('Course') } },
      overwriteEdited: false,
    })

    expect(plan.translate.map(value => value.path)).toEqual(['title'])
  })

  it('keeps a target someone edited by hand, recording the source it was checked against', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso nuevo')],
      target: [field('title', 'Corrected course')],
      previous: { title: { source: hashOf('Curso'), output: hashOf('Course') } },
      overwriteEdited: false,
    })

    expect(plan.translate).toEqual([])
    expect(plan.kept).toEqual(['title'])
    expect(plan.hashes.title).toEqual({ source: hashOf('Curso nuevo'), output: null })
  })

  it('keeps a target that was never ours, such as one written by an import', () => {
    const plan = planTranslation({
      source: [field('shortDescription', 'Descripción')],
      target: [field('shortDescription', 'Descripció importada')],
      overwriteEdited: false,
    })

    expect(plan.kept).toEqual(['shortDescription'])
  })

  it('overwrites edited targets when asked to', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso nuevo')],
      target: [field('title', 'Corrected course')],
      previous: { title: { source: hashOf('Curso'), output: hashOf('Course') } },
      overwriteEdited: true,
    })

    expect(plan.translate.map(value => value.path)).toEqual(['title'])
  })

  it('translates a new agenda row while leaving the existing ones alone', () => {
    const plan = planTranslation({
      source: [
        field('agenda.days.d1.label', 'Día 1'),
        field('agenda.days.d2.label', 'Día 2'),
      ],
      target: [
        field('agenda.days.d1.label', 'Day 1'),
        field('agenda.days.d2.label', null),
      ],
      previous: {
        'agenda.days.d1.label': { source: hashOf('Día 1'), output: hashOf('Day 1') },
      },
      overwriteEdited: false,
    })

    expect(plan.translate.map(value => value.path)).toEqual(['agenda.days.d2.label'])
  })

  it('does not translate a field with previous.output === null (kept from a prior pass) when target has a value and source changed', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso nuevo')],
      target: [field('title', 'Edited by hand')],
      previous: { title: { source: hashOf('Curso'), output: null } },
      overwriteEdited: false,
    })

    expect(plan.translate).toEqual([])
    expect(plan.kept).toEqual(['title'])
    expect(plan.hashes.title).toEqual({ source: hashOf('Curso nuevo'), output: null })
  })

  it('translates a source field that has no entry in target at all (new row)', () => {
    const plan = planTranslation({
      source: [
        field('agenda.days.d1.label', 'Día 1'),
        field('agenda.days.d2.label', 'Día 2'),
      ],
      target: [field('agenda.days.d1.label', 'Day 1')],
      previous: {
        'agenda.days.d1.label': { source: hashOf('Día 1'), output: hashOf('Day 1') },
      },
      overwriteEdited: false,
    })

    expect(plan.translate.map(value => value.path)).toEqual(['agenda.days.d2.label'])
  })

  it('richText fingerprint is consistent when JSON structure changes but content does not', () => {
    const lexicalState = {
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'text',
                text: 'Hello',
                format: 0,
                style: '',
                mode: 'normal',
                detail: 0,
                version: 1,
              },
            ],
          },
        ],
      },
    }

    const richTextField: TranslatableValue = {
      path: 'description',
      segments: [{ key: 'description' }],
      kind: 'richText',
      value: lexicalState,
    }

    const hash1 = fingerprint(unitsOf(richTextField))

    const modifiedLexicalState = {
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'text',
                text: 'Hello',
                format: 0,
                style: '',
                mode: 'normal',
                detail: 0,
                version: 1,
                direction: 'ltr',
              },
            ],
          },
        ],
      },
    }

    const richTextFieldModified: TranslatableValue = {
      path: 'description',
      segments: [{ key: 'description' }],
      kind: 'richText',
      value: modifiedLexicalState,
    }

    const hash2 = fingerprint(unitsOf(richTextFieldModified))

    expect(hash1).toEqual(hash2)

    const changedLexicalState = {
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'text',
                text: 'Goodbye',
                format: 0,
                style: '',
                mode: 'normal',
                detail: 0,
                version: 1,
              },
            ],
          },
        ],
      },
    }

    const richTextFieldChanged: TranslatableValue = {
      path: 'description',
      segments: [{ key: 'description' }],
      kind: 'richText',
      value: changedLexicalState,
    }

    const hash3 = fingerprint(unitsOf(richTextFieldChanged))

    expect(hash3).not.toEqual(hash1)
  })
})

describe('countChanged', () => {
  it('counts the source fields that changed or appeared since the last translation', () => {
    const hashes = {
      title: { source: hashOf('Curso'), output: hashOf('Course') },
      subtitle: { source: hashOf('Sub'), output: hashOf('Sub') },
    }

    expect(
      countChanged({
        source: [field('title', 'Curso'), field('subtitle', 'Sub')],
        hashes,
      }),
    ).toBe(0)
    expect(
      countChanged({
        source: [field('title', 'Curso 2'), field('subtitle', 'Sub')],
        hashes,
      }),
    ).toBe(1)
    expect(
      countChanged({
        source: [
          field('title', 'Curso 2'),
          field('subtitle', 'Sub'),
          field('meta.description', 'Desc'),
        ],
        hashes,
      }),
    ).toBe(2)
  })

  it('ignores empty source fields', () => {
    expect(countChanged({ source: [field('title', '')], hashes: {} })).toBe(0)
  })
})

describe('countMissing', () => {
  it('counts the source fields that are empty or absent in the target', () => {
    expect(
      countMissing({
        source: [
          field('title', 'Curso'),
          field('subtitle', 'Sub'),
          field('lead', 'Intro'),
        ],
        target: [field('title', 'Course'), field('subtitle', '  ')],
      }),
    ).toBe(2)
  })

  it('ignores fields that are empty in the source too', () => {
    expect(
      countMissing({ source: [field('title', '')], target: [field('title', null)] }),
    ).toBe(0)
  })
})

describe('fingerprintOf a richText', () => {
  const text = (value: string, extra: Record<string, unknown> = {}): object => ({
    type: 'text',
    text: value,
    format: 0,
    ...extra,
  })
  const paragraph = (
    children: object[],
    extra: Record<string, unknown> = {},
  ): object => ({
    type: 'paragraph',
    children,
    ...extra,
  })
  const link = (url: string): object => ({
    type: 'link',
    fields: { url, newTab: false, linkType: 'custom' },
    children: [text('aquí')],
  })
  const richText = (...children: object[]): TranslatableValue => ({
    path: 'description',
    segments: [{ key: 'description' }],
    kind: 'richText',
    value: { root: { type: 'root', children } },
  })
  const base = richText(paragraph([text('Más info '), link('https://a.example')]))

  it('changes when a link url changes', () => {
    const moved = richText(paragraph([text('Más info '), link('https://b.example')]))

    expect(fingerprintOf(moved)).not.toEqual(fingerprintOf(base))
  })

  it('ignores the encoding layers Payload adds to a url on every save', () => {
    const once = richText(
      paragraph([text('Más info '), link(encodeURIComponent('example.com/a b'))]),
    )
    const twice = richText(
      paragraph([
        text('Más info '),
        link(encodeURIComponent(encodeURIComponent('example.com/a b'))),
      ]),
    )
    const other = richText(
      paragraph([text('Más info '), link(encodeURIComponent('example.com/c'))]),
    )

    expect(fingerprintOf(twice)).toEqual(fingerprintOf(once))
    expect(fingerprintOf(other)).not.toEqual(fingerprintOf(once))
  })

  it('keeps a url with a stray percent sign comparable', () => {
    const broken = richText(
      paragraph([text('Más info '), link('https://a.example/100%')]),
    )

    expect(fingerprintOf(broken)).toEqual(fingerprintOf(broken))
    expect(fingerprintOf(broken)).not.toEqual(fingerprintOf(base))
  })

  it('changes when the format of a text node changes', () => {
    const bold = richText(
      paragraph([text('Más info ', { format: 1 }), link('https://a.example')]),
    )

    expect(fingerprintOf(bold)).not.toEqual(fingerprintOf(base))
  })

  it('changes when an upload is added', () => {
    const withUpload = richText(
      paragraph([text('Más info '), link('https://a.example')]),
      { type: 'upload', relationTo: 'media', value: 'm1', version: 3 },
    )

    expect(fingerprintOf(withUpload)).not.toEqual(fingerprintOf(base))
  })

  it('ignores the keys Lexical normalizes', () => {
    const normalized = richText(
      paragraph(
        [
          text('Más info ', { version: 1, detail: 0, mode: 'normal', style: '' }),
          link('https://a.example'),
        ],
        { direction: 'ltr', version: 1, indent: 0, textFormat: 0, textStyle: '' },
      ),
    )

    expect(fingerprintOf(normalized)).toEqual(fingerprintOf(base))
  })

  it('does not change the units sent to the model', () => {
    expect(unitsOf(base)).toEqual(['<1>Más info </1><2><3>aquí</3></2>'])
  })

  const list = (
    listType: string,
    extra: Record<string, unknown>,
    item: Record<string, unknown> = {},
  ): TranslatableValue =>
    richText({
      type: 'list',
      listType,
      tag: listType === 'number' ? 'ol' : 'ul',
      ...extra,
      children: [{ type: 'listitem', value: 1, ...item, children: [text('Uno')] }],
    })
  const hola = richText(paragraph([text('Hola')]))

  it.each([
    ['alignment', hola, richText(paragraph([text('Hola')], { format: 'center' }))],
    ['indent', hola, richText(paragraph([text('Hola')], { indent: 1 }))],
    ['list start', list('number', { start: 1 }), list('number', { start: 3 })],
    [
      'checklist checked',
      list('check', {}, { checked: false }),
      list('check', {}, { checked: true }),
    ],
    ['text style', hola, richText(paragraph([text('Hola', { style: 'color: red' })]))],
    [
      'link newTab',
      base,
      richText(
        paragraph([
          text('Más info '),
          {
            type: 'link',
            fields: { url: 'https://a.example', newTab: true, linkType: 'custom' },
            children: [text('aquí')],
          },
        ]),
      ),
    ],
  ])('changes when the %s copied from the source changes', (_, before, after) => {
    expect(fingerprintOf(after)).not.toEqual(fingerprintOf(before))
  })

  it('counts custom link fields, whatever the order of their keys', () => {
    const withRel = (rel: string, first: boolean): TranslatableValue =>
      richText(
        paragraph([
          text('Más info '),
          {
            type: 'link',
            fields: first
              ? { rel, url: 'https://a.example', newTab: false, linkType: 'custom' }
              : { url: 'https://a.example', newTab: false, linkType: 'custom', rel },
            children: [text('aquí')],
          },
        ]),
      )

    expect(fingerprintOf(withRel('nofollow', true))).toEqual(
      fingerprintOf(withRel('nofollow', false)),
    )
    expect(fingerprintOf(withRel('sponsored', true))).not.toEqual(
      fingerprintOf(withRel('nofollow', true)),
    )
  })

  it('ignores a change of only version or direction', () => {
    const rewritten = richText(
      paragraph([text('Más info ', { version: 2 }), link('https://a.example')], {
        direction: 'rtl',
        version: 2,
      }),
    )

    expect(fingerprintOf(rewritten)).toEqual(fingerprintOf(base))
  })

  it('fingerprints a richText with only an upload by its structure', () => {
    const upload = (value: string): TranslatableValue =>
      richText({ type: 'upload', relationTo: 'media', value, fields: null })

    expect(fingerprintOf(upload('m1'))).not.toBeNull()
    expect(fingerprintOf(upload('m2'))).not.toEqual(fingerprintOf(upload('m1')))
    expect(fingerprintOf({ ...upload('m1'), value: null })).toBeNull()
  })

  it('still has no fingerprint when empty or with only empty paragraphs', () => {
    expect(fingerprintOf(richText())).toBeNull()
    expect(fingerprintOf(richText(paragraph([]), paragraph([text('  ')])))).toBeNull()
  })
})

describe('planTranslation with a richText without text', () => {
  const uploadOnly = (path: string, value: unknown): TranslatableValue => ({
    path,
    segments: [{ key: path }],
    kind: 'richText',
    value,
  })
  const state = {
    root: {
      type: 'root',
      children: [
        { type: 'upload', relationTo: 'media', value: 'm1' },
        { type: 'horizontalrule' },
      ],
    },
  }

  it('copies it to an empty target and leaves it once the target holds it', () => {
    const first = planTranslation({
      source: [uploadOnly('gallery', state)],
      target: [uploadOnly('gallery', null)],
      overwriteEdited: false,
    })
    expect(first.translate.map(value => value.path)).toEqual(['gallery'])

    const hash = fingerprintOf(uploadOnly('gallery', state))!
    const again = planTranslation({
      source: [uploadOnly('gallery', state)],
      target: [uploadOnly('gallery', state)],
      previous: { gallery: { source: hash, output: hash } },
      overwriteEdited: false,
    })
    expect(again.translate).toEqual([])
  })

  it('counts it as changed and as missing like any other field', () => {
    const source = [uploadOnly('gallery', state)]

    expect(countChanged({ source, hashes: {} })).toBe(1)
    expect(countMissing({ source, target: [uploadOnly('gallery', null)] })).toBe(1)
  })
})

describe('planTranslation with overwriteEdited', () => {
  it('translates again a field that would otherwise be kept as edited by hand', () => {
    const plan = planTranslation({
      source: [field('title', 'Curso')],
      target: [field('title', 'Curs corregit')],
      previous: { title: { source: hashOf('Curso'), output: hashOf('Curs') } },
      overwriteEdited: true,
    })

    expect(plan.translate.map(value => value.path)).toEqual(['title'])
    expect(plan.kept).toEqual([])
  })

  it('leaves alone a field whose source and output are unchanged', () => {
    const previous = { title: { source: hashOf('Curso'), output: hashOf('Course') } }
    const plan = planTranslation({
      source: [field('title', 'Curso')],
      target: [field('title', 'Course')],
      previous,
      overwriteEdited: true,
    })

    expect(plan.translate).toEqual([])
    expect(plan.hashes).toEqual(previous)
  })
})

describe('planTranslation when the source is emptied and filled again', () => {
  it('keeps the old translation as its own, so the refilled source is translated again', () => {
    const translated = {
      title: { source: hashOf('Curso'), output: hashOf('[ca] Curso') },
    }

    const emptied = planTranslation({
      source: [field('title', '')],
      target: [field('title', '[ca] Curso')],
      previous: translated,
      overwriteEdited: false,
    })
    expect(emptied.translate).toEqual([])
    expect(emptied.hashes).toEqual(translated)

    const refilled = planTranslation({
      source: [field('title', 'Curso nuevo')],
      target: [field('title', '[ca] Curso')],
      previous: emptied.hashes,
      overwriteEdited: false,
    })
    expect(refilled.translate.map(value => value.path)).toEqual(['title'])
    expect(refilled.kept).toEqual([])
  })
})
