import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const HOME_TITLE = 'midee - Free Online MIDI Player & Synthesia Alternative'
const FIXTURE_MID = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))

test.describe('App navigation accessibility', () => {
  test('the skip link stays offscreen before the app stylesheet loads', async ({ page }) => {
    await page.route('**/*.css', (route) => route.abort())
    await page.goto('/?lang=en')
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).not.toBeInViewport()
    await page.keyboard.press('Tab')
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
  })

  test('the first Tab reveals a skip link and Enter bypasses the top strip', async ({ page }) => {
    await page.goto('/?lang=en')
    await expect(page.locator('#home-open')).toBeVisible()
    await expect(page).toHaveTitle(HOME_TITLE)
    await expect(page.getByRole('main')).toHaveCount(1)
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).not.toBeInViewport()
    await page.keyboard.press('Tab')
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await page.keyboard.press('Enter')
    await expect(page.locator('#home-open')).toBeFocused()
    // Native keyboard navigation continues from the content, not the top strip.
    await page.keyboard.press('Tab')
    await expect(page.locator('#home-live')).toBeFocused()
    await expect(page).toHaveURL(/\?lang=en$/)
  })

  test('skip navigation follows Live mode and works when the HUD is collapsed', async ({ page }) => {
    await page.goto('/?lang=en')
    await page.locator('#home-live').click()
    await expect(page.locator('#hud-metro')).toBeVisible()
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await skip.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#hud-metro')).toBeFocused()
    await page.locator('#hud .float-hud__close').click()
    await skip.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#hud .float-hud__reopen')).toBeFocused()
    await page.locator('#ts-home').click()
    await expect(page).toHaveTitle(HOME_TITLE)
    await skip.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#home-open')).toBeFocused()
  })

  test('skip navigation reaches play wait mode', async ({ page }) => {
    await page.goto('/?lang=en')
    // Learn tab is gone — wait lives inside Play via the top-bar clock.
    await expect(page.locator('#ts-mode-learn')).toHaveCount(0)
    await expect(page.locator('#home-learn')).toHaveCount(0)
    // ...and wait mode itself is reachable: load a file, flip the clock pill,
    // and the wait HUD appears next to the sheet/theme pills.
    await page.setInputFiles('#midi-input', FIXTURE_MID)
    const wait = page.locator('#ts-wait')
    await expect(wait).toBeVisible({ timeout: 15_000 })
    await wait.click()
    await expect(page.locator('.wait-hud')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#ts-sheet')).toBeVisible()
    await expect(page.locator('#ts-theme')).toBeVisible()
  })

  test('localized home metadata and skip link use the selected language', async ({ page }) => {
    await page.goto('/?lang=fr')
    await expect(page.locator('#home-open')).toBeVisible()
    await expect(page).toHaveTitle('midee - Lecteur MIDI gratuit en ligne et alternative à Synthesia')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Aller au contenu principal' })).toBeFocused()
  })
})
