import { afterEach, describe, expect, it, vi } from 'vitest'
import { optimistic, withPatches } from './optimistic'

const records = [{ recordId: 'a1', data: { status: 'working', name: 'claude' } }]
const view = () => withPatches('agents', records)[0]!.data

afterEach(() => vi.useRealTimers())

describe('optimistic updates', () => {
  it('shows the expected result while the action runs and rolls back if it fails', async () => {
    let finish!: (v: null) => void
    const done = optimistic([{ collection: 'agents', id: 'a1', data: { status: 'paused' } }], () => new Promise<null>((r) => (finish = r)))
    expect(view()).toEqual({ status: 'paused', name: 'claude' })
    finish(null) // failed
    await done
    expect(view().status).toBe('working')
  })

  it('keeps the result briefly after success so the live record can take over without flicker', async () => {
    vi.useFakeTimers()
    await optimistic([{ collection: 'agents', id: 'a1', data: { status: 'paused' } }], async () => ({ ok: true }))
    expect(view().status).toBe('paused')
    vi.advanceTimersByTime(3000)
    expect(view().status).toBe('working')
  })

  it("a newer click on the same record isn't undone when an older one finishes", async () => {
    vi.useFakeTimers()
    let finishFirst!: (v: { ok: true }) => void
    const first = optimistic([{ collection: 'agents', id: 'a1', data: { status: 'paused' } }], () => new Promise<{ ok: true }>((r) => (finishFirst = r)))
    const second = optimistic([{ collection: 'agents', id: 'a1', data: { status: 'working', name: 'renamed' } }], () => new Promise<null>(() => {}))
    finishFirst({ ok: true })
    await first
    vi.advanceTimersByTime(3000)
    expect(view()).toEqual({ status: 'working', name: 'renamed' })
    void second
  })

  it('leaves other records and collections alone', async () => {
    await optimistic([{ collection: 'tasks', id: 'a1', data: { status: 'done' } }], async () => null)
    expect(view().status).toBe('working')
  })
})
