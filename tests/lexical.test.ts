import { describe, expect, it } from 'vitest'

import type { LexicalNode, LexicalState } from '../src/core/lexical.js'
import {
  extractContainers,
  hasNonTextContent,
  isLexicalState,
  MarkError,
  replaceContainers,
  structureOf,
} from '../src/core/lexical.js'
import { marksMatch } from '../src/core/marks.js'

const text = (value: string, format = 0): LexicalNode => ({
  type: 'text',
  text: value,
  format,
  style: '',
  mode: 'normal',
  detail: 0,
  version: 1,
})

const state: LexicalState = {
  root: {
    type: 'root',
    children: [
      {
        type: 'heading',
        tag: 'h2',
        children: [text('Objetivos')],
      },
      {
        type: 'paragraph',
        children: [
          text('Un coche '),
          text('rojo', 1),
          { type: 'linebreak', version: 1 },
          {
            type: 'link',
            fields: { url: 'https://example.com', newTab: true },
            children: [text('más información')],
          },
        ],
      },
      { type: 'upload', relationTo: 'media', value: 'img-1' },
      {
        type: 'list',
        listType: 'bullet',
        children: [{ type: 'listitem', value: 1, children: [text('Primero')] }],
      },
    ],
  },
}

describe('extractContainers', () => {
  it('serialises each block of inline content with numbered marks', () => {
    expect(extractContainers(state)).toEqual([
      '<1>Objetivos</1>',
      '<1>Un coche </1><2>rojo</2><3/><4><5>más información</5></4>',
      '<1>Primero</1>',
    ])
  })
})

describe('replaceContainers', () => {
  it('rebuilds the tree with the translated text and the original formatting', () => {
    const result = replaceContainers(state, [
      '<1>Goals</1>',
      '<1>A </1><2>red</2><3/><4><5>more information</5></4>',
      '<1>First</1>',
    ])

    const paragraph = result.root.children?.[1]
    expect(paragraph?.children?.[1]).toMatchObject({
      type: 'text',
      text: 'red',
      format: 1,
    })
    expect(paragraph?.children?.[3]).toMatchObject({
      type: 'link',
      fields: { url: 'https://example.com', newTab: true },
    })
    expect(result.root.children?.[2]).toEqual(state.root.children?.[2])
  })

  it('lets the target language reorder the marks', () => {
    const result = replaceContainers(state, [
      '<1>Objectius</1>',
      '<2>Vermell</2><1> un cotxe</1><3/><4><5>més informació</5></4>',
      '<1>Primer</1>',
    ])

    const children = result.root.children?.[1]?.children ?? []
    expect(children.map(node => node.text ?? node.type)).toEqual([
      'Vermell',
      ' un cotxe',
      'linebreak',
      'link',
    ])
  })

  it('does not mutate the source state', () => {
    const before = JSON.stringify(state)
    replaceContainers(state, [
      '<1>a</1>',
      '<1>b</1><2>c</2><3/><4><5>d</5></4>',
      '<1>e</1>',
    ])
    expect(JSON.stringify(state)).toBe(before)
  })

  it('throws MarkError when a mark is missing or duplicated', () => {
    expect(() =>
      replaceContainers(state, ['<1>a</1>', '<1>b</1><3/><4><5>d</5></4>', '<1>e</1>']),
    ).toThrow(MarkError)
    expect(() =>
      replaceContainers(state, [
        '<1>a</1><1>b</1>',
        '<1>b</1><2>c</2><3/><4><5>d</5></4>',
        '<1>e</1>',
      ]),
    ).toThrow(MarkError)
  })

  it('throws MarkError when text appears outside any text mark', () => {
    expect(() =>
      replaceContainers(state, [
        'Goals',
        '<1>b</1><2>c</2><3/><4><5>d</5></4>',
        '<1>e</1>',
      ]),
    ).toThrow(MarkError)
  })

  it('keeps whitespace the model leaves between marks', () => {
    const result = replaceContainers(state, [
      '<1>Goals</1>',
      '<1>A</1> <2>red</2><3/><4><5>car</5></4>',
      '<1>First</1>',
    ])
    expect(result.root.children?.[1]?.children?.[0]).toMatchObject({ text: 'A ' })
  })
})

