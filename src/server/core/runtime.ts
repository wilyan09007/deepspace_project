/**
 * Builds Ops for a verified caller inside the Worker.
 *
 * Billing (decision #11): `payerJwt` must be the signed-in caller's own JWT.
 * Without it, no GitHub client and no model are available — there is no
 * fallback to the owner's credentials anywhere in this file.
 */

import { generateText } from 'ai'
import { createDeepSpaceAI } from 'deepspace/worker'
import type { Env } from '../../../worker'
import { createActionTools } from '../action-tools'
import { githubClient } from './github'
import { preferUserGithub, userGithub } from './github-user'
import { Ops } from './ops'
import { Store } from './store'

/**
 * Display claims from a JWT the route has ALREADY verified (never use this to
 * authenticate). Only used to name a user whose users row isn't written yet.
 */
export function profileFromVerifiedJwt(jwt: string | undefined): { name?: string; email?: string; image?: string } | undefined {
  if (!jwt) return undefined
  try {
    const part = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const json = new TextDecoder().decode(Uint8Array.from(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')), (c) => c.charCodeAt(0)))
    const claims = JSON.parse(json) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    return { name: str(claims.name), email: str(claims.email), image: str(claims.image) }
  } catch {
    return undefined
  }
}

/**
 * `payerJwt` enables user-billed GitHub reads; `identityJwt` (the caller's
 * verified token) only supplies their display name.
 */
export function makeOps(env: Env, userId: string, payerJwt?: string, identityJwt?: string): Ops {
  const store = new Store(createActionTools(env, userId, payerJwt ?? ''))
  return new Ops({
    store,
    userId,
    // The user's own GitHub connection when they have one (private repos), else the public reader.
    github: payerJwt ? preferUserGithub(userGithub(env, payerJwt), githubClient(env, { kind: 'user', jwt: payerJwt })) : undefined,
    self: profileFromVerifiedJwt(identityJwt ?? payerJwt),
  })
}

/** One Claude call billed to the user whose JWT is passed. */
export function userModel(env: Env, jwt: string, modelId: string) {
  if (!jwt) throw new Error('A signed-in user is required to pay for this call')
  const model = createDeepSpaceAI(env, 'anthropic', { authToken: jwt })(modelId)
  return async ({ system, prompt, maxOutputTokens = 4000 }: { system: string; prompt: string; maxOutputTokens?: number }) => {
    const result = await generateText({ model, system, prompt, maxOutputTokens })
    return result.text
  }
}
