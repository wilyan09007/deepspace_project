/**
 * Demo mode: three scripted agents work a planned goal through the same
 * operations real agents use, so everything on the board (assignment,
 * check-ins, an overlap, a question, obeying pause/resume/reassign) happens
 * for real. No AI and no integrations: the demo costs nothing.
 *
 * The demo job ticks every few seconds; each tick moves one agent one step.
 */

import { DEMO_MAX_TICKS } from './config'
import { type Agent, type Goal, type Ops, type Project, type Question, type Task } from './ops'
import { OpsError, type Row } from './store'

export const DEMO_AGENT_NAMES = ['Demo · Ada', 'Demo · Grace', 'Demo · Linus'] as const

export interface DemoPayload {
  projectId: string
  goalId: string
  agentIds: string[]
}

export interface DemoState {
  tick: number
  /** Steps taken on each task (taskId → count). */
  steps: Record<string, number>
  asked: boolean
  overlapMade: boolean
}

export const initialDemoState = (): DemoState => ({ tick: 0, steps: {}, asked: false, overlapMade: false })

/** The goal a demo should run on: the newest planned/active goal with open tasks. */
async function demoGoal(ops: Ops, projectId: string): Promise<Row<Goal>> {
  const goals = (await ops.store.query<Goal>('goals', { projectId })).filter(
    (g) => g.data.status === 'planned' || g.data.status === 'active',
  )
  goals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const g of goals) {
    const tasks = await ops.store.query<Task>('tasks', { goalId: g.recordId })
    if (tasks.some((t) => t.data.status !== 'done')) return g
  }
  throw new OpsError('nothing_to_demo', 'There is no planned goal with open tasks. Plan a goal or load the sample first.', 409)
}

/** Check access, pick the goal, create (or reuse) the demo agents, mark the goal's demo running. */
export async function prepareDemo(ops: Ops, projectId: string): Promise<DemoPayload> {
  await ops.loadForMember<Project>('projects', projectId, 'Project')
  const goal = await demoGoal(ops, projectId)
  if (goal.data.demoState === 'running' || goal.data.demoState === 'stopping') {
    throw new OpsError('demo_running', 'A demo is already running on this goal', 409)
  }
  const agentIds: string[] = []
  for (const name of DEMO_AGENT_NAMES) {
    const { agentId } = await ops.registerAgent(projectId, name, 'demo')
    await ops.store.update<Agent>('agents', agentId, { status: 'idle' })
    agentIds.push(agentId)
  }
  await ops.store.update<Goal>('goals', goal.recordId, { demoState: 'running' })
  await ops.log({ teamId: goal.data.teamId, projectId, kind: 'demo', message: `started a demo run on “${goal.data.title}”` })
  return { projectId, goalId: goal.recordId, agentIds }
}

export async function requestStopDemo(ops: Ops, projectId: string): Promise<void> {
  await ops.loadForMember<Project>('projects', projectId, 'Project')
  for (const g of await ops.store.query<Goal>('goals', { projectId })) {
    if (g.data.demoState === 'running') await ops.store.update<Goal>('goals', g.recordId, { demoState: 'stopping' })
  }
}

/** Release whatever the demo agents still hold and mark the run stopped. */
export async function finishDemo(ops: Ops, payload: DemoPayload, reason: string): Promise<void> {
  for (const agentId of payload.agentIds) {
    const agent = await ops.store.get<Agent>('agents', agentId)
    if (!agent) continue
    if (agent.data.currentTaskId) {
      const task = await ops.store.get<Task>('tasks', agent.data.currentTaskId)
      if (task && task.data.status !== 'done') {
        for (const c of await ops.store.query<{ taskId: string }>('task_claims', { taskId: task.recordId })) {
          await ops.store.remove('task_claims', c.recordId)
        }
        await ops.store.update<Task>('tasks', task.recordId, { status: 'ready', agentId: null })
      }
    }
    await ops.store.update<Agent>('agents', agentId, { status: 'offline', currentTaskId: null })
  }
  const goal = await ops.store.get<Goal>('goals', payload.goalId)
  if (goal) {
    await ops.store.update<Goal>('goals', goal.recordId, { demoState: 'stopped' })
    await ops.recomputeOverlaps(goal.data.teamId, goal.data.projectId)
    await ops.log({ teamId: goal.data.teamId, projectId: goal.data.projectId, kind: 'demo', message: `demo run ended: ${reason}`, actorName: 'Conductor' })
  }
}

