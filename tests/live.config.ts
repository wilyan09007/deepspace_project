/**
 * Runs the Conductor specs against a deployed app instead of a local server:
 *   LIVE_URL=https://conductor.app.space npx playwright test -c tests/live.config.ts
 * Uses the real sample (production refuses the dev fixture). No billed calls.
 */
import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

export default defineConfig({
  testDir: '.',
  testMatch: 'conductor.spec.ts',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: process.env.LIVE_URL ?? 'https://conductor.app.space', headless: true, launchOptions: chromiumLaunchOptions() },
})
