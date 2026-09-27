import { test } from '@playwright/test';
test('invoice', async ({ page }) => { await page.goto('/invoice'); });