describe('replaceContainers merges adjacent text', () => {
  const split: LexicalState = {
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', children: [text('Un '), text('coche', 1), text(' rojo')] },
      ],
    },
  }

  it('joins sibling texts left with the same attributes, as Lexical would on save', () => {
    const result = replaceContainers(split, ['<2>Cotxe</2><1>Un </1><3>vermell</3>'])

    expect(result.root.children?.[0]?.children).toEqual([
      text('Cotxe', 1),
      text('Un vermell'),
    ])
  })

  it('keeps sibling texts whose attributes differ', () => {
    const result = replaceContainers(split, ['<1>Un </1><2>cotxe</2><3> vermell</3>'])

    expect(result.root.children?.[0]?.children).toHaveLength(3)
  })
})

describe('marksMatch', () => {
  it('accepts the same marks in another order', () => {
    expect(marksMatch('<1>a</1><2>b</2><3/>', '<2>B</2><1>A</1><3/>')).toBe(true)
  })

  it('rejects missing, extra or malformed marks', () => {
    expect(marksMatch('<1>a</1><2>b</2>', '<1>A</1>')).toBe(false)
    expect(marksMatch('<1>a</1>', '<1>A</1><2>B</2>')).toBe(false)
    expect(marksMatch('<1>a</1>', '<1>A')).toBe(false)
    expect(marksMatch('<1>a</1>', 'A')).toBe(false)
  })

  it('treats plain strings without marks as matching', () => {
    expect(marksMatch('Hola', 'Hello')).toBe(true)
  })
})

const paragraphSource = '<1>Un coche </1><2>rojo</2><3/><4><5>más información</5></4>'

const single: LexicalState = {
  root: { type: 'root', children: [state.root.children![1]!] },
}

const countNodes = (nodes: LexicalNode[]): number =>
  nodes.reduce((total, node) => total + 1 + countNodes(node.children ?? []), 0)

const throwsMarkError = (translated: string): boolean => {
  try {
    replaceContainers(single, [translated])
    return false
  } catch (error) {
    if (error instanceof MarkError) return true
    throw error
  }
}

describe('stricter mark validation', () => {
  it('rejects a void used as a pair and a pair used as a void', () => {
    const voidAsPair = '<1>a</1><2>b</2><3>x</3><4><5>d</5></4>'
    const pairAsVoid = '<1>a</1><2>b</2><3/><4/><5>d</5>'
    expect(throwsMarkError(voidAsPair)).toBe(true)
    expect(throwsMarkError(pairAsVoid)).toBe(true)
    expect(marksMatch(paragraphSource, voidAsPair)).toBe(false)
    expect(marksMatch(paragraphSource, pairAsVoid)).toBe(false)
  })

  it('rejects changed nesting', () => {
    const swapped = '<1>a</1><2>b</2><3/><5><4>d</4></5>'
    expect(marksMatch('<4><5>x</5></4>', '<5><4>y</4></5>')).toBe(false)
    expect(marksMatch(paragraphSource, swapped)).toBe(false)
    expect(throwsMarkError(swapped)).toBe(true)
  })

  it('rejects text placed directly inside a non-text pair', () => {
    const direct = '<1>a</1><2>b</2><3/><4>y</4>'
    expect(marksMatch(paragraphSource, direct)).toBe(false)
    expect(throwsMarkError(direct)).toBe(true)
    expect(marksMatch(paragraphSource, '<1>a</1><2>b</2><3/><4>y<5>d</5></4>')).toBe(
      false,
    )
  })

  it('rejects a void inside a text mark instead of dropping it', () => {
    const inside = '<1>a<3/></1><2>b</2><4><5>d</5></4>'
    expect(marksMatch(paragraphSource, inside)).toBe(false)
    expect(throwsMarkError(inside)).toBe(true)
  })

  it('keeps the space the model leaves after a link or at the start', () => {
    const source: LexicalState = {
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'link', fields: { url: 'x' }, children: [text('enlace')] },
              text(' final'),
            ],
          },
        ],
      },
    }
    const after = replaceContainers(source, ['<1><2>link</2></1> <3>end</3>'])
    expect(after.root.children?.[0]?.children?.[1]).toMatchObject({ text: ' end' })
    const start = replaceContainers(source, [' <3>end</3><1><2>link</2></1>'])
    expect(start.root.children?.[0]?.children?.[0]).toMatchObject({ text: ' end' })
  })

  it('does not take { root: null } for a lexical state', () => {
    expect(isLexicalState({ root: null })).toBe(false)
    expect(isLexicalState({ root: { type: 'root' } })).toBe(true)
  })

  it('copies a state without containers whole when given no translations', () => {
    const uploads: LexicalState = {
      root: {
        type: 'root',
        children: [
          { type: 'upload', relationTo: 'media', value: 'm1' },
          { type: 'horizontalrule' },
        ],
      },
    }

    expect(extractContainers(uploads)).toEqual([])
    expect(hasNonTextContent(uploads)).toBe(true)
    expect(replaceContainers(uploads, [])).toEqual(uploads)
  })

  it('finds no content without text in an empty editor or empty paragraphs', () => {
    const empty = (children: LexicalNode[]): LexicalState => ({
      root: { type: 'root', children },
    })

    expect(hasNonTextContent(empty([]))).toBe(false)
    expect(
      hasNonTextContent(
        empty([
          { type: 'paragraph', children: [] },
          { type: 'paragraph', children: [{ type: 'linebreak' }, text(' ')] },
        ]),
      ),
    ).toBe(false)
  })

  it('throws when there are more translations than containers', () => {
    expect(() =>
      replaceContainers(state, [
        '<1>a</1>',
        '<1>b</1><2>c</2><3/><4><5>d</5></4>',
        '<1>e</1>',
        '<1>sobra</1>',
      ]),
    ).toThrow(MarkError)
  })
})

