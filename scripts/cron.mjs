#!/usr/bin/env node
/**
 * See the live app's scheduled tasks and recent runs, or run one now through
 * the same path the schedule uses. App owner only (signed in with the
 * DeepSpace CLI; run `npx deepspace auth whoami` first). Neither task costs credits.
 *
 *   node scripts/cron.mjs                  # tasks, next run times, recent runs
 *   node scripts/cron.mjs stale-sweep      # run the offline-agent sweep now
 *   node scripts/cron.mjs daily-digest     # build today's digests now
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const task = process.argv[2]
const appId = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/DEEPSPACE_APP_ID\s*=\s*"([^"]+)"/)?.[1]
const appName = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1]
const raw = readFileSync(`${homedir()}/.deepspace/token`, 'utf8').trim()
let token = raw
try {
  const j = JSON.parse(raw)
  token = j.accessToken ?? j.access_token ?? j.token ?? j.jwt ?? raw
} catch {}
const pacific = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) + ' Pacific' : '—')

const ws = new WebSocket(`wss://${appName}.app.space/ws/cron/app:${appId}?token=${encodeURIComponent(token)}`)
let printed = false
const done = (code = 0) => { ws.close(); process.exit(code) }
ws.onopen = () => {
  if (task) ws.send(JSON.stringify({ type: 'cron.trigger', payload: { taskName: task, requestId: 'cli' } }))
}
ws.onmessage = async (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString())
  if (msg.type === 'cron.ack') {
    console.log(msg.payload.ok ? `Ran ${task}.` : `Could not run ${task}: ${msg.payload.error ?? 'refused'}`)
    if (!msg.payload.ok) done(1)
  }
  const tasks = msg.payload?.tasks
  const history = msg.payload?.history ?? msg.payload?.recentHistory
  if (tasks && !printed) {
    printed = true
    console.log('Tasks:')
    for (const t of tasks) console.log(`  ${t.name}${t.paused ? ' (paused)' : ''}: last run ${pacific(t.lastRunAt)}, next run ${pacific(t.nextRunAt)}`)
  }
  if (history) {
    console.log('Recent runs:')
    for (const h of history.slice(0, 6)) console.log(`  ${pacific(h.startedAt)}  ${h.taskName}  ${h.success ? 'ok' : `FAILED: ${h.error}`}  (${h.durationMs} ms)`)
    if (!task || msg.type === 'cron.status') done(0)
  }
}
ws.onerror = () => { console.error('Could not connect (are you signed in as the app owner?)'); process.exit(1) }
setTimeout(() => done(0), 15000)
