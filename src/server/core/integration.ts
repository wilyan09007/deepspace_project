/**
 * Integration calls with an explicit payer.
 *
 * The scaffold's ActionTools.integration picks the payer per integration
 * name from src/integrations.ts. Conductor needs the same integration
 * (github) billed to different people depending on who triggered the work:
 * the signed-in user when they plan a goal, the app owner for the capped
 * hourly PR refresh. So the payer is chosen per call here, by passing the
 * JWT whose subject the platform bills.
 */

import { apiWorkerFetch, normalizeApiError, splitIntegrationEndpoint } from 'deepspace/worker'
import type { Env } from '../../../worker'

export type Payer = { kind: 'user'; jwt: string } | { kind: 'owner' }

export class IntegrationError extends Error {
  constructor(
    readonly endpoint: string,
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

export function payerJwt(env: Env, payer: Payer): string {
  return payer.kind === 'owner' ? env.APP_OWNER_JWT : payer.jwt
}

export async function callIntegration<T>(env: Env, payer: Payer, endpoint: string, body: unknown): Promise<T> {
  const target = splitIntegrationEndpoint(endpoint)
  if (!target) throw new IntegrationError(endpoint, 'Invalid integration endpoint', 400)
  const jwt = payerJwt(env, payer)
  if (!jwt) throw new IntegrationError(endpoint, 'No credential available to pay for this call', 401, 'no_payer')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }
  // Composio files connections per app: identify this app, as the scaffold's
  // integration proxy does, or a user's connection is looked up elsewhere.
  if (target.name === 'composio' && env.APP_IDENTITY_TOKEN) {
    headers['x-app-identity-token'] = env.APP_IDENTITY_TOKEN
    headers['x-app-id'] = env.DEEPSPACE_APP_ID
  }
  const res = await apiWorkerFetch(env, target.path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  })
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || payload.success === false) {
    const err = normalizeApiError(res.status, payload)
    throw new IntegrationError(endpoint, err.error, err.status ?? res.status, err.code)
  }
  return ('data' in payload ? payload.data : payload) as T
}

export const NO_CREDITS_MESSAGE =
  'Your DeepSpace account is out of credits, so this can’t run. Free accounts get 500 credits a month; see dashboard.deep.space.'

/** True for a platform refusal because the payer has no credits left (integrations or AI). */
export function isCreditError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { status?: number; statusCode?: number; message?: string; code?: string; responseBody?: string }
  if (err.status === 402 || err.statusCode === 402) return true
  const text = `${err.code ?? ''} ${err.message ?? ''} ${err.responseBody ?? ''}`
  return /insufficient[_ ]credits|out of credits|payment required/i.test(text)
}