const emptyLink: LexicalState = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [text('hola '), { type: 'link', fields: { url: 'x' }, children: [] }],
      },
    ],
  },
}

describe('empty links', () => {
  it('round-trips an empty link unchanged', () => {
    const [source] = extractContainers(emptyLink)
    expect(source).toBe('<1>hola </1><2/>')
    expect(replaceContainers(emptyLink, [source!])).toEqual(emptyLink)
  })

  it('rejects a translation that turns the empty link into a text pair', () => {
    expect(marksMatch('<1>hola </1><2/>', '<1>hola </1><2>x</2>')).toBe(false)
    expect(() => replaceContainers(emptyLink, ['<1>hola </1><2>x</2>'])).toThrow(
      MarkError,
    )
  })

  it('translates the text around an empty link', () => {
    const result = replaceContainers(emptyLink, ['<1>hello </1><2/>'])
    expect(result.root.children?.[0]?.children).toMatchObject([
      { type: 'text', text: 'hello ' },
      { type: 'link', children: [] },
    ])
  })
})

describe('marksMatch and replaceContainers agree', () => {
  const valid = [
    paragraphSource,
    '<2>b</2><1>a</1><3/><4><5>d</5></4>',
    '<1>a</1> <2>b</2><3/><4><5>d</5></4>',
    '<4><5>d</5></4><3/><2>b</2><1>a</1>',
  ]
  const invalid = [
    '<1>a</1><2>b</2><3/>',
    '<1>a</1><1>b</1><2>b</2><3/><4><5>d</5></4>',
    '<1>a</1><2>b</2><3/><4><5>d</5>',
    'a<1>a</1><2>b</2><3/><4><5>d</5></4>',
    '<1>a</1><2>b</2><3/><5><4>d</4></5>',
    '<1>a</1><2>b</2><3/><4>y</4>',
    '<1>a<3/></1><2>b</2><4><5>d</5></4>',
    '<1>a</1><2>b</2><3>x</3><4><5>d</5></4>',
    '<1>a</1><2>b</2><3/><4/><5>d</5>',
    '<1>a</1><2>b</2><3/><4><5><1>d</1></5></4>',
    'Hello',
  ]
  const emptyLinkInvalid = ['<1>hola </1><2>x</2>']

  it('never throws on a translation marksMatch accepts, and keeps every node but emptied texts', () => {
    for (const translated of valid) {
      expect(marksMatch(paragraphSource, translated)).toBe(true)
      const result = replaceContainers(single, [translated])
      expect(countNodes(result.root.children?.[0]?.children ?? [])).toBe(5)
    }
  })

  it('drops a text mark the translation leaves empty and does not throw', () => {
    const translated = '<1>a</1><2></2><3/><4><5>d</5></4>'
    expect(marksMatch(paragraphSource, translated)).toBe(true)
    const result = replaceContainers(single, [translated])
    expect(countNodes(result.root.children?.[0]?.children ?? [])).toBe(4)
  })

  it('rejects in marksMatch whatever parse rejects', () => {
    for (const translated of emptyLinkInvalid) {
      expect(marksMatch('<1>hola </1><2/>', translated), translated).toBe(false)
    }
    for (const translated of invalid) {
      expect(marksMatch(paragraphSource, translated), translated).toBe(false)
    }
  })

  it('agrees on every case in both directions', () => {
    for (const translated of [...valid, ...invalid]) {
      if (marksMatch(paragraphSource, translated)) {
        expect(throwsMarkError(translated), translated).toBe(false)
      }
      if (throwsMarkError(translated)) {
        expect(marksMatch(paragraphSource, translated), translated).toBe(false)
      }
    }
  })
})

