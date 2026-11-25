/**
 * Tool factory for the agent routes (local coding agents via the CLI/MCP),
 * registered in worker.ts. Returns Conductor's agent tools only — no raw
 * record tools — so an agent cannot write around src/server/core/ops.ts.
 * The website assistant has its own guarded tools in src/ai/assistant.ts.
 */

import type { ToolSet } from 'ai'
import type { AgentToolContext, UserToolExecutor } from 'deepspace/worker'
import type { Env } from '../../worker'
import { buildAgentTools } from './agent-tools'

export function buildTools(_executor: UserToolExecutor, context?: AgentToolContext<Env>): ToolSet {
  if (!context) return {}
  return buildAgentTools(context)
}
