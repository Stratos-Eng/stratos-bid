import { test, expect, Page } from '@playwright/test';

// Helper to check if we're on the login page
async function isOnLoginPage(page: Page): Promise<boolean> {
  const loginButton = page.getByRole('button', { name: /continue with google|sign in/i });
  return (await loginButton.count() > 0);
}

test.describe('Quick Diagnostic Test', () => {
  test('Quick diagnostic of app state and routes', async ({ page }) => {
    console.log('\n========================================');
    console.log('QUICK DIAGNOSTIC TEST - APP STATUS');
    console.log('========================================\n');

    // Test 1: Homepage
    console.log('[1/5] Testing homepage...');
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.screenshot({ path: 'diagnostic-homepage.png', fullPage: true });
    const isAuth = await isOnLoginPage(page);
    console.log(`  - Homepage loaded: ${isAuth ? 'REQUIRES AUTH' : 'AUTHENTICATED'}`);

    if (isAuth) {
      console.log('\n⚠️  AUTHENTICATION REQUIRED');
      console.log('Cannot proceed with automated testing without valid session.');
      console.log('Please ensure you have a valid authentication session.\n');
      return;
    }

    // Test 2: Projects page
    console.log('\n[2/5] Testing projects page...');
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.screenshot({ path: 'diagnostic-projects.png', fullPage: true });

    const newProjectBtn = page.locator('button:has-text("New Project"), a:has-text("New Project")').first();
    const hasNewBtn = await newProjectBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`  - New Project button: ${hasNewBtn ? 'FOUND' : 'NOT FOUND'}`);

    const existingProjects = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') });
    const projectCount = await existingProjects.count();
    console.log(`  - Existing projects: ${projectCount}`);

    // Test 3: Check for PDF upload capability
    console.log('\n[3/5] Testing PDF upload interface...');
    await page.goto('http://localhost:3000/projects/new');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.screenshot({ path: 'diagnostic-new-project.png', fullPage: true });

    const fileInput = page.locator('input[type="file"]').first();
    const hasFileInput = await fileInput.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`  - File input element: ${hasFileInput ? 'FOUND' : 'NOT FOUND'}`);

    const uploadZone = page.locator('text=/drop|drag|browse|upload/i');
    const hasUploadZone = await uploadZone.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`  - Upload zone UI: ${hasUploadZone ? 'FOUND' : 'NOT FOUND'}`);

    // Test 4: Check existing project if available
    if (projectCount > 0) {
      console.log('\n[4/5] Testing existing project view...');
      await page.goto('http://localhost:3000/projects');
      await page.waitForLoadState('networkidle');

      const firstProject = existingProjects.first();
      await firstProject.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'diagnostic-project-view.png', fullPage: true });

      const pdfCanvas = page.locator('canvas').first();
      const hasPdfCanvas = await pdfCanvas.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`  - PDF viewer canvas: ${hasPdfCanvas ? 'FOUND' : 'NOT FOUND'}`);

      if (hasPdfCanvas) {
        const bbox = await pdfCanvas.boundingBox();
        if (bbox) {
          console.log(`  - Canvas dimensions: ${bbox.width}x${bbox.height}`);
        }
      }

      const lineItemsContainer = page.locator('div[class*="item"], tr, table');
      const hasItems = await lineItemsContainer.count();
      console.log(`  - Line item elements: ${hasItems} found`);
    } else {
      console.log('\n[4/5] Skipping project view (no existing projects)');
    }

    // Test 5: Console errors check
    console.log('\n[5/5] Checking for console errors...');
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('http://localhost:3000/projects');
    await page.waitForTimeout(2000);

    if (errors.length > 0) {
      console.log(`  - Console errors: ${errors.length} detected`);
      errors.slice(0, 3).forEach(err => console.log(`    • ${err.substring(0, 100)}`));
    } else {
      console.log(`  - Console errors: NONE`);
    }

    console.log('\n========================================');
    console.log('DIAGNOSTIC TEST COMPLETE');
    console.log('========================================\n');

    // Final full screenshot
    await page.screenshot({ path: 'diagnostic-final.png', fullPage: true });
  });
});
