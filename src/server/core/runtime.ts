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
import { Ops } from './ops'
import { Store } from './store'

export function makeOps(env: Env, userId: string, payerJwt?: string): Ops {
  const store = new Store(createActionTools(env, userId, payerJwt ?? ''))
  return new Ops({
    store,
    userId,
    github: payerJwt ? githubClient(env, { kind: 'user', jwt: payerJwt }) : undefined,
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
