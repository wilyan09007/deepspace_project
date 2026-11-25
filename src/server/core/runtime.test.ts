import { describe, expect, it } from 'vitest'
import { profileFromVerifiedJwt } from './runtime'

const b64url = (o: object) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('profileFromVerifiedJwt', () => {
  it('reads display claims and tolerates junk', () => {
    const jwt = `${b64url({ alg: 'none' })}.${b64url({ sub: 'u', name: 'Zoë', email: 'z@x.dev' })}.sig`
    expect(profileFromVerifiedJwt(jwt)).toEqual({ name: 'Zoë', email: 'z@x.dev', image: undefined })
    expect(profileFromVerifiedJwt('nope')).toBeUndefined()
    expect(profileFromVerifiedJwt(undefined)).toBeUndefined()
  })
})
