/**
 * Dev/test-only fixture: a small fixed plan so the board, demo and steering
 * can be exercised locally without spending credits on the planner. The
 * action that calls this refuses unless ALLOW_DEBUG_ROUTES is "true", which
 * only `deepspace dev`/`deepspace test` set — never production.
 */

import { type Goal, type Ops, type Project } from './ops'
import { savePlan } from './planner'

export async function seedDevFixture(ops: Ops, teamId: string): Promise<{ projectId: string; goalId: string }> {
  await ops.requireMember(teamId)
  const projectId = await ops.store.create<Project>('projects', {
    teamId,
    repoOwner: 'conductor-fixtures',
    repoName: 'demo-app',
    defaultBranch: 'main',
    description: 'Dev-only test fixture (not a real repository or plan).',
    kind: 'sample',
  })
  const goalId = await ops.store.create<Goal>('goals', {
    teamId,
    projectId,
    title: 'Add dark mode to the settings page',
    body: '',
    status: 'planning',
    planStage: 'loading fixture',
    createdByName: await ops.userName(),
    source: 'sample',
    demoState: '',
  })
  const goal = (await ops.store.get<Goal>('goals', goalId))!
  const t = (title: string, files: string[], dependsOn: number[] = []) => ({ title, body: `Fixture task: ${title}.`, acceptance: 'Fixture.', predictedFiles: files, dependsOn })
  await savePlan(
    ops,
    goal,
    {
      summary: 'Dev-only fixture plan.',
      droppedFiles: [],
      tasks: [
        t('Add dark palette tokens', ['src/theme.ts']),
        t('Build the settings toggle', ['src/settings/Toggle.tsx', 'src/settings/Settings.tsx']),
        t('Persist the preference', ['src/settings/storage.ts']),
        t('Wire the theme into the app shell', ['src/App.tsx'], [0]),
        t('Document the theme API', ['docs/theming.md']),
      ],
    },
    { 'src/settings/Settings.tsx': ['src/settings/Toggle.tsx', 'src/theme.ts'], 'src/App.tsx': ['src/theme.ts'] },
    'dev fixture',
  )
  return { projectId, goalId }
}
