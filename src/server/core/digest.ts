/**
 * Daily digest, written without AI from the day's activity (decision #15) and
 * saved to the team page — free. A member can email a digest to themselves;
 * that send is billed to them (decision #18). Nothing here bills the owner.
 */

import { DIGEST_EMAILS_PER_USER_PER_DAY } from './config'
import { dayKey } from './engine'
import { clip, type EventRow, type Ops, type Team } from './ops'
import { OpsError, type Store } from './store'

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
    ['Goals set', by('plan').filter((e) => /^set a goal: /.test(e.message)).map((e) => `${e.actorName ?? 'Someone'}: ${e.message.replace(/^set a goal: /, '')}`)],
    ['Team', by('team').map((e) => `${e.actorName ?? 'Someone'} ${e.message}`)],
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

/** Write (or refresh) one team's digest for `day` from its activity. Returns null when the day had none. */
export async function buildTeamDigest(store: Store, teamId: string, teamName: string, day: string): Promise<string | null> {
  const events = (await store.query<EventRow>('events', { teamId }, { orderBy: 'at', orderDir: 'desc', limit: 500 })).filter(
    (e) => dayKey(e.data.at) === day,
  )
  if (!events.length) return null
  const body = summarizeDay(teamName, day, events.map((e) => e.data)).text
  const [existing] = await store.query<Digest>('digests', { teamId, date: day })
  if (existing) {
    if (existing.data.body !== body) await store.update<Digest>('digests', existing.recordId, { body })
    return existing.recordId
  }
  const created = await store.tryCreate<Digest>('digests', { teamId, date: day, body, sentTo: [] })
  if (created) return created
  // Lost a race with another writer for the same day: use theirs.
  return (await store.query<Digest>('digests', { teamId, date: day }))[0]?.recordId ?? null
}

/** Scheduled run: every team with activity today gets its digest. No emails, no billing. */
export async function runDailyDigest(store: Store, now: number): Promise<{ digests: number }> {
  const day = dayKey(now)
  let digests = 0
  for (const team of await store.query<Team>('teams')) {
    if (await buildTeamDigest(store, team.recordId, team.data.name, day)) digests++
  }
  return { digests }
}

/** "Generate today's digest" on the team page (members; free). */
export async function generateTodaysDigest(ops: Ops, teamId: string): Promise<{ digestId: string | null }> {
  await ops.requireMember(teamId)
  const team = await ops.store.get<Team>('teams', teamId)
  return { digestId: await buildTeamDigest(ops.store, teamId, team?.data.name ?? 'Team', dayKey(ops.now())) }
}

/**
 * Email a digest to the caller's own address, billed to the caller. The
 * recipient is never taken from input, so this can't be used to send mail to
 * anyone else.
 */
export async function emailDigestToSelf(
  ops: Ops,
  digestId: string,
  ownEmail: string | undefined,
  send: SendEmail,
  appUrl: string,
): Promise<{ sentTo: string }> {
  const digest = await ops.loadForMember<Digest>('digests', digestId, 'Digest')
  if (!ownEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownEmail)) {
    throw new OpsError('no_email', 'Your account has no email address to send to', 400)
  }
  await ops.bump('digest-email', DIGEST_EMAILS_PER_USER_PER_DAY)
  const team = await ops.store.get<Team>('teams', digest.data.teamId)
  const teamName = team?.data.name ?? 'your team'
  const link = `${appUrl}/t/${digest.data.teamId}`
  const lines = digest.data.body.split('\n')
  const html = [
    `<h2>${escapeHtml(lines[0] ?? '')}</h2>`,
    `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(lines.slice(1).join('\n').trim())}</pre>`,
    `<p><a href="${link}">Open the board</a></p>`,
  ].join('\n')
  await send({ to: ownEmail, subject: `Conductor digest — ${teamName}, ${digest.data.date}`, text: `${digest.data.body}\n\nOpen the board: ${link}`, html })
  const sentTo = [...new Set([...(digest.data.sentTo ?? []), ops.userId])]
  await ops.store.update<Digest>('digests', digestId, { sentTo })
  return { sentTo: ownEmail }
}
