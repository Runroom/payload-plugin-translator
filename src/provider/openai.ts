import OpenAI from 'openai'

import type { TranslateRequest, TranslationProvider } from './types.js'
import { ProviderError } from './types.js'

type CreateArgs = {
  model: string
  instructions: string
  input: string
  store: boolean
  text: { format: Record<string, unknown> }
}

type OutputItem = { type: string; content?: { type: string; refusal?: string }[] }

type CreateResult = {
  output_text: string
  status?: string | null
  incomplete_details?: { reason?: string } | null
  output?: OutputItem[]
}

export type OpenAIClientLike = {
  responses: { create: (args: CreateArgs) => Promise<CreateResult> }
}

const NOT_RETRYABLE = new Set([400, 401, 403, 404, 422])

const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

const systemPrompt = ({
  sourceLocale,
  targetLocale,
  instructions,
}: TranslateRequest): string =>
  [
    `Translate every value of the JSON object from ${languageName(sourceLocale)} to ${languageName(targetLocale)}.`,
    'Return a JSON object with exactly the same keys.',
    'Values may contain numbered tags such as <1>…</1> or <2/>. Keep every tag exactly once and unchanged, never translate them, and move them only as far as the target grammar requires.',
    'Values may contain the entities &lt; and &amp;. Keep them exactly as they are: never turn them into < or &, and never add new entities.',
    'Do not add explanations.',
    instructions,
  ]
    .filter(Boolean)
    .join('\n\n')

const schemaFor = (keys: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])),
  required: keys,
  additionalProperties: false,
})

// A 429 for an exhausted quota (`insufficient_quota`) is not fixed by waiting: it is
// billing, not rate limiting.
const isQuotaExhausted = (error: { code?: unknown; error?: unknown }): boolean =>
  error.code === 'insufficient_quota' ||
  (error.error as { code?: unknown } | null | undefined)?.code === 'insufficient_quota'

const toProviderError = (error: unknown): ProviderError => {
  const failure = (error ?? {}) as { status?: unknown; code?: unknown; error?: unknown }
  const message = error instanceof Error ? error.message : String(error)
  const retryable =
    !(typeof failure.status === 'number' && NOT_RETRYABLE.has(failure.status)) &&
    !isQuotaExhausted(failure)
  return new ProviderError(`OpenAI: ${message}`, retryable)
}

const refusalOf = (response: CreateResult): string | undefined =>
  (response.output ?? [])
    .flatMap(item => item.content ?? [])
    .find(part => part.type === 'refusal')?.refusal

// A response cut by `max_output_tokens` may come out whole on another attempt; a refusal
// from the model or a content-filter cut would repeat the same way with the same text.
const assertUsable = (response: CreateResult): void => {
  const refusal = refusalOf(response)
  if (refusal !== undefined) {
    throw new ProviderError(`OpenAI refused to translate: ${refusal}`, false)
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown reason'
    throw new ProviderError(
      `OpenAI returned an incomplete response (${reason})`,
      reason !== 'content_filter',
    )
  }
}

const parseReply = (outputText: string, keys: string[]): Record<string, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(outputText)
  } catch {
    throw new ProviderError('OpenAI returned a response that is not JSON', true)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new ProviderError('OpenAI returned a response that is not an object', true)
  const reply = parsed as Record<string, unknown>
  const replyKeys = Object.keys(reply)
  const complete =
    replyKeys.length === keys.length && keys.every(key => typeof reply[key] === 'string')
  if (!complete)
    throw new ProviderError('OpenAI returned keys different from the ones sent', true)
  return reply as Record<string, string>
}

export const openAIProvider = ({
  apiKey,
  model,
  // The SDK defaults (10 min and 2 retries) would keep a job alive beyond the window in
  // which its record locks the document.
  client = new OpenAI({
    apiKey,
    timeout: 60_000,
    maxRetries: 1,
  }) as unknown as OpenAIClientLike,
}: {
  apiKey: string
  model: string
  client?: OpenAIClientLike
}): TranslationProvider => ({
  translate: async request => {
    const keys = Object.keys(request.units)
    const instructions = systemPrompt(request)
    let response: CreateResult
    try {
      response = await client.responses.create({
        model,
        instructions,
        input: JSON.stringify(request.units),
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'translations',
            strict: true,
            schema: schemaFor(keys),
          },
        },
      })
    } catch (error) {
      throw toProviderError(error)
    }
    assertUsable(response)
    return parseReply(response.output_text, keys)
  },
})
