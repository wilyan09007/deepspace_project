/**
 * Conductor's agent tools — what a developer's local coding agent (Claude
 * Code, Codex, …) calls through `npx deepspace agent invoke conductor <tool>`.
 *
 * Each tool is a thin wrapper over src/server/core/ops.ts, which checks the
 * caller is in the team and owns the agent. The CLI's agent token identifies
 * the signed-in developer (`context.userId`).
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { AgentToolError, type AgentToolContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import { makeOps } from '../server/core/runtime'
import { OpsError } from '../server/core/store'
import type { Ops } from '../server/core/ops'

const agentId = z.string().min(1).describe('The agent_id returned by register_agent.')

/** Run an op and turn refusals into readable tool errors. */
async function run<T>(context: AgentToolContext<Env>, fn: (ops: Ops) => Promise<T>): Promise<T> {
  try {
    // The route verified this bearer token; it is only read here for the caller's display name.
    const bearer = context.request.headers.get('Authorization')?.replace(/^Bearer /, '')
    return await fn(makeOps(context.env, context.userId, undefined, bearer))
  } catch (e) {
    if (e instanceof OpsError) throw new AgentToolError(e.code, e.message, e.status)
    console.error(`[agent-tool] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    throw new AgentToolError('internal', 'Conductor hit an error; try again in a moment.', 500)
  }
}

export const AGENT_LOOP = `Loop: register_agent once → next_task → do the task, calling check_in after each meaningful step (every few minutes) with the files you touched → complete_task → next_task again. Always obey directives returned by next_task/check_in (pause = stop editing; reassign = drop the task). Read overlaps: another agent is working in or next to those files, so coordinate by keeping changes small there.`

export function buildAgentTools(context: AgentToolContext<Env>): ToolSet {
  return {
    list_projects: tool({
      description: 'List the Conductor projects (GitHub repos) in the teams you belong to, with their project ids.',
      inputSchema: z.object({}),
      execute: () => run(context, (ops) => ops.myProjects()),
    }),
    register_agent: tool({
      description: `Register this coding agent on a project and get its agent_id. Call once per session; the same name returns the same agent. ${AGENT_LOOP}`,
      inputSchema: z.object({
        project: z.string().min(1).describe('Project id, or the repository as owner/repo.'),
        name: z.string().min(1).max(40).describe('A short name for this agent, e.g. "claude-1" or "codex-laptop".'),
      }),
      execute: ({ project, name }) =>
        run(context, async (ops) => {
          const projectId = await ops.resolveProject(project)
          const res = await ops.registerAgent(projectId, name, 'cli')
          return { ...res, projectId, next: 'Call next_task with this agent_id.' }
        }),
    }),
    next_task: tool({
      description: 'Get your task. Returns your current task if you have one, otherwise assigns the ready task that overlaps least with other agents. Also returns directives from humans, overlap warnings, the task\'s GitHub issue, how to word your PR so Conductor links it, and — if someone worked on it before or a reviewer sent it back — that history.',
      inputSchema: z.object({ agent_id: agentId }),
      execute: ({ agent_id }) => run(context, (ops) => ops.nextTask(agent_id)),
    }),
    check_in: tool({
      description: 'Report progress. Send what you are doing and every file you have edited or are about to edit. Returns directives from humans (obey them), overlap warnings, and answers to your questions.',
      inputSchema: z.object({
        agent_id: agentId,
        status: z.enum(['working', 'blocked']).default('working').describe('working, or blocked (waiting on something)'),
        summary: z.string().max(1000).describe('One or two sentences on what you are doing now.'),
        files: z.array(z.string()).max(50).default([]).describe('Repo-relative paths you edited or are about to edit.'),
      }),
      execute: ({ agent_id, status, summary, files }) => run(context, (ops) => ops.checkIn(agent_id, { status, summary, files })),
    }),
    ask_human: tool({
      description: 'Ask the team a question. It appears on the Conductor board; the answer comes back in a later check_in. Keep working on other parts meanwhile, or check_in with status "blocked".',
      inputSchema: z.object({ agent_id: agentId, question: z.string().min(1).max(1000) }),
      execute: ({ agent_id, question }) => run(context, (ops) => ops.askHuman(agent_id, question)),
    }),
    complete_task: tool({
      description: 'Submit your current task for human review when the work is done. Include the pull request URL if you opened one (it must be a PR in the project repo; never invent a URL). A teammate approves it, or sends it back with notes that next_task will give you first. A merged PR also counts as approval.',
      inputSchema: z.object({
        agent_id: agentId,
        summary: z.string().max(1000).describe('What you changed.'),
        pr_url: z.string().max(300).optional().describe('https://github.com/<owner>/<repo>/pull/<n>, only if a PR exists.'),
      }),
      execute: ({ agent_id, summary, pr_url }) => run(context, (ops) => ops.completeTask(agent_id, { summary, prUrl: pr_url })),
    }),
    get_task: tool({
      description: 'Read a task in your project (your current task if task_id is omitted), with its goal, acceptance check, files and dependencies.',
      inputSchema: z.object({ agent_id: agentId, task_id: z.string().optional() }),
      execute: ({ agent_id, task_id }) => run(context, (ops) => ops.getTask(agent_id, task_id)),
    }),
  }
}
