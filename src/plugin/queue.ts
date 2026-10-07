import type { Payload } from 'payload'

const schedulesQueue = async (payload: Payload, queue: string): Promise<boolean> => {
  const autoRun = payload.config.jobs.autoRun
  const entries = typeof autoRun === 'function' ? await autoRun(payload) : (autoRun ?? [])
  return entries.some(
    entry => entry.allQueues === true || (entry.queue ?? 'default') === queue,
  )
}

// A retryable error leaves the job waiting for its `waitUntil` and the record `queued`.
// If nothing runs the queue again, the retry never happens. This is only a warning because
// E2E runs or serverless setups may leave the queue unscheduled on purpose.
export const warnIfQueueUnscheduled = async (
  payload: Payload,
  queue: string,
): Promise<void> => {
  if (await schedulesQueue(payload, queue)) return
  payload.logger.warn(
    `translatorPlugin: no \`jobs.autoRun\` entry processes the "${queue}" queue. Retries of a failed translation will not run until something runs the queue again (for example \`autoRun: [{ cron: '* * * * *', queue: '${queue}' }]\` or an external cron).`,
  )
}
