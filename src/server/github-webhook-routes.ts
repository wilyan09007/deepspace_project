/**
 * GitHub webhook deliveries (decision #24; the logic is in core/github-webhook.ts).
 *
 * Unlike /api/actions/*, this route has no signed-in caller: GitHub calls it. Each delivery proves
 * itself with its signature over the raw body, checked against the project's server-only secret
 * before anything is read or written. It acts as the app (OWNER_USER_ID), like the cron jobs.
 */

import type { Hono } from 'hono'
import type { AppContext } from '../../worker.js'
import { MAX_WEBHOOK_BYTES, receiveGithubWebhook } from './core/github-webhook.js'
import { makeOps } from './core/runtime.js'

export function registerGithubWebhookRoutes(app: Hono<AppContext>): void {
  app.post('/api/github/webhook/:projectId', async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return c.json({ error: 'Payload too large' }, 413)
    const reply = await receiveGithubWebhook(makeOps(c.env, c.env.OWNER_USER_ID), c.req.param('projectId'), {
      event: c.req.header('x-github-event') ?? '',
      signature: c.req.header('x-hub-signature-256') ?? '',
      body: await c.req.text(),
    })
    return c.json(reply.body, reply.status)
  })
}
