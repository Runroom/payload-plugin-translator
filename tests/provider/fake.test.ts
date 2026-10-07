import { afterEach, describe, expect, it, vi } from 'vitest'

import { fakeProvider } from '../../src/exports/testing.js'

const request = {
  sourceLocale: 'es',
  targetLocale: 'ca',
  instructions: '',
  units: { a: 'Hola' },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('fakeProvider', () => {
  it('answers right away by default', async () => {
    await expect(fakeProvider().translate(request)).resolves.toEqual({ a: '[ca] Hola' })
  })

  it('waits the given delay before answering', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    void fakeProvider({ delayMs: 4_000 }).translate(request).then(settled)

    await vi.advanceTimersByTimeAsync(3_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledWith({ a: '[ca] Hola' })
  })
})
