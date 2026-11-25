import { beforeEach, describe, expect, it } from 'vitest'
import { emailDigestToSelf, generateTodaysDigest, runDailyDigest, summarizeDay } from './digest'
import { Ops, type EventRow } from './ops'
import { Store } from './store'
import { FakeTools } from './testing/fake-tools'

let db: FakeTools
const now = Date.UTC(2026, 10, 25, 22)
const ops = (u: string) => new Ops({ store: new Store(db.as(u)), userId: u, now: () => now - 3600_000 })

beforeEach(() => {
  db = new FakeTools()
  for (const u of ['alice', 'bob', 'carol', 'dave', 'eve']) db.addUser(u, u[0]!.toUpperCase() + u.slice(1))
})

describe('summarizeDay', () => {
  it('groups the day and escapes HTML', () => {
    const ev = (kind: EventRow['kind'], message: string, agentId?: string): EventRow => ({ teamId: 't', kind, message, at: now, agentId })
    const s = summarizeDay('Core <dev>', '2026-11-25', [
      ev('complete', 'a1 finished “X”', 'a1'),
      ev('plan', 'planned “Dark mode” into 4 tasks'),
      ev('check_in', 'editing', 'a2'),
      ev('overlap', 'overlap (same-file): “A” and “B”'),
    ])
    expect(s.counts).toMatchObject({ finished: 1, planned: 1, overlaps: 1, checkIns: 1 })
    expect(s.text).toContain('1 task(s) finished, 2 agent(s) active')
    expect(s.html).toContain('Core &lt;dev&gt;')
    const t = summarizeDay('T', '2026-11-25', [{ teamId: 't', kind: 'team', message: 'joined the team', actorName: 'Bob', at: now }, { teamId: 't', kind: 'plan', message: 'set a goal: Dark mode', actorName: 'Ana', at: now }])
    expect(t.text).toContain('• Bob joined the team')
    expect(t.text).toContain('• Ana: Dark mode')
  })
})

describe('runDailyDigest', () => {
  it('writes one digest per active team per day, refreshes it, and sends nothing', async () => {
    const { teamId: t1 } = await ops('alice').createTeam('One')
    const { teamId: t2 } = await ops('dave').createTeam('Two')
    const quiet = await ops('dave').createTeam('Quiet')
    for (const e of db.all('events')) if (e.data.teamId === quiet.teamId) db.rows.delete(e.recordId)
    const store = new Store(db.as('owner'))
    expect(await runDailyDigest(store, now)).toEqual({ digests: 2 })
    expect(db.all('digests').map((d) => d.data.teamId).sort()).toEqual([t1, t2].sort())
    // A second run the same day updates rather than duplicates.
    await ops('alice').createInvite(t1)
    expect(await runDailyDigest(store, now)).toEqual({ digests: 2 })
    expect(db.all('digests')).toHaveLength(2)
  })
})

describe('on-demand digests', () => {
  it('members generate today\'s digest for free; outsiders cannot', async () => {
    const { teamId } = await ops('alice').createTeam('One')
    const { digestId } = await generateTodaysDigest(ops('alice'), teamId)
    expect(db.rows.get(digestId!)!.data.body).toContain('One —')
    await expect(generateTodaysDigest(ops('eve'), teamId)).rejects.toMatchObject({ code: 'not_member' })
  })

  it('emails only the caller, records it, and limits sends per day', async () => {
    const { teamId } = await ops('alice').createTeam('One')
    const { digestId } = await generateTodaysDigest(ops('alice'), teamId)
    const sent: Array<{ to: string; subject: string }> = []
    const send = async (m: { to: string; subject: string }) => { sent.push(m) }
    expect(await emailDigestToSelf(ops('alice'), digestId!, 'alice@example.com', send, 'https://c.app.space')).toEqual({ sentTo: 'alice@example.com' })
    expect(sent[0]).toMatchObject({ to: 'alice@example.com', subject: expect.stringContaining('One') })
    expect(db.rows.get(digestId!)!.data.sentTo).toEqual(['alice'])
    await expect(emailDigestToSelf(ops('eve'), digestId!, 'eve@example.com', send, 'x')).rejects.toMatchObject({ code: 'not_found' })
    await expect(emailDigestToSelf(ops('alice'), digestId!, undefined, send, 'x')).rejects.toMatchObject({ code: 'no_email' })
    for (let i = 0; i < 4; i++) await emailDigestToSelf(ops('alice'), digestId!, 'alice@example.com', send, 'x')
    await expect(emailDigestToSelf(ops('alice'), digestId!, 'alice@example.com', send, 'x')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(sent).toHaveLength(5)
  })
})