describe('literal marks and ampersands in the text', () => {
  const paragraph = (...children: LexicalNode[]): LexicalState => ({
    root: { type: 'root', children: [{ type: 'paragraph', children }] },
  })

  it.each([
    'Edad <18> años',
    'Cierra con </2>',
    'Vacío <3/> aquí',
    'Ya escapado &lt;',
    'Tom & Jerry',
  ])('escapes %j when serialising and restores it when parsing', value => {
    const source = paragraph(text(value))
    const [unit] = extractContainers(source)

    expect(unit).not.toMatch(/<\d+>.*<\d+\/?>|<\/\d+>.*<\/\d+>/)
    expect(marksMatch(unit!, unit!)).toBe(true)
    expect(replaceContainers(source, [unit!])).toEqual(source)
  })

  it('keeps a stray < the model returns without forming a mark as plain text', () => {
    const source = paragraph(text('a'))

    const result = replaceContainers(source, ['<1>b < c</1>'])

    expect(result.root.children?.[0]?.children?.[0]).toMatchObject({ text: 'b < c' })
  })

  it('does not take a translated entity for a mark', () => {
    const source = paragraph(text('Edad <18> años'))
    const [unit] = extractContainers(source)

    expect(unit).toBe('<1>Edad &lt;18> años</1>')
    expect(marksMatch(unit!, '<1>Age &lt;18> years</1>')).toBe(true)
    expect(
      replaceContainers(source, ['<1>Age &lt;18> years</1>']).root.children?.[0]
        ?.children?.[0],
    ).toMatchObject({ text: 'Age <18> years' })
  })
})

describe('blocks inside lexical', () => {
  const inlineBlock = (fields: Record<string, unknown>): LexicalNode => ({
    type: 'inlineBlock',
    fields,
    version: 1,
  })
  const withInline = (fields: Record<string, unknown>): LexicalState => ({
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [text('Antes '), inlineBlock(fields), text(' después')],
        },
      ],
    },
  })
  const block = (fields: Record<string, unknown>): LexicalState => ({
    root: {
      type: 'root',
      children: [
        { type: 'block', fields, format: '', version: 2 },
        { type: 'paragraph', children: [text('Hola')] },
      ],
    },
  })

  it('translates the text around an inline block, copying the block from the source', () => {
    const fields = { id: 'b1', blockType: 'badge', label: 'Nuevo' }
    const source = withInline(fields)

    expect(extractContainers(source)).toEqual(['<1>Antes </1><2/><3> después</3>'])
    const result = replaceContainers(source, ['<1>Before </1><2/><3> after</3>'])
    expect(result.root.children?.[0]?.children).toMatchObject([
      { type: 'text', text: 'Before ' },
      { type: 'inlineBlock', fields },
      { type: 'text', text: ' after' },
    ])
  })

  it('changes the structure fingerprint when block fields change, not when their id or key order does', () => {
    const base = structureOf(
      block({ id: 'b1', blockType: 'cta', url: '/a', label: 'Ir' }),
    )

    expect(
      structureOf(block({ id: 'b1', blockType: 'cta', url: '/b', label: 'Ir' })),
    ).not.toEqual(base)
    expect(
      structureOf(block({ label: 'Ir', url: '/a', blockType: 'cta', id: 'b2' })),
    ).toEqual(base)
    expect(
      structureOf(withInline({ id: 'x', blockType: 'badge', label: 'A' })),
    ).not.toEqual(structureOf(withInline({ id: 'x', blockType: 'badge', label: 'B' })))
  })
})
