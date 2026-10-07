import { describe, expect, it, vi } from 'vitest'

import { MarkError } from '../../src/core/lexical.js'
import { marksMatch } from '../../src/core/marks.js'
import { translateUnits } from '../../src/core/translateUnits.js'
import { fakeProvider } from '../../src/exports/testing.js'
import type { TranslationProvider } from '../../src/provider/types.js'

const base = { sourceLocale: 'es', targetLocale: 'ca', instructions: '' }

const upperCased = (units: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(units).map(([key, value]) => [key, value.toUpperCase()]),
  )

const suffixed = (units: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(units).map(([key, value]) => [key, `${value}-ca`]))

describe('translateUnits', () => {
  it('sends opaque keys and maps the reply back to the unit ids', async () => {
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) =>
      upperCased(units),
    )

    const result = await translateUnits({
      ...base,
      provider: { translate },
      units: new Map([
        ['title', 'curso'],
        ['syllabus#0', '<1>hola</1>'],
      ]),
    })

    expect(Object.keys(translate.mock.calls[0]![0].units)).toEqual(['u0', 'u1'])
    expect(result.get('title')).toBe('CURSO')
    expect(result.get('syllabus#0')).toBe('<1>HOLA</1>')
  })

  it('splits large inputs into several requests', async () => {
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) => units)
    const units = new Map(
      Array.from({ length: 90 }, (_, index) => [`f${index}`, 'texto']),
    )

    await translateUnits({ ...base, provider: { translate }, units })

    expect(translate.mock.calls.length).toBeGreaterThan(1)
  })

  it('calls onBatch after every batch it translates', async () => {
    const order: string[] = []
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) => {
      order.push('translate')
      return units
    })
    const units = new Map(
      Array.from({ length: 90 }, (_, index) => [`f${index}`, 'texto']),
    )

    await translateUnits({
      ...base,
      provider: { translate },
      units,
      onBatch: async () => {
        order.push('batch')
      },
    })

    expect(translate.mock.calls.length).toBeGreaterThan(1)
    expect(order).toEqual(translate.mock.calls.flatMap(() => ['translate', 'batch']))
  })

  it('retries once the units whose marks came back broken', async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce({ u0: '<1>Hola', u1: 'Curs' })
      .mockResolvedValueOnce({ u0: '<1>Hola</1>' })
    const provider: TranslationProvider = { translate }

    const result = await translateUnits({
      ...base,
      provider,
      units: new Map([
        ['syllabus#0', '<1>Hola</1>'],
        ['title', 'Curso'],
      ]),
    })

    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]![0].units).toEqual({ u0: '<1>Hola</1>' })
    expect(result.get('syllabus#0')).toBe('<1>Hola</1>')
    expect(result.get('title')).toBe('Curs')
  })

  it('fails naming the unit when the marks are still broken after the retry', async () => {
    const provider: TranslationProvider = {
      translate: vi.fn().mockResolvedValue({ u0: 'Hola' }),
    }

    await expect(
      translateUnits({
        ...base,
        provider,
        units: new Map([['syllabus#0', '<1>Hola</1>']]),
      }),
    ).rejects.toThrow(MarkError)
    await expect(
      translateUnits({
        ...base,
        provider,
        units: new Map([['syllabus#0', '<1>Hola</1>']]),
      }),
    ).rejects.toThrow(/syllabus#0/)
  })

  it('works end to end with the fake provider, marks included', async () => {
    const result = await translateUnits({
      ...base,
      provider: fakeProvider(),
      units: new Map([
        ['title', 'Curso'],
        ['syllabus#0', '<1>Un </1><2><3>enlace</3></2>'],
      ]),
    })

    expect(result.get('title')).toBe('[ca] Curso')
    expect(result.get('syllabus#0')).toBe('<1>[ca] Un </1><2><3>enlace</3></2>')
  })

  it('maps each id to the translation of its own value across batches', async () => {
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) =>
      suffixed(units),
    )
    const units = new Map(
      Array.from({ length: 90 }, (_, index) => [`f${index}`, `texto ${index}`]),
    )

    const result = await translateUnits({ ...base, provider: { translate }, units })

    for (const [id, text] of units) expect(result.get(id)).toBe(`${text}-ca`)
    for (const [request] of translate.mock.calls) {
      expect(Object.keys(request.units).length).toBeLessThanOrEqual(40)
    }
  })

  it('splits by characters even with fewer than 40 units', async () => {
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) => units)
    const units = new Map(
      Array.from({ length: 5 }, (_, index) => [`f${index}`, 'x'.repeat(5000)]),
    )

    await translateUnits({ ...base, provider: { translate }, units })

    expect(translate.mock.calls.length).toBeGreaterThan(1)
    for (const [request] of translate.mock.calls) {
      const values = Object.values(request.units)
      const chars = values.reduce((sum, value) => sum + value.length, 0)
      expect(values.length === 1 || chars <= 12_000).toBe(true)
    }
  })

  it('treats a key missing from the reply as broken and retries it', async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce({ u1: 'Curs' })
      .mockResolvedValueOnce({ u0: 'Títol' })

    const result = await translateUnits({
      ...base,
      provider: { translate },
      units: new Map([
        ['a', 'Titulo'],
        ['b', 'Curso'],
      ]),
    })

    expect(translate.mock.calls[1]![0].units).toEqual({ u0: 'Titulo' })
    expect(result.get('a')).toBe('Títol')
  })

  it('fails naming the unit when a key stays missing after the retry', async () => {
    const provider: TranslationProvider = {
      translate: vi.fn().mockResolvedValue({}),
    }

    await expect(
      translateUnits({ ...base, provider, units: new Map([['title', 'Curso']]) }),
    ).rejects.toThrow(/title/)
  })

  it('treats a blank answer for a plain text unit as broken and retries it', async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce({ u0: '  ', u1: 'Curs' })
      .mockResolvedValueOnce({ u0: 'Títol' })

    const result = await translateUnits({
      ...base,
      provider: { translate },
      units: new Map([
        ['a', 'Titulo'],
        ['b', 'Curso'],
      ]),
      withMarks: () => false,
    })

    expect(translate.mock.calls[1]![0].units).toEqual({ u0: 'Titulo' })
    expect(result.get('a')).toBe('Títol')
  })

  it('fails with MarkError when a plain text unit stays blank after the retry', async () => {
    const translate = vi.fn().mockResolvedValue({ u0: '' })

    await expect(
      translateUnits({
        ...base,
        provider: { translate },
        units: new Map([['title', 'Curso']]),
        withMarks: () => false,
      }),
    ).rejects.toThrow(MarkError)
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('does not call the provider without units', async () => {
    const translate = vi.fn()

    const result = await translateUnits({
      ...base,
      provider: { translate },
      units: new Map(),
    })

    expect(result.size).toBe(0)
    expect(translate).not.toHaveBeenCalled()
  })

  it.each(['<1/>', '<1> <2>x</2></1>'])(
    'the fake provider keeps the marks of %s valid',
    async source => {
      const result = await translateUnits({
        ...base,
        provider: fakeProvider(),
        units: new Map([['u', source]]),
      })

      expect(marksMatch(source, result.get('u')!)).toBe(true)
    },
  )

  it('the fake provider prefixes the first text leaf with content', async () => {
    const result = await translateUnits({
      ...base,
      provider: fakeProvider(),
      units: new Map([['u', '<1> <2>x</2></1>']]),
    })

    expect(result.get('u')).toBe('<1> <2>[ca] x</2></1>')
  })
})

// The model drops the literal `<2>` from the plain text and keeps the richText mark.
const strippingLiteralMarks = (units: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(units).map(([key, value]) => [
      key,
      value.startsWith('<1>') ? value : value.replace(/<\d+>/, ''),
    ]),
  )

const unmarked = (units: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(units).map(key => [key, 'sin marcas']))

describe('translateUnits and literal marks in plain text', () => {
  it('checks marks only on the units it is told carry them', async () => {
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) =>
      strippingLiteralMarks(units),
    )

    const result = await translateUnits({
      ...base,
      provider: { translate },
      units: new Map([
        ['title', 'Edad <2> años'],
        ['body#0', '<1>hola</1>'],
      ]),
      withMarks: id => id.includes('#'),
    })

    expect(result.get('title')).toBe('Edad  años')
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('still rejects a rich text unit whose marks the model broke', async () => {
    const translate = vi.fn(async ({ units }: { units: Record<string, string> }) =>
      unmarked(units),
    )

    await expect(
      translateUnits({
        ...base,
        provider: { translate },
        units: new Map([['body#0', '<1>hola</1>']]),
        withMarks: id => id.includes('#'),
      }),
    ).rejects.toBeInstanceOf(MarkError)
  })
})
