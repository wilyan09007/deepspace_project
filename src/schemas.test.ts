import { describe, expect, it } from 'vitest'
import { lintSchemas } from 'deepspace/worker'
import { schemas } from './schemas'

describe('schemas', () => {
  it('pass the SDK schema lint', () => {
    expect(lintSchemas(schemas)).toEqual([])
  })

  it('give every team-owned collection a teamId column', () => {
    for (const schema of schemas.filter((s) => s.teamField)) {
      expect(schema.columns.some((c) => c.name === schema.teamField), schema.name).toBe(true)
    }
  })
})
