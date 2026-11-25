/**
 * Conductor end-to-end: three real signed-in users against the local app.
 *
 * Alice creates a team and invites Bob; Eve is an outsider. The board uses the
 * dev-only fixture plan (no planner call, no credits), and the demo agents
 * drive it through the same server operations real agents use.
 *
 * Needs test accounts selectable as "Alice", "Bob" and "Eve":
 *   npx deepspace test accounts create --email <unique>@deepspace.test --name Alice --password-stdin
 */
import { test, expect, loadAllTestAccounts, type MultiplayerUser } from 'deepspace/testing'

const names = new Set(loadAllTestAccounts().map((a) => a.name))
test.skip(!['Alice', 'Bob', 'Eve'].every((n) => names.has(n)), 'Needs test accounts named Alice, Bob and Eve')

async function createTeam(alice: MultiplayerUser, name: string): Promise<string> {
  await alice.page.goto('/teams')
  await alice.page.getByLabel('Name').fill(name)
  await alice.page.getByRole('button', { name: 'Create team' }).click()
  await expect(alice.page).toHaveURL(/\/t\/[^/]+$/, { timeout: 20_000 })
  await expect(alice.page.getByTestId('team-name')).toHaveText(name)
  return alice.page.url().split('/t/')[1]!
}

async function invite(alice: MultiplayerUser): Promise<string> {
  await alice.page.getByRole('button', { name: 'Invite a teammate' }).click()
  const link = alice.page.getByTestId('invite-link').locator('input')
  await expect(link).toHaveValue(/\/join\/[A-Z0-9]{8}$/)
  return new URL(await link.inputValue()).pathname
}

test('teams: invite link joins a teammate; outsiders see nothing', async ({ users }) => {
  const [alice, bob, eve] = await users(['Alice', 'Bob', 'Eve'])
  const teamName = `E2E ${Date.now().toString(36)}`
  const teamId = await createTeam(alice!, teamName)
  const joinPath = await invite(alice!)

  await bob!.page.goto(joinPath)
  await expect(bob!.page).toHaveURL(new RegExp(`/t/${teamId}$`), { timeout: 20_000 })
  await expect(bob!.page.getByTestId('team-name')).toHaveText(teamName)
  await expect(bob!.page.getByTestId('members-panel')).toContainText('Alice')

  // The invite is single-use.
  await eve!.page.goto(joinPath)
  await expect(eve!.page.getByTestId('join-page')).toContainText(/already been used/)
  await eve!.page.goto(`/t/${teamId}`)
  await expect(eve!.page.getByTestId('team-not-found')).toBeVisible({ timeout: 15_000 })
})

test('board: demo agents work, overlap and ask; a teammate answers and steers live', async ({ users }) => {
  test.setTimeout(240_000)
  const [alice, bob, eve] = await users(['Alice', 'Bob', 'Eve'])
  const teamId = await createTeam(alice!, `Board ${Date.now().toString(36)}`)
  const joinPath = await invite(alice!)
  await bob!.page.goto(joinPath)
  await expect(bob!.page).toHaveURL(new RegExp(`/t/${teamId}$`), { timeout: 20_000 })

  // Locally: the dev-only fixture. Against a deployed app: the captured sample.
  if (process.env.LIVE_URL) await alice!.page.getByRole('button', { name: 'Load sample' }).click()
  else await alice!.page.getByTestId('dev-fixture').click()
  await expect(alice!.page).toHaveURL(/\/p\/[^/]+$/, { timeout: 20_000 })
  const boardPath = new URL(alice!.page.url()).pathname
  await expect(alice!.page.getByTestId('task-card')).toHaveCount(5)

  await bob!.page.goto(boardPath)
  await expect(bob!.page.getByTestId('task-card')).toHaveCount(5)

  // Outsider can't open the board.
  await eve!.page.goto(boardPath)
  await expect(eve!.page.getByTestId('project-not-found')).toBeVisible({ timeout: 15_000 })

  await alice!.page.getByTestId('start-demo').click()
  // Bob's board updates live: three demo agents appear and start working.
  await expect(bob!.page.getByTestId('agent-row')).toHaveCount(3, { timeout: 30_000 })
  await expect(bob!.page.getByTestId('activity-feed')).toContainText('took', { timeout: 30_000 })

  // The demo makes one deliberate overlap and asks one question.
  await expect(bob!.page.getByTestId('overlaps-list')).toBeVisible({ timeout: 90_000 })
  const answerBox = bob!.page.getByPlaceholder('Your answer')
  await expect(answerBox).toBeVisible({ timeout: 90_000 })
  await answerBox.fill('Keep the current behaviour as the default.')
  await bob!.page.getByTestId('questions-list').getByRole('button', { name: 'Answer', exact: true }).click()
  await expect(alice!.page.getByTestId('activity-feed')).toContainText('answered', { timeout: 20_000 })

  // Bob pauses a working agent; Alice sees it paused immediately.
  const working = bob!.page.getByTestId('agent-row').filter({ hasText: 'Working' }).first()
  await expect(working).toBeVisible({ timeout: 30_000 })
  const agentName = (await working.locator('span[title]').first().innerText()).trim()
  await working.getByRole('button', { name: 'Pause' }).click()
  const aliceRow = alice!.page.getByTestId('agent-row').filter({ hasText: agentName })
  await expect(aliceRow).toContainText('Paused', { timeout: 15_000 })
  await expect(alice!.page.getByTestId('activity-feed')).toContainText(`paused ${agentName}`)

  // Resume, then stop the demo; held tasks go back to Ready.
  await aliceRow.getByRole('button', { name: 'Resume' }).click()
  await expect(aliceRow).not.toContainText('Paused', { timeout: 15_000 })
  await alice!.page.getByTestId('stop-demo').click()
  await expect(alice!.page.getByTestId('start-demo')).toBeVisible({ timeout: 30_000 })
  await expect(bob!.page.getByTestId('activity-feed')).toContainText('demo run ended', { timeout: 30_000 })
})