function pick<T>(items: readonly T[], i: number): T | undefined {
  return items.length ? items[i % items.length] : undefined
}

/**
 * Advance the demo by one step. Returns `done: true` when the run should end
 * (all tasks done, stop requested, or the tick limit reached) — the caller
 * then calls `finishDemo`.
 */
export async function demoTick(ops: Ops, payload: DemoPayload, state: DemoState): Promise<{ done: boolean; reason?: string; state: DemoState }> {
  const next: DemoState = { ...state, steps: { ...state.steps }, tick: state.tick + 1 }
  const goal = await ops.store.get<Goal>('goals', payload.goalId)
  if (!goal) return { done: true, reason: 'the goal was removed', state: next }
  if (goal.data.demoState !== 'running') return { done: true, reason: 'stopped by a teammate', state: next }
  const goalTasks = await ops.store.query<Task>('tasks', { goalId: payload.goalId })
  if (goalTasks.length && goalTasks.every((t) => t.data.status === 'done')) return { done: true, reason: 'every task is done', state: next }
  if (next.tick > DEMO_MAX_TICKS) return { done: true, reason: 'time limit reached', state: next }

  const agentId = payload.agentIds[state.tick % payload.agentIds.length]!
  const agent = await ops.store.get<Agent>('agents', agentId)
  if (!agent) return { done: false, state: next }

  // Paused agents only check in (that's how they hear "resume").
  if (agent.data.status === 'paused') {
    await ops.checkIn(agentId, { summary: 'Paused — waiting for a teammate to resume me.' })
    return { done: false, state: next }
  }

  if (!agent.data.currentTaskId) {
    await ops.nextTask(agentId)
    return { done: false, state: next }
  }

  const task = await ops.store.get<Task>('tasks', agent.data.currentTaskId)
  if (!task) return { done: false, state: next }
  const step = (next.steps[task.recordId] ?? 0) + 1
  next.steps[task.recordId] = step
  const files = task.data.predictedFiles ?? []
  const first = pick(files, 0)

  if (step === 1) {
    await ops.checkIn(agentId, { status: 'working', summary: `Reading ${first ?? 'the code'} to plan “${task.data.title}”.`, files: first ? [first] : [] })
  } else if (step === 2) {
    const touch = [...files]
    let summary = `Editing ${files.length ? files.slice(0, 3).join(', ') : 'the relevant files'}.`
    if (!next.overlapMade) {
      // Deliberately reach into another active task's file so the board shows an overlap.
      const others = (await ops.store.query<Task>('tasks', { projectId: payload.projectId })).filter(
        (t) => t.recordId !== task.recordId && t.data.agentId && t.data.status !== 'done' && (t.data.predictedFiles ?? []).length,
      )
      const shared = others.map((t) => t.data.predictedFiles!.find((f) => !files.includes(f))).find(Boolean)
      if (shared) {
        touch.push(shared)
        summary += ` Also need a small change in ${shared}.`
        next.overlapMade = true
      }
    }
    await ops.checkIn(agentId, { status: 'working', summary, files: touch })
  } else if (step === 3 && !next.asked) {
    next.asked = true
    await ops.askHuman(agentId, `For “${task.data.title}”: should I keep the current behaviour as the default, or switch everyone to the new one?`)
    await ops.checkIn(agentId, { status: 'blocked', summary: 'Asked the team a question; waiting for an answer.' })
  } else {
    const open = (await ops.store.query<Question>('questions', { agentId })).some(
      (q) => q.data.status === 'open' && q.data.taskId === task.recordId,
    )
    if (open && step < 8) {
      await ops.checkIn(agentId, { status: 'blocked', summary: 'Still waiting for an answer to my question.' })
    } else if (step === 3 || (step === 4 && !open)) {
      await ops.checkIn(agentId, { status: 'review', summary: 'Changes made; running the checks.' })
    } else {
      await ops.completeTask(agentId, { summary: `Done: ${task.data.title}. (Demo agent — no real code was changed.)` })
    }
  }
  return { done: false, state: next }
}
