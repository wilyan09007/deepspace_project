/**
 * Captures the main screens mid-demo for design review and the README.
 * Skipped unless SCREENSHOT_DIR is set:
 *   SCREENSHOT_DIR=/tmp/shots npx deepspace test run e2e --grep screens
 */
import { test, expect } from 'deepspace/testing'

const dir = process.env.SCREENSHOT_DIR
test.skip(!dir, 'Set SCREENSHOT_DIR to capture screenshots')

test('screens', async ({ users, browser }) => {
  test.setTimeout(180_000)
  const [alice] = await users(['Alice'])
  const page = alice!.page
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/teams')
  await page.getByLabel('Name').fill('Platform squad')
  await page.getByRole('button', { name: 'Create team' }).click()
  await expect(page).toHaveURL(/\/t\/[^/]+$/)
  await page.getByRole('button', { name: 'Invite a teammate' }).click()
  await expect(page.getByTestId('invite-link')).toBeVisible()
  await page.screenshot({ path: `${dir}/team.png`, fullPage: true })
  await page.getByTestId('dev-fixture').click()
  await expect(page.getByTestId('task-card')).toHaveCount(5)
  await page.getByTestId('start-demo').click()
  await expect(page.getByTestId('overlaps-list')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByPlaceholder('Your answer')).toBeVisible({ timeout: 90_000 })
  await page.screenshot({ path: `${dir}/board.png`, fullPage: true })
  const board = page.url()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${dir}/board-mobile.png`, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${board}/connect`)
  await expect(page.getByTestId('agent-instructions')).toBeVisible()
  await page.screenshot({ path: `${dir}/connect.png`, fullPage: true })
  await page.goto('/teams')
  await page.screenshot({ path: `${dir}/teams.png` })
  await page.goto(board)
  await page.getByTestId('stop-demo').click()
  const anon = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await anon.goto(new URL('/', board).toString())
  await anon.screenshot({ path: `${dir}/landing.png`, fullPage: true })
})
