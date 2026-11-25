/**
 * Daily digest, written without AI from the day's activity (decision #15),
 * saved to the team page, and emailed to members who opted in. Emails are
 * the app's only owner-paid cost, hard-capped per day across the whole app
 * (decision #16).
 */

import { DIGEST_EMAIL_DAILY_CAP } from './config'
import { dayKey } from './engine'
import { clip, type EventRow, type Member, type Team } from './ops'
import type { Store } from './store'

export interface Digest {
  teamId: string
  date: string
  body: string
  sentTo: string[]
}

export interface DigestSummary {
  text: string
  html: string
  counts: Record<string, number>
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function summarizeDay(teamName: string, date: string, events: readonly EventRow[]): DigestSummary {
  const by = (kind: EventRow['kind']) => events.filter((e) => e.kind === kind)
  const sections: Array<[string, string[]]> = [
    ['Finished', by('complete').map((e) => e.message)],
    ['Planned', by('plan').filter((e) => /^planned /.test(e.message)).map((e) => e.message.replace(/^planned /, ''))],
    ['Questions from agents', by('question').map((e) => e.message)],
    ['Overlaps flagged', by('overlap').filter((e) => /^overlap /.test(e.message)).map((e) => e.message)],
    ['Steering', by('directive').map((e) => `${e.actorName ?? 'Someone'} ${e.message}`)],
  ]
  const counts = {
    finished: sections[0]![1].length,
    planned: sections[1]![1].length,
    questions: sections[2]![1].length,
    overlaps: sections[3]![1].length,
    checkIns: by('check_in').length,
  }
  const agents = new Set(events.filter((e) => e.agentId).map((e) => e.agentId))
  const headline = `${counts.finished} task(s) finished, ${agents.size} agent(s) active, ${counts.checkIns} check-in(s), ${counts.overlaps} overlap(s) flagged.`
  const lines = [`${teamName} — ${date}`, headline]
  const htmlParts = [`<h2>${escapeHtml(teamName)} — ${date}</h2>`, `<p>${escapeHtml(headline)}</p>`]
  for (const [title, items] of sections) {
    if (!items.length) continue
    const shown = items.slice(0, 12).map((i) => clip(i, 200))
    const more = items.length > shown.length ? [`…and ${items.length - shown.length} more`] : []
    lines.push('', `${title}:`, ...[...shown, ...more].map((i) => `• ${i}`))
    htmlParts.push(`<h3>${title}</h3><ul>${[...shown, ...more].map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`)
  }
  return { text: lines.join('\n'), html: htmlParts.join('\n'), counts }
}

export type SendEmail = (msg: { to: string; subject: string; text: string; html: string }) => Promise<void>

/** Count of owner-paid emails sent today, app-wide. */
async function emailsSentToday(store: Store, day: string): Promise<{ id?: string; count: number }> {
  const [row] = await store.query<{ key: string; count: number }>('usage_counters', { key: `digest-email:app:${day}` })
  return { id: row?.recordId, count: row?.data.count ?? 0 }
}

export async function runDailyDigest(
  store: Store,
  now: number,
  sendEmail: SendEmail | null,
  appUrl: string,
  cap = DIGEST_EMAIL_DAILY_CAP,
): Promise<{ digests: number; emails: number }> {
  const day = dayKey(now)
  let digests = 0
  let emails = 0
  for (const team of await store.query<Team>('teams')) {
    const teamId = team.recordId
    const events = (await store.query<EventRow>('events', { teamId }, { orderBy: 'at', orderDir: 'desc', limit: 500 })).filter(
      (e) => dayKey(e.data.at) === day,
    )
    if (!events.length) continue
    if ((await store.query<Digest>('digests', { teamId, date: day })).length) continue
    const summary = summarizeDay(team.data.name, day, events.map((e) => e.data))
    const digestId = await store.tryCreate<Digest>('digests', { teamId, date: day, body: summary.text, sentTo: [] })
    if (!digestId) continue
    digests++

    if (!sendEmail || cap <= 0) continue
    const sentTo: string[] = []
    const members = (await store.query<Member>('team_members', { teamId })).filter(
      (m) => m.data.status !== 'removed' && m.data.digestOptIn === 1,
    )
    for (const m of members) {
      const counter = await emailsSentToday(store, day)
      if (counter.count >= cap) break
      const user = await store.get<{ email?: string; name?: string }>('users', m.data.userId)
      const to = user?.data.email
      if (!to) continue
      if (counter.id) await store.update('usage_counters', counter.id, { count: counter.count + 1 })
      else await store.create('usage_counters', { key: `digest-email:app:${day}`, count: 1 })
      try {
        await sendEmail({
          to,
          subject: `Conductor digest — ${team.data.name}, ${day}`,
          text: `${summary.text}\n\nOpen the board: ${appUrl}/t/${teamId}\nTurn these emails off on the team page.`,
          html: `${summary.html}\n<p><a href="${appUrl}/t/${teamId}">Open the board</a> · turn these emails off on the team page.</p>`,
        })
        sentTo.push(m.data.userId)
        emails++
      } catch (e) {
        console.error(`[digest] email failed for team ${teamId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (sentTo.length) await store.update<Digest>('digests', digestId, { sentTo })
  }
  return { digests, emails }
}