test('billing: a user without credits is told plainly (test accounts have none)', async ({ users }) => {
  const [alice] = await users(['Alice'])
  await createTeam(alice!, `Credits ${Date.now().toString(36)}`)
  await alice!.page.getByPlaceholder(/owner\/repo/).fill('gothinkster/react-redux-realworld-example-app')
  await alice!.page.getByRole('button', { name: 'Add project' }).click()
  await expect(alice!.page.getByText(/out of credits/)).toBeVisible({ timeout: 20_000 })
})

test("digest: generated on demand for free; emailing it bills the clicker, not the owner", async ({ users }) => {
  const [alice] = await users(['Alice'])
  const teamName = `Digest ${Date.now().toString(36)}`
  await createTeam(alice!, teamName)
  const panel = alice!.page.getByTestId('digests-panel')
  await panel.getByRole('button', { name: "Generate today's digest" }).click()
  await expect(panel.getByTestId('digest')).toHaveCount(1, { timeout: 15_000 })
  await expect(panel.getByTestId('digest')).toContainText('created the team')
  // Test accounts have no credits, so a user-billed send is refused — proof the owner isn't paying.
  await panel.getByRole('button', { name: 'Email me' }).click()
  await expect(alice!.page.getByText(/out of credits/)).toBeVisible({ timeout: 20_000 })
})

