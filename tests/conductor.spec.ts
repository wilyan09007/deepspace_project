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
