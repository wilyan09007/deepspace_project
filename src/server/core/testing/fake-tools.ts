/**
 * In-memory ActionTools for unit tests. Mirrors the record room's behaviour
 * that ops.ts relies on: uniqueOn conflicts reject creates, update merges
 * (and upserts, like the real room), query is equality on fields.
 */

import type { ActionTools } from 'deepspace/worker'
import { schemas } from '../../../schemas'

interface Stored {
  recordId: string
  collection: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export class FakeTools {
  rows = new Map<string, Stored>()
  private seq = 0
  calls: string[] = []

  constructor(public userId = 'system') {}

  private stamp(): string {
    // Strictly increasing, so createdAt ordering is deterministic.
    return new Date(Date.UTC(2026, 0, 1) + ++this.seq).toISOString()
  }

  all(collection: string): Stored[] {
    return [...this.rows.values()].filter((r) => r.collection === collection)
  }

  /** ActionTools acting as `userId` (identity is only recorded, like the RBAC-off room). */
  as(userId: string): ActionTools {
    const ok = <T>(data: T) => ({ success: true as const, data })
    const err = (error: string, code: string, status = 400) => ({ success: false as const, error, code, status })
    return {
      create: async (collection: string, data: object, recordId?: string) => {
        this.calls.push(`create ${collection}`)
        const unique = schemas.find((s) => s.name === collection)?.uniqueOn
        if (unique) {
          const clash = this.all(collection).find((r) => unique.every((k) => r.data[k] === (data as Record<string, unknown>)[k]))
          if (clash) return err('unique constraint', 'conflict', 409)
        }
        const id = recordId ?? `${collection.slice(0, 3)}_${++this.seq}`
        if (this.rows.has(id)) return err('exists', 'conflict', 409)
        const now = this.stamp()
        this.rows.set(id, { recordId: id, collection, data: structuredClone(data as Record<string, unknown>), createdBy: userId, createdAt: now, updatedAt: now })
        return ok({ recordId: id })
      },
      update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
        this.calls.push(`update ${collection}`)
        const row = this.rows.get(recordId)
        if (!row) {
          this.rows.set(recordId, { recordId, collection, data: structuredClone(data), createdBy: userId, createdAt: this.stamp(), updatedAt: this.stamp() })
        } else {
          Object.assign(row.data, structuredClone(data))
          row.updatedAt = this.stamp()
        }
        return ok({ recordId })
      },
      remove: async (_collection: string, recordId: string) => {
        if (!this.rows.delete(recordId)) return err('not found', 'not_found', 404)
        return ok({ deleted: true })
      },
      deleteWhere: async (collection: string, where: Record<string, unknown>) => {
        let deleted = 0
        for (const r of this.all(collection)) {
          if (Object.entries(where).every(([k, v]) => r.data[k] === v)) {
            this.rows.delete(r.recordId)
            deleted++
          }
        }
        return ok({ deleted })
      },
      get: async (collection: string, recordId: string) => {
        const row = this.rows.get(recordId)
        if (!row || row.collection !== collection) return err('Record not found', 'not_found', 404)
        return ok({ record: structuredClone(row) })
      },
      query: async (collection: string, options?: { where?: Record<string, unknown>; orderBy?: string; orderDir?: string; limit?: number }) => {
        this.calls.push(`query ${collection}`)
        const where = (options?.where ?? {}) as Record<string, unknown>
        let records = this.all(collection).filter((r) => Object.entries(where).every(([k, v]) => r.data[k] === v))
        if (options?.orderBy) {
          const key = options.orderBy as string
          const dir = options.orderDir === 'desc' ? -1 : 1
          records = records.sort((a, b) => (((a.data[key] as number) ?? 0) > ((b.data[key] as number) ?? 0) ? dir : -dir))
        }
        if (options?.limit) records = records.slice(0, options.limit as number)
        return ok({ records: records.map((r) => structuredClone(r)) })
      },
      integration: async () => err('no integrations in tests', 'unavailable', 503),
      registerUser: async () => ok({}),
    } as unknown as ActionTools
  }

  addUser(userId: string, name: string, email = `${userId}@example.com`): void {
    const now = this.stamp()
    this.rows.set(userId, { recordId: userId, collection: 'users', data: { name, email }, createdBy: userId, createdAt: now, updatedAt: now })
  }
}
