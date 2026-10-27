import { test, expect } from '@playwright/test';

// Run against the built server with PLAYWRIGHT_BASE_URL (default port 3000).
for (const width of [360, 390, 430]) {
  test(`mobile footer uses the capsule geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000');
    const nav = page.locator('.ik-mobile-nav');
    await expect(nav).toBeVisible();
    await expect(nav).toHaveCSS('height', '46px');
    const box = await nav.boundingBox();
    expect(box?.x).toBe(8);
    expect(box?.width).toBe(width - 16);
    await expect(nav.locator('.ik-mobile-nav__inner').first()).toHaveCSS('transform', 'none');
    await expect(nav.locator('.ik-mobile-nav__create-btn')).toHaveCSS('height', '30px');
    const activeBox = await nav.locator('.is-active').boundingBox();
    const labelBox = await nav.locator('.is-active .ik-mobile-nav__label').boundingBox();
    // Optical correction: label sits 2px right of the geometric bubble center.
    expect((labelBox!.x + labelBox!.width / 2) - (activeBox!.x + activeBox!.width / 2)).toBeCloseTo(2, 0);
    const frames = await nav.locator('.is-active').evaluate((element) => {
      const animation = element.getAnimations({ subtree: true }).find(
        a => (a as CSSAnimation).animationName === 'ik-nav-plate-breathe',
      )!;
      const running = animation.playState;
      animation.pause();
      const sample = (time: number) => {
        animation.currentTime = time;
        const style = getComputedStyle(element, '::before');
        return { left: parseFloat(style.left), right: parseFloat(style.right), height: parseFloat(style.height) };
      };
      const result = { running, small: sample(0), large: sample(400) };
      animation.play();
      return result;
    });
    expect(frames.running).toBe('running');
    expect(frames.small.left).toBe(0);
    expect(frames.small.left).toBeCloseTo(frames.small.right, 1);
    expect(frames.large.left).toBeLessThan(0);
    expect(frames.large.right).toBeCloseTo(frames.large.left, 1);
    expect(frames.large.right).toBeLessThan(frames.small.right);
    expect(frames.large.height).toBeGreaterThan(frames.small.height);
  });
}
