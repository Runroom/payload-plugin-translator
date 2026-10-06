import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { OpenAIClientLike } from '../src/exports/openai.js'
import { openAIProvider } from '../src/exports/openai.js'
import { ProviderError } from '../src/provider/types.js'

const openAIConstructor = vi.hoisted(() => vi.fn())
vi.mock('openai', () => ({
  default: class {
    responses = { create: vi.fn() }
    constructor(options: unknown) {
      openAIConstructor(options)
    }
  },
}))

const request = {
  sourceLocale: 'es',
  targetLocale: 'ca',
  instructions: 'Registro formal.',
  units: { u0: 'Curso', u1: '<1>Hola</1>' },
}

type Create = OpenAIClientLike['responses']['create']

const clientReturning = (
  outputText: string,
): { responses: { create: Mock<Create> } } => ({
  responses: { create: vi.fn<Create>().mockResolvedValue({ output_text: outputText }) },
})

describe('openAIProvider', () => {
  it('builds its default client with a short timeout and a single retry', () => {
    openAIProvider({ apiKey: 'k', model: 'm' })

    expect(openAIConstructor).toHaveBeenCalledWith({
      apiKey: 'k',
      timeout: 60_000,
      maxRetries: 1,
    })
  })

  it('asks for a strict JSON schema with exactly the keys it sent', async () => {
    const client = clientReturning(JSON.stringify({ u0: 'Curs', u1: '<1>Hola</1>' }))
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    await provider.translate(request)

    const args = client.responses.create.mock.calls[0]![0]
    expect(args.model).toBe('m')
    expect(args.text.format).toEqual({
      type: 'json_schema',
      name: 'translations',
      strict: true,
      schema: {
        type: 'object',
        properties: { u0: { type: 'string' }, u1: { type: 'string' } },
        required: ['u0', 'u1'],
        additionalProperties: false,
      },
    })
    expect(args.instructions).toContain('Spanish')
    expect(args.instructions).toContain('Catalan')
    expect(args.instructions).toContain('Registro formal.')
    expect(JSON.parse(args.input)).toEqual(request.units)
  })

  it('returns the translated values', async () => {
    const provider = openAIProvider({
      apiKey: 'k',
      model: 'm',
      client: clientReturning(JSON.stringify({ u0: 'Curs', u1: '<1>Hola</1>' })),
    })

    await expect(provider.translate(request)).resolves.toEqual({
      u0: 'Curs',
      u1: '<1>Hola</1>',
    })
  })

  it('rejects a reply with missing or extra keys as retryable', async () => {
    const provider = openAIProvider({
      apiKey: 'k',
      model: 'm',
      client: clientReturning(JSON.stringify({ u0: 'Curs', u9: 'x' })),
    })

    await expect(provider.translate(request)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
    })
  })

  it('marks authentication and bad-request failures as not retryable', async () => {
    const client = {
      responses: {
        create: vi
          .fn<Create>()
          .mockRejectedValue(Object.assign(new Error('nope'), { status: 401 })),
      },
    }
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    const error = await provider.translate(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).retryable).toBe(false)
  })

  it.each(['null', '[]', '"texto"', '5'])(
    'rejects a reply that is not an object (%s) as retryable',
    async reply => {
      const provider = openAIProvider({
        apiKey: 'k',
        model: 'm',
        client: clientReturning(reply),
      })

      await expect(provider.translate(request)).rejects.toMatchObject({
        name: 'ProviderError',
        retryable: true,
      })
    },
  )

  it('wraps a create that throws synchronously', async () => {
    const client = {
      responses: {
        create: vi.fn<Create>().mockImplementation(() => {
          throw new Error('boom')
        }),
      },
    }
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    await expect(provider.translate(request)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
    })
  })

  it.each([null, undefined])('wraps a rejection with %s', async reason => {
    const client = {
      responses: { create: vi.fn<Create>().mockRejectedValue(reason) },
    }
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    await expect(provider.translate(request)).rejects.toBeInstanceOf(ProviderError)
  })

  it('asks OpenAI not to store the request', async () => {
    const client = clientReturning(JSON.stringify({ u0: 'Curs', u1: '<1>Hola</1>' }))
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    await provider.translate(request)

    expect(client.responses.create.mock.calls[0]![0].store).toBe(false)
  })

  it('rejects an incomplete reply as retryable, saying why', async () => {
    const client = {
      responses: {
        create: vi.fn<Create>().mockResolvedValue({
          output_text: '{"u0": "Cu',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      },
    }
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    const error = await provider.translate(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).retryable).toBe(true)
    expect((error as ProviderError).message).toContain('max_output_tokens')
  })

  it('rejects a reply cut by the content filter as not retryable', async () => {
    const client = {
      responses: {
        create: vi.fn<Create>().mockResolvedValue({
          output_text: '{"u0": "Cu',
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        }),
      },
    }
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    const error = await provider.translate(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).retryable).toBe(false)
    expect((error as ProviderError).message).toContain('content_filter')
  })

  it('rejects a refusal as not retryable, with the model explanation', async () => {
    const client = {
      responses: {
        create: vi.fn<Create>().mockResolvedValue({
          output_text: '',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'refusal', refusal: 'No puedo ayudar con eso.' }],
            },
          ],
        }),
      },
    }
    const provider = openAIProvider({ apiKey: 'k', model: 'm', client })

    const error = await provider.translate(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).retryable).toBe(false)
    expect((error as ProviderError).message).toContain('No puedo ayudar con eso.')
  })
})
