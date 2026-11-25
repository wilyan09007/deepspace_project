/**
 * Typed wrapper over the SDK's ActionTools.
 *
 * ActionTools run RBAC-off (see src/server/action-routes.ts), so this layer
 * never decides who may do what — src/server/core/ops.ts checks team
 * membership before every write. What this layer adds: typed rows, and
 * failures that throw instead of returning `{ success: false }`.
 */

import type { ActionTools } from 'deepspace/worker'

export interface Row<T> {
  recordId: string
  data: T
  createdBy: string
  createdAt: string
  updatedAt: string
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string = 'store_error',
  ) {
    super(message)
  }
}

/** A user-facing refusal with a stable code (wrong team, not found, rate limited…). */
export class OpsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function fail(op: string, collection: string, result: { error?: string; code?: string }): never {
  throw new StoreError(`${op} ${collection}: ${result.error ?? 'failed'}`, result.code ?? 'store_error')
}

export class Store {
  constructor(readonly tools: ActionTools) {}

  async query<T>(
    collection: string,
    where?: Record<string, unknown>,
    options: { orderBy?: string; orderDir?: 'asc' | 'desc'; limit?: number } = {},
  ): Promise<Row<T>[]> {
    const result = await this.tools.query<Record<string, unknown>>(collection, { where, ...options })
    if (!result.success) fail('query', collection, result)
    return result.data.records as unknown as Row<T>[]
  }

  async get<T>(collection: string, recordId: string): Promise<Row<T> | null> {
    const result = await this.tools.get<Record<string, unknown>>(collection, recordId)
    if (!result.success) {
      if (result.code === 'not_found' || result.status === 404 || /not found/i.test(result.error)) return null
      fail('get', collection, result)
    }
    return result.data.record as unknown as Row<T>
  }

  /** Throws StoreError with code from the room (e.g. a uniqueOn conflict). */
  async create<T extends object>(collection: string, data: T, recordId?: string): Promise<string> {
    const result = await this.tools.create(collection, data as Record<string, unknown>, recordId)
    if (!result.success) fail('create', collection, result)
    return result.data.recordId
  }

  /** Like create, but returns null instead of throwing when the row conflicts or is refused. */
  async tryCreate<T extends object>(collection: string, data: T, recordId?: string): Promise<string | null> {
    const result = await this.tools.create(collection, data as Record<string, unknown>, recordId)
    return result.success ? result.data.recordId : null
  }

  async update<T extends object>(collection: string, recordId: string, patch: Partial<T>): Promise<void> {
    const result = await this.tools.update(collection, recordId, patch as Record<string, unknown>)
    if (!result.success) fail('update', collection, result)
  }

  async remove(collection: string, recordId: string): Promise<void> {
    const result = await this.tools.remove(collection, recordId)
    if (!result.success && !/not found/i.test(result.error)) fail('remove', collection, result)
  }
}