test('new goal: the button opens the dialog, planning starts, and its outcome shows on the board', async ({ users }) => {
  // Runs locally only: it needs the dev fixture's empty repo project.
  test.skip(!!process.env.LIVE_URL, 'Local only')
  const [alice] = await users(['Alice'])
  await createTeam(alice!, `Goal ${Date.now().toString(36)}`)
  await alice!.page.getByTestId('dev-repo-fixture').click()
  await expect(alice!.page).toHaveURL(/\/p\/[^/]+$/, { timeout: 20_000 })
  const page = alice!.page

  await expect(page.getByText('No goals yet')).toBeVisible()
  await page.getByTestId('new-goal').click()
  const dialog = page.getByRole('dialog', { name: 'New goal' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Plan it' })).toBeDisabled()
  await dialog.getByLabel('Title').fill('Add a dark mode toggle')
  // A title alone isn't enough: the instructions are what agents get.
  await expect(dialog.getByRole('button', { name: 'Plan it' })).toBeDisabled()
  await dialog.getByLabel('Instructions for agents').fill('Add a dark mode toggle to Settings and persist the choice.')
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/new-goal.png` })
  await dialog.getByRole('button', { name: 'Plan it' }).click()

  // The goal appears at once with its live planning status…
  await expect(page.getByRole('tab', { name: /Add a dark mode toggle/ })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('goal-header')).toContainText('Add a dark mode toggle')
  await expect(page.getByTestId('goal-instructions')).toHaveText('Add a dark mode toggle to Settings and persist the choice.')
  // …and the planner really ran: test accounts have no credits, so it stops at the first paid GitHub read
  // and the board says so, with a Retry button.
  await expect(page.getByTestId('goal-header')).toContainText(/out of credits/, { timeout: 30_000 })
  await expect(page.getByTestId('goal-header').getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(page.getByTestId('activity-feed')).toContainText('set a goal: Add a dark mode toggle')
})

test('review gate: submitted work waits in Review; approve from the inbox, send back from the task', async ({ users }) => {
  test.skip(!!process.env.LIVE_URL, 'Local only (uses the dev fixture)')
  test.setTimeout(240_000)
  const [alice, bob] = await users(['Alice', 'Bob'])
  const teamId = await createTeam(alice!, `Review ${Date.now().toString(36)}`)
  await bob!.page.goto(await invite(alice!))
  await expect(bob!.page).toHaveURL(new RegExp(`/t/${teamId}$`), { timeout: 20_000 })
  await alice!.page.getByTestId('dev-fixture').click()
  await expect(alice!.page.getByTestId('task-card')).toHaveCount(5, { timeout: 20_000 })
  const board = new URL(alice!.page.url()).pathname
  await alice!.page.getByTestId('start-demo').click()

  // Answer the demo's question so agents can finish; wait for two submissions.
  const review = alice!.page.getByRole('region', { name: 'Review' })
  const answer = alice!.page.getByPlaceholder('Your answer')
  await expect(async () => {
    if (await answer.isVisible()) {
      await answer.fill('Keep the default.')
      await alice!.page.getByTestId('questions-list').getByRole('button', { name: 'Answer', exact: true }).click()
    }
    await expect(review.getByTestId('task-card')).toHaveCount(2, { timeout: 3_000 })
  }).toPass({ timeout: 180_000 })
  await alice!.page.getByTestId('stop-demo').click()

  // Bob's inbox shows the reviews (and the nav badge counts them); he approves one there.
  await bob!.page.goto('/inbox')
  await expect(bob!.page.getByTestId('inbox-count')).toBeVisible()
  const first = bob!.page.getByTestId('inbox-review').first()
  const approvedTitle = (await first.getByRole('link').first().innerText()).trim()
  await first.getByRole('button', { name: 'Approve' }).click()
  await expect(alice!.page.getByRole('region', { name: 'Done' })).toContainText(approvedTitle, { timeout: 15_000 })

  // Alice sends the other back from the task itself, with a note; it returns to Ready showing the note and its history.
  await review.getByTestId('task-card').first().click()
  const detail = alice!.page.getByTestId('task-detail')
  await expect(detail.getByTestId('task-history')).toContainText('submitted')
  await detail.getByRole('button', { name: 'Request changes' }).click()
  await detail.getByLabel('What should change?').fill('Add a test for the empty state.')
  await detail.getByRole('button', { name: 'Send back' }).click()
  await expect(alice!.page.getByRole('region', { name: 'Ready' })).toContainText('Changes requested: Add a test for the empty state.', { timeout: 15_000 })

  // Deep link (as used in GitHub issue footers) opens a task directly.
  const anyCard = alice!.page.getByTestId('task-card').first()
  await anyCard.click()
  const taskUrl = alice!.page.url()
  expect(taskUrl).toContain('?task=')
  await bob!.page.goto(taskUrl.replace(/^https?:\/\/[^/]+/, ''))
  await expect(bob!.page.getByTestId('task-detail')).toBeVisible({ timeout: 15_000 })
  expect(board).toBeTruthy()
})

test('github panel: offered on repo projects (connect first), not on samples', async ({ users }) => {
  test.skip(!!process.env.LIVE_URL, 'Local only (uses the dev fixture)')
  const [alice] = await users(['Alice'])
  const teamId = await createTeam(alice!, `GH ${Date.now().toString(36)}`)
  await alice!.page.getByTestId('dev-repo-fixture').click()
  await expect(alice!.page.getByTestId('github-section')).toBeVisible({ timeout: 20_000 })
  // Test accounts have no GitHub connection.
  await expect(alice!.page.getByTestId('connect-github')).toBeVisible({ timeout: 20_000 })
  await alice!.page.goto(`/t/${teamId}`)
  await alice!.page.getByTestId('dev-fixture').click()
  await expect(alice!.page.getByTestId('task-card')).toHaveCount(5, { timeout: 20_000 })
  await expect(alice!.page.getByTestId('github-section')).toHaveCount(0)
})

test('instant feedback: clicks show their result before the server answers, and undo if it fails', async ({ users }) => {
  test.skip(!!process.env.LIVE_URL, 'Local only (uses the dev fixture)')
  test.setTimeout(180_000)
  const [alice] = await users(['Alice'])
  await createTeam(alice!, `Instant ${Date.now().toString(36)}`)
  const page = alice!.page
  await page.getByTestId('dev-fixture').click()
  await expect(page.getByTestId('task-card')).toHaveCount(5, { timeout: 20_000 })

  // Slow the server down by 3 s for these actions; the screen must change well before that.
  const slow = async (route: import('@playwright/test').Route) => {
    await new Promise((r) => setTimeout(r, 3000))
    await route.continue()
  }
  await page.route('**/api/actions/startDemo', slow)
  await page.getByTestId('start-demo').click()
  await expect(page.getByTestId('stop-demo')).toBeVisible({ timeout: 1000 })

  const working = page.getByTestId('agent-row').filter({ hasText: 'Working' }).first()
  await expect(working).toBeVisible({ timeout: 60_000 })
  const name = (await working.locator('span[title]').first().innerText()).trim()
  const row = page.getByTestId('agent-row').filter({ hasText: name })

  await page.route('**/api/actions/sendDirective', slow)
  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row).toContainText('Paused', { timeout: 1000 })
  await expect(row).toContainText('Paused', { timeout: 10_000 }) // and it stays paused once the server confirms
  await page.unroute('**/api/actions/sendDirective')

  // A failing action snaps back and says why.
  await page.route('**/api/actions/sendDirective', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Simulated failure', code: 'test' }) }),
  )
  await row.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText('Simulated failure')).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText('Paused')
  await page.unroute('**/api/actions/sendDirective')
  await page.getByTestId('stop-demo').click()
})
