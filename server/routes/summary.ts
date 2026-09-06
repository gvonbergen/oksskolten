import type { FastifyInstance } from 'fastify'
import { getSummaryStatus, startSummaryBackfill } from '../fetcher/summary-backfill.js'

/**
 * Summarization coverage dashboard + manual continue/backfill action for
 * the automatic summarization feature. Status is a pure read and works
 * even when no summary provider is configured; the run endpoint is a
 * single-flight, idempotent trigger for the background backfill job.
 */
export async function summaryRoutes(api: FastifyInstance): Promise<void> {
  // --- Coverage counts + backfill progress ---
  api.get('/api/settings/summary/status', async (_request, reply) => {
    reply.send(getSummaryStatus())
  })

  // --- Start (or no-op) the missing-summaries backfill ---
  api.post('/api/settings/summary/run', async (_request, reply) => {
    const result = startSummaryBackfill()
    if (!result.started) {
      if (result.reason === 'already-running') {
        reply.status(409).send({ ok: false, error: 'A summary backfill is already running', running: true })
        return
      }
      if (result.reason === 'not-configured') {
        reply.status(400).send({
          ok: false,
          error: 'Automatic summarization is not enabled or no summary provider is configured',
          running: false,
        })
        return
      }
      // nothing-to-do: not an error, report the current (complete) state.
      reply.send({ ok: true, started: false, ...getSummaryStatus() })
      return
    }
    reply.send({ ok: true, started: true, ...getSummaryStatus() })
  })
}
