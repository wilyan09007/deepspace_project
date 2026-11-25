/**
 * Client side of the server actions in src/actions/index.ts.
 */

import { useCallback, useState } from 'react'
import { getAuthToken } from 'deepspace'
import { useToast } from '@/components/ui'

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

export async function callAction<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new ActionError('Please sign in again.', 'unauthorized')
  const res = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  })
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string; code?: string }
  if (!res.ok || body.success === false) {
    throw new ActionError(body.error ?? `Request failed (${res.status})`, body.code)
  }
  return body.data as T
}

/** Run actions with a pending flag; failures become an error toast. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null)
  const { error } = useToast()
  const run = useCallback(
    async <T,>(name: string, params: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<T | null> => {
      setPending(name)
      try {
        return await callAction<T>(name, params)
      } catch (e) {
        if (!opts.quiet) error("That didn't work", e instanceof Error ? e.message : String(e))
        return null
      } finally {
        setPending(null)
      }
    },
    [error],
  )
  return { run, pending }
}
