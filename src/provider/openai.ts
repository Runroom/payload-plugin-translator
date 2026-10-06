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

const languageName = (code: string): string =>
  new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code

const systemPrompt = ({
  sourceLocale,
  targetLocale,
  instructions,
}: TranslateRequest): string =>
  [
    `Translate every value of the JSON object from ${languageName(sourceLocale)} to ${languageName(targetLocale)}.`,
    'Return a JSON object with exactly the same keys.',
    'Values may contain numbered tags such as <1>…</1> or <2/>. Keep every tag exactly once and unchanged, never translate them, and move them only as far as the target grammar requires.',
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

const toProviderError = (error: unknown): ProviderError => {
  const status = (error as { status?: unknown } | null | undefined)?.status
  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError(
    `OpenAI: ${message}`,
    !(typeof status === 'number' && NOT_RETRYABLE.has(status)),
  )
}

const refusalOf = (response: CreateResult): string | undefined =>
  (response.output ?? [])
    .flatMap(item => item.content ?? [])
    .find(part => part.type === 'refusal')?.refusal

// Una respuesta cortada por `max_output_tokens` puede salir entera en otro intento; una
// negativa del modelo o un corte del filtro de contenido se repetirían igual con el mismo
// texto.
const assertUsable = (response: CreateResult): void => {
  const refusal = refusalOf(response)
  if (refusal !== undefined) {
    throw new ProviderError(`OpenAI se negó a traducir: ${refusal}`, false)
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'motivo desconocido'
    throw new ProviderError(
      `OpenAI devolvió una respuesta incompleta (${reason})`,
      reason !== 'content_filter',
    )
  }
}

const parseReply = (outputText: string, keys: string[]): Record<string, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(outputText)
  } catch {
    throw new ProviderError('OpenAI devolvió una respuesta que no es JSON', true)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new ProviderError('OpenAI devolvió una respuesta que no es un objeto', true)
  const reply = parsed as Record<string, unknown>
  const replyKeys = Object.keys(reply)
  const complete =
    replyKeys.length === keys.length && keys.every(key => typeof reply[key] === 'string')
  if (!complete)
    throw new ProviderError('OpenAI devolvió claves distintas a las enviadas', true)
  return reply as Record<string, string>
}

export const openAIProvider = ({
  apiKey,
  model,
  // Los valores por defecto del SDK (10 min y 2 reintentos) dejarían un job vivo más
  // allá de la ventana en que su registro bloquea el documento.
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
    let response: CreateResult
    try {
      response = await client.responses.create({
        model,
        instructions: systemPrompt(request),
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
