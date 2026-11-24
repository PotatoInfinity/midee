import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

// Wait HUD e2e — layout guards for the minimal wait-mode controls that live
// inside Play (no Learn tab). The HUD carries no loop pill: looping is
// sheet-driven (drag on #sheet-canvas creates it, .sheet-loop-x removes it).
//
// WHY THESE LIVE HERE AND NOT IN VITEST: every assertion below is about
// LAYOUT — rendered widths, stacking, overlap. jsdom implements no layout
// engine, so getBoundingClientRect() returns zeros there and the same
// assertions would pass without measuring anything.
//
// FLOW: load a file in Play, then press the top-bar clock (`#ts-wait`) to
// enable wait mode. The top bar itself never changes shape.

const FIXTURE_MID = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))

async function enterWait(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('#midi-input', FIXTURE_MID)
  const wait = page.locator('#ts-wait')
  await expect(wait).toBeVisible({ timeout: 15_000 })
  await wait.click()
  await expect(page.locator('.wait-hud')).toBeVisible({ timeout: 15_000 })
  await page.locator('.wait-hud').hover()
}

async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return box.width
}

test.describe('wait HUD', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await enterWait(page)
  })

  test('anchors to the top edge without stretching', async ({ page }) => {
    const box = await page.locator('.wait-hud').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeLessThan(200)
    expect(box!.height).toBeLessThan(240)
  })

  test('top bar keeps its shape when wait turns on', async ({ page }) => {
    // The wait pill lights up but the strip never reflows into a new layout.
    // Learn is gone: no mode segment, no home tile — wait lives in Play via
    // the clock pill, next to the sheet toggle and the theme quick-toggle.
    await expect(page.locator('#ts-wait.ts-pill--on')).toBeVisible()
    await expect(page.locator('#ts-sheet')).toBeVisible()
    await expect(page.locator('#ts-theme')).toBeVisible()
    await expect(page.locator('#ts-mode-play')).toBeVisible()
    await expect(page.locator('#ts-mode-live')).toBeVisible()
    await expect(page.locator('#ts-mode-learn')).toHaveCount(0)
    await expect(page.locator('#home-learn')).toHaveCount(0)
  })

  test('wait HUD carries no loop pill — looping lives on the sheet', async ({ page }) => {
    // Loop regions are created by dragging on #sheet-canvas and cleared with
    // .sheet-loop-x (see the drag test below). The HUD must not grow its own
    // loop control, or the transport row's no-overlap budget breaks.
    const hud = page.locator('.wait-hud')
    await expect(hud.locator('[id*="loop"], [class*="loop"]')).toHaveCount(0)
  })

  test('loop: drag on the sheet creates a region, x removes it', async ({ page }) => {
    if (!(await page.locator('#sheet-pane').isVisible())) {
      await page.locator('#ts-sheet').click()
    }
    await expect(page.locator('#sheet-canvas')).toBeVisible()

    // Drag across the staff to select a loop.
    const box = (await page.locator('#sheet-canvas').boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width / 2 - 120, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 8 })
    await page.mouse.up()

    await expect(page.locator('.sheet-loop-x')).toBeVisible()
    await page.locator('.sheet-loop-x').click()
    await expect(page.locator('.sheet-loop-x')).toBeHidden()
  })

  for (const width of [420, 480, 700, 780, 900, 940, 1280]) {
    test(`the transport row fits without overlap @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('.wait-hud').hover()
      await page.waitForTimeout(150)

      const hud = (await page.locator('.wait-hud').boundingBox())!
      const scrub = (await page.locator('#wait-scrubber').boundingBox())!
      const score = (await page.locator('.wait-hud__score').boundingBox())!

      expect(scrub.x).toBeGreaterThanOrEqual(hud.x - 1)
      expect(scrub.x + scrub.width).toBeLessThanOrEqual(hud.x + hud.width + 1)

      const overlapX =
        Math.min(scrub.x + scrub.width, score.x + score.width) - Math.max(scrub.x, score.x)
      const overlapY =
        Math.min(scrub.y + scrub.height, score.y + score.height) - Math.max(scrub.y, score.y)
      expect(overlapX > 0 && overlapY > 0).toBe(false)
      expect(scrub.width).toBeGreaterThan(40)
    })
  }
})
