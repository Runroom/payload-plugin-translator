import type { Payload } from 'payload'

import type { TranslatorSettings } from '../server/settings.js'

const schedulesQueue = async (payload: Payload, queue: string): Promise<boolean> => {
  const autoRun = payload.config.jobs.autoRun
  const entries = typeof autoRun === 'function' ? await autoRun(payload) : (autoRun ?? [])
  return entries.some(
    entry => entry.allQueues === true || (entry.queue ?? 'default') === queue,
  )
}

// A retryable error leaves the job waiting for its `waitUntil` and the record `queued`.
// If nothing runs the queue again, the retry never happens; with `runOnRequest: false`
// not even the first attempt does. This is only a warning because E2E runs or serverless
// setups may leave the queue unscheduled on purpose.
export const warnIfQueueUnscheduled = async (
  payload: Payload,
  { queue, runOnRequest }: Pick<TranslatorSettings, 'queue' | 'runOnRequest'>,
): Promise<void> => {
  if (await schedulesQueue(payload, queue)) return
  if (!runOnRequest) {
    payload.logger.warn(
      `translatorPlugin: \`runOnRequest\` is false and no \`jobs.autoRun\` entry processes the "${queue}" queue, so nothing will ever run the translation jobs: add an \`autoRun\` entry (for example \`autoRun: [{ cron: '* * * * *', queue: '${queue}' }]\`) or an external cron that calls \`GET /api/payload-jobs/run?queue=${queue}\`.`,
    )
    return
  }
  payload.logger.warn(
    `translatorPlugin: no \`jobs.autoRun\` entry processes the "${queue}" queue. Retries of a failed translation will not run until something runs the queue again (for example \`autoRun: [{ cron: '* * * * *', queue: '${queue}' }]\` or an external cron).`,
  )
}
