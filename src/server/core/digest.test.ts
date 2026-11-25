import { beforeEach, describe, expect, it } from 'vitest'
import { runDailyDigest, summarizeDay } from './digest'
import { Ops, type EventRow } from './ops'
import { Store } from './store'
import { FakeTools } from './testing/fake-tools'

let db: FakeTools
const now = Date.UTC(2026, 10, 25, 22)
const ops = (u: string) => new Ops({ store: new Store(db.as(u)), userId: u, now: () => now - 3600_000 })

beforeEach(() => {
  db = new FakeTools()
  for (const u of ['alice', 'bob', 'carol', 'dave']) db.addUser(u, u[0]!.toUpperCase() + u.slice(1))
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
  })
})

describe('runDailyDigest', () => {
  it('writes one digest per active team per day and caps owner-paid emails app-wide', async () => {
    // Team 1: alice, bob, carol all opt in. Team 2: dave opts in. Team 3: no activity.
    const alice = ops('alice')
    const { teamId: t1 } = await alice.createTeam('One')
    for (const u of ['bob', 'carol']) await ops(u).joinTeam((await alice.createInvite(t1)).code)
    for (const u of ['alice', 'bob', 'carol']) await ops(u).setDigestOptIn(t1, true)
    const { teamId: t2 } = await ops('dave').createTeam('Two')
    await ops('dave').setDigestOptIn(t2, true)
    const quiet = await ops('dave').createTeam('Quiet')
    for (const e of db.all('events')) if (e.data.teamId === quiet.teamId) db.rows.delete(e.recordId)

    const sent: string[] = []
    const store = new Store(db.as('owner'))
    const r1 = await runDailyDigest(store, now, async (m) => { sent.push(m.to) }, 'https://conductor.app.space', 3)
    expect(r1).toEqual({ digests: 2, emails: 3 })
    expect(sent).toHaveLength(3)
    expect(db.all('digests').map((d) => d.data.teamId).sort()).toEqual([t1, t2].sort())

    // Running again the same day changes nothing.
    expect(await runDailyDigest(store, now, async (m) => { sent.push(m.to) }, 'x', 3)).toEqual({ digests: 0, emails: 0 })
    expect(sent).toHaveLength(3)
  })

  it('sends nothing when the cap is 0 or sending is unavailable', async () => {
    const { teamId } = await ops('alice').createTeam('One')
    await ops('alice').setDigestOptIn(teamId, true)
    const sent: string[] = []
    expect(await runDailyDigest(new Store(db.as('owner')), now, async (m) => { sent.push(m.to) }, 'x', 0)).toEqual({ digests: 1, emails: 0 })
    expect(sent).toEqual([])
  })
})
