/**
 * Optimistic UI: show an action's expected result the moment it's clicked,
 * while the server does the real work. Pending patches sit on top of the live
 * records from `useQuery`; they're dropped when the action fails (the UI snaps
 * back and an error toast explains why) or shortly after it succeeds, once the
 * live subscription carries the server's own version.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { useQuery } from 'deepspace'

type Data = Record<string, unknown>
export interface Patch {
  collection: string
  id: string
  data: Data
}

const patches = new Map<string, { data: Data; token: number }>()
const listeners = new Set<() => void>()
let version = 0
let nextToken = 1

const key = (collection: string, id: string) => `${collection}:${id}`
function emit() {
  version++
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** How long a successful action's patch is kept, so the live record can arrive first (no flicker). */
const SETTLE_MS = 2500

function apply(list: Patch[]): number {
  const token = nextToken++
  for (const p of list) {
    const k = key(p.collection, p.id)
    patches.set(k, { data: { ...(patches.get(k)?.data ?? {}), ...p.data }, token })
  }
  emit()
  return token
}

function release(list: Patch[], token: number, delay: number) {
  const drop = () => {
    let changed = false
    for (const p of list) {
      const k = key(p.collection, p.id)
      // A newer click on the same record keeps its own patch.
      if (patches.get(k)?.token === token) {
        patches.delete(k)
        changed = true
      }
    }
    if (changed) emit()
  }
  if (delay) setTimeout(drop, delay)
  else drop()
}

/**
 * Run an action with its expected effect shown immediately. `run` resolves to
 * the action's result, or null when it failed (callers' `useAction().run`
 * already shows the error toast).
 */
export async function optimistic<T>(list: Patch[], run: () => Promise<T | null>): Promise<T | null> {
  const token = apply(list)
  let result: T | null = null
  try {
    result = await run()
  } finally {
    release(list, token, result === null ? 0 : SETTLE_MS)
  }
  return result
}

/** Overlay pending patches on live records. */
export function withPatches<R extends { recordId: string; data: unknown }>(collection: string, records: R[]): R[] {
  if (!patches.size) return records
  return records.map((r) => {
    const p = patches.get(key(collection, r.recordId))
    return p ? { ...r, data: { ...(r.data as object), ...p.data } } : r
  })
}

/** `useQuery` with pending optimistic patches applied. */
export function useLiveQuery<T>(collection: string, options?: Parameters<typeof useQuery>[1]) {
  const result = useQuery<T>(collection, options)
  useSyncExternalStore(subscribe, () => version)
  return { ...result, records: withPatches(collection, result.records) }
}

/** Re-render when patches change (for components that combine several queries). */
export function useOptimisticVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** Convenience: a stable callback that runs an action optimistically. */
export function useOptimisticAction(run: <T>(name: string, params?: Record<string, unknown>, opts?: { quiet?: boolean }) => Promise<T | null>) {
  return useCallback(
    <T,>(name: string, params: Record<string, unknown>, list: Patch[]) => optimistic<T>(list, () => run<T>(name, params)),
    [run],
  )
}
