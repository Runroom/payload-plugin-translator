import { describe, expect, it } from 'vitest'

import { isTranslatorWrite, TRANSLATOR_WRITE_CONTEXT } from '../src/index.js'

describe('isTranslatorWrite', () => {
  it('recognises the context the translator writes with', () => {
    expect(isTranslatorWrite({ ...TRANSLATOR_WRITE_CONTEXT, other: 1 })).toBe(true)
  })

  it('rejects any other context', () => {
    expect(isTranslatorWrite({})).toBe(false)
    expect(isTranslatorWrite(undefined)).toBe(false)
    expect(isTranslatorWrite({ runroomTranslator: 'yes' })).toBe(false)
  })
})
