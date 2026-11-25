/**
 * "Try a sample": loads a plan captured from one real planner run (see
 * docs/BUILD_NOTES.md phase 10), so people can see the board and run the
 * demo without spending credits. The UI labels it as a captured sample.
 */

import type { ImportEdges } from './engine'
import { type Goal, type Ops, type Project, type Task } from './ops'
import { savePlan } from './planner'
import { OpsError } from './store'
import { SAMPLE_PLAN } from './sample-plan'

export interface SamplePlan {
  repo: string
  branch: string
  description: string
  goalTitle: string
  goalBody: string
  summary: string
  model: string
  capturedAt: string
  tasks: Array<{ title: string; body: string; acceptance: string; predictedFiles: string[]; dependsOn: number[] }>
  importEdges: ImportEdges
}

export function sampleAvailable(): boolean {
  return SAMPLE_PLAN !== null
}

export async function loadSample(ops: Ops, teamId: string): Promise<{ projectId: string; goalId: string }> {
  await ops.requireMember(teamId)
  const sample = SAMPLE_PLAN
  if (!sample) throw new OpsError('sample_unavailable', 'The sample plan has not been captured yet', 503)
  const [owner, name] = sample.repo.split('/') as [string, string]

  let project = (await ops.store.query<Project>('projects', { teamId })).find((p) => p.data.kind === 'sample')
  if (!project) {
    const projectId = await ops.store.create<Project>('projects', {
      teamId,
      repoOwner: owner,
      repoName: name,
      defaultBranch: sample.branch,
      description: sample.description,
      kind: 'sample',
    })
    project = (await ops.store.get<Project>('projects', projectId))!
  }

  // Reuse an unfinished sample goal rather than stacking copies.
  for (const g of await ops.store.query<Goal>('goals', { projectId: project.recordId })) {
    const tasks = await ops.store.query<Task>('tasks', { goalId: g.recordId })
    if (g.data.source === 'sample' && tasks.some((t) => t.data.status !== 'done')) {
      return { projectId: project.recordId, goalId: g.recordId }
    }
  }

  const goalId = await ops.store.create<Goal>('goals', {
    teamId,
    projectId: project.recordId,
    title: sample.goalTitle,
    body: sample.goalBody,
    status: 'planning',
    planStage: 'loading sample',
    createdByName: await ops.userName(),
    source: 'sample',
    demoState: '',
  })
  const goal = (await ops.store.get<Goal>('goals', goalId))!
  await savePlan(ops, goal, { summary: sample.summary, tasks: sample.tasks, droppedFiles: [] }, sample.importEdges, `${sample.model} (captured ${sample.capturedAt})`)
  return { projectId: project.recordId, goalId }
}

/** A goal's plan in the SamplePlan shape (members only) — used to capture the sample. */
export async function exportPlan(ops: Ops, goalId: string): Promise<SamplePlan> {
  const goal = await ops.loadForMember<Goal>('goals', goalId, 'Goal')
  const project = await ops.loadForMember<Project>('projects', goal.data.projectId, 'Project')
  const tasks = (await ops.store.query<Task>('tasks', { goalId })).sort((a, b) => a.data.order - b.data.order)
  const index = new Map(tasks.map((t, i) => [t.recordId, i]))
  return {
    repo: `${project.data.repoOwner}/${project.data.repoName}`,
    branch: project.data.defaultBranch,
    description: project.data.description ?? '',
    goalTitle: goal.data.title,
    goalBody: goal.data.body ?? '',
    summary: goal.data.planSummary ?? '',
    model: goal.data.planModel ?? '',
    capturedAt: goal.createdAt.slice(0, 10),
    tasks: tasks.map((t) => ({
      title: t.data.title,
      body: t.data.body ?? '',
      acceptance: t.data.acceptance ?? '',
      predictedFiles: t.data.predictedFiles ?? [],
      dependsOn: (t.data.dependsOn ?? []).map((d) => index.get(d)).filter((i): i is number => i !== undefined),
    })),
    importEdges: goal.data.importEdges ?? {},
  }
}
