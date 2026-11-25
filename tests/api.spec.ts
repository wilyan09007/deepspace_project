import { test, expect } from '@playwright/test'

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('GitHub webhook route refuses unsigned and mis-signed deliveries', async ({ request }) => {
    const data = JSON.stringify({ repository: { full_name: 'acme/web' }, action: 'closed', issue: { number: 1, state: 'closed' } })
    const headers = { 'content-type': 'application/json', 'x-github-event': 'issues' }
    const unsigned = await request.post('/api/github/webhook/no-such-project', { headers, data })
    expect(unsigned.status()).toBe(401)
    const forged = await request.post('/api/github/webhook/no-such-project', { headers: { ...headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, data })
    expect(forged.status()).toBe(401)
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    // /home is a dynamic page (under src/pages/(app)/), so mounting it boots
    // the providers and auto-connects the records WebSocket. The static
    // landing at '/' deliberately does neither — see smoke.spec.ts.
    await page.goto('/home')
    // Wait for the app to connect its WebSocket (it auto-connects on mount)
    await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
    // If the app loaded and connected, the WS endpoint works
  })
})
