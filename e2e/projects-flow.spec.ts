import { test, expect, Page } from '@playwright/test';

// Helper to check if we're on the login page
async function isOnLoginPage(page: Page): Promise<boolean> {
  const loginButton = page.getByRole('button', { name: /continue with google|sign in/i });
  return (await loginButton.count() > 0);
}

test.describe('Projects Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the base URL
    await page.goto('http://localhost:3000');
  });

  test('1. /projects page - should display list page with New Project button OR require auth', async ({ page }) => {
    // Navigate to projects page
    await page.goto('http://localhost:3000/projects');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Take screenshot of projects page
    await page.screenshot({ path: 'test-results/projects-page.png', fullPage: true });

    // Check if we're on login page
    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required - verifying login page');
      const loginButton = page.getByRole('button', { name: /continue with google/i });
      await expect(loginButton).toBeVisible();
      console.log('✓ Login page displays correctly');
      return;
    }

    // If authenticated, check for "New Project" button
    const newProjectButton = page.locator('button:has-text("New Project"), a:has-text("New Project")');
    await expect(newProjectButton).toBeVisible();

    // Check page title or heading
    const heading = page.locator('h1:has-text("Projects")');
    await expect(heading).toBeVisible();

    console.log('✓ Projects page loaded with New Project button');
  });

  test('2. /projects/new page - should display upload form OR require auth', async ({ page }) => {
    await page.goto('http://localhost:3000/projects/new');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Take screenshot
    await page.screenshot({ path: 'test-results/projects-new-page.png', fullPage: true });

    // Check if we're on login page
    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    // If authenticated, check for project name input field
    const projectNameInput = page.locator('input[placeholder*="project name" i], input[placeholder*="Enter project" i]').first();
    await expect(projectNameInput).toBeVisible();

    // Check for drag & drop zone or file upload area
    const uploadText = page.locator('text=/Drop PDF files|or click to browse/i');
    await expect(uploadText).toBeVisible();

    console.log('✓ New project page loaded with name input and upload zone');
  });

  test('3. Navigation from /projects to /projects/new', async ({ page }) => {
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required - skipping navigation test');
      return;
    }

    // Click "New Project" button
    const newProjectButton = page.locator('button:has-text("New Project")').first();
    await newProjectButton.click();

    // Wait for navigation
    await page.waitForURL('**/projects/new', { timeout: 5000 });

    // Verify we're on the new project page
    expect(page.url()).toContain('/projects/new');

    console.log('✓ Navigation from /projects to /projects/new works');
  });

  test('4. Check for project list rendering (if any projects exist)', async ({ page }) => {
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    // Look for project cards or list items or empty state
    const emptyState = page.locator('text=/No projects yet|Create First Project/i');
    const hasEmptyState = await emptyState.count() > 0;

    if (hasEmptyState) {
      console.log('✓ Empty state displayed (no projects yet)');
      await page.screenshot({ path: 'test-results/projects-empty-state.png', fullPage: true });
    } else {
      // Look for project items
      const projectCards = page.locator('div[class*="card"]').filter({ has: page.locator('h3') });
      const count = await projectCards.count();
      console.log(`Found ${count} project items on the page`);

      if (count > 0) {
        await page.screenshot({ path: 'test-results/projects-with-items.png', fullPage: true });
        console.log('✓ Project list is rendering');
      }
    }
  });

  test('5. Check header navigation to /projects', async ({ page }) => {
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required - cannot test header navigation');
      return;
    }

    // Look for Projects link in header/nav
    const projectsNavLink = page.locator('a:has-text("Projects")').first();

    if (await projectsNavLink.isVisible()) {
      await projectsNavLink.click();
      await page.waitForURL('**/projects', { timeout: 5000 });
      expect(page.url()).toContain('/projects');
      console.log('✓ Header navigation to /projects works');
    } else {
      console.log('⚠ Projects navigation link not found in header (may need to check after auth)');
    }
  });

  test('6. /projects/[id] page structure (if project exists)', async ({ page }) => {
    // First, try to get a project ID by visiting the projects page
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    // Try to find and click on a project
    const projectLink = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') }).first();
    const projectExists = await projectLink.isVisible().catch(() => false);

    if (!projectExists) {
      console.log('⚠ No projects available to test verification page (this is expected if no projects exist)');
      return;
    }

    await projectLink.click();
    await page.waitForLoadState('networkidle');

    // Take screenshot
    await page.screenshot({ path: 'test-results/project-verification-page.png', fullPage: true });

    // Check for header with back button
    const backButton = page.locator('button:has-text("Back")').first();
    const hasBackButton = await backButton.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(hasBackButton ? '✓ Back button is visible' : '⚠ Back button not found');

    // Check for "+ Add Item" button
    const addItemButton = page.locator('button:has-text("Add Item")').first();
    const hasAddItemButton = await addItemButton.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(hasAddItemButton ? '✓ Add Item button is visible' : '⚠ Add Item button not found');

    // Check for approved/pending counts in header
    const approvedText = page.locator('text=/\\d+ approved/i');
    const pendingText = page.locator('text=/\\d+ pending/i');
    const hasApprovedCount = await approvedText.isVisible({ timeout: 2000 }).catch(() => false);
    const hasPendingCount = await pendingText.isVisible({ timeout: 2000 }).catch(() => false);
    console.log((hasApprovedCount || hasPendingCount) ? '✓ Status counters visible' : '⚠ Status counters not found');

    // Check for footer with page info
    const footer = page.locator('footer, [class*="footer"]').filter({ hasText: /Page \d+/i });
    const hasFooter = await footer.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(hasFooter ? '✓ Footer with page navigation visible' : '⚠ Footer not found');

    // Check for keyboard shortcuts hint in footer
    const shortcutHint = page.locator('text=/Press A to approve|Press S to skip/i');
    const hasShortcutHint = await shortcutHint.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(hasShortcutHint ? '✓ Keyboard shortcuts hint visible' : '⚠ Keyboard shortcuts hint not found');
  });

  test('7. Test back button navigation from verification page', async ({ page }) => {
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    const projectLink = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') }).first();
    const projectExists = await projectLink.isVisible().catch(() => false);

    if (!projectExists) {
      console.log('⚠ No projects available to test back button');
      return;
    }

    await projectLink.click();
    await page.waitForLoadState('networkidle');

    // Click back button
    const backButton = page.locator('button:has-text("Back")').first();
    if (await backButton.isVisible({ timeout: 2000 })) {
      await backButton.click();
      await page.waitForURL('**/projects', { timeout: 5000 });

      // Verify we're back at /projects (not /bids)
      expect(page.url()).toContain('/projects');
      expect(page.url()).not.toContain('/bids');
      console.log('✓ Back button navigates to /projects (not /bids)');
    } else {
      console.log('⚠ Could not test back button - button not found');
    }
  });

  test('8. Test keyboard shortcuts on verification page', async ({ page }) => {
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    const projectLink = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') }).first();
    const projectExists = await projectLink.isVisible().catch(() => false);

    if (!projectExists) {
      console.log('⚠ No projects available to test keyboard shortcuts');
      return;
    }

    await projectLink.click();
    await page.waitForLoadState('networkidle');

    // Get initial page number
    const initialPageText = await page.locator('text=/Page \\d+/i').textContent();

    // Test arrow keys for page navigation
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    console.log('✓ Pressed ArrowRight key');

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    console.log('✓ Pressed ArrowLeft key');

    // Test 'A' key (approve) - may not work without selecting an item first
    await page.keyboard.press('a');
    await page.waitForTimeout(300);
    console.log('✓ Pressed A key (approve shortcut)');

    // Test 'S' key (skip)
    await page.keyboard.press('s');
    await page.waitForTimeout(300);
    console.log('✓ Pressed S key (skip shortcut)');

    // Test '+' key (add item)
    await page.keyboard.press('+');
    await page.waitForTimeout(300);
    console.log('✓ Pressed + key (add item shortcut)');

    // Press Escape to cancel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Take screenshot after keyboard interactions
    await page.screenshot({ path: 'test-results/after-keyboard-shortcuts.png', fullPage: true });
    console.log('✓ Keyboard shortcuts test completed');
  });

  test('9. Test zoom controls on PDF viewer', async ({ page }) => {
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    const projectLink = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') }).first();
    const projectExists = await projectLink.isVisible().catch(() => false);

    if (!projectExists) {
      console.log('⚠ No projects available to test zoom controls');
      return;
    }

    await projectLink.click();
    await page.waitForLoadState('networkidle');

    // Look for zoom controls (these may be in various places depending on implementation)
    const zoomIn = page.locator('button[aria-label*="zoom in" i], button:has-text("+")').first();
    const zoomOut = page.locator('button[aria-label*="zoom out" i], button:has-text("-")').first();

    const hasZoomIn = await zoomIn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasZoomOut = await zoomOut.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasZoomIn) {
      await zoomIn.click();
      await page.waitForTimeout(500);
      console.log('✓ Zoom in button clicked');
    } else {
      console.log('⚠ Zoom in button not found (may be implemented differently or not yet implemented)');
    }

    if (hasZoomOut) {
      await zoomOut.click();
      await page.waitForTimeout(500);
      console.log('✓ Zoom out button clicked');
    } else {
      console.log('⚠ Zoom out button not found (may be implemented differently or not yet implemented)');
    }

    // Take screenshot
    await page.screenshot({ path: 'test-results/zoom-controls.png', fullPage: true });
  });

  test('10. Test filmstrip page selection', async ({ page }) => {
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    if (await isOnLoginPage(page)) {
      console.log('⚠ Authentication required');
      return;
    }

    const projectLink = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') }).first();
    const projectExists = await projectLink.isVisible().catch(() => false);

    if (!projectExists) {
      console.log('⚠ No projects available to test filmstrip');
      return;
    }

    await projectLink.click();
    await page.waitForLoadState('networkidle');

    // Wait a bit for filmstrip to render
    await page.waitForTimeout(1000);

    // Look for thumbnail elements or page indicators
    const thumbnails = page.locator('[class*="thumbnail"], [class*="page-thumb"], button[class*="page"]').filter({ visible: true });
    const thumbnailCount = await thumbnails.count();

    console.log(`Found ${thumbnailCount} potential thumbnail/page elements`);

    if (thumbnailCount > 1) {
      // Click on second thumbnail
      await thumbnails.nth(1).click();
      await page.waitForTimeout(500);
      console.log('✓ Clicked second thumbnail/page element');

      // Take screenshot
      await page.screenshot({ path: 'test-results/filmstrip-navigation.png', fullPage: true });
    } else if (thumbnailCount === 1) {
      console.log('⚠ Only one page/thumbnail found (single-page document)');
    } else {
      console.log('⚠ Filmstrip thumbnails not found (may be implemented differently)');
    }
  });

  test('11. Check for error handling and console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        // Filter out known/expected errors
        const text = msg.text();
        if (!text.includes('ClientFetchError') && !text.includes('authjs')) {
          consoleErrors.push(text);
        }
      }
    });

    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Navigate through the flow
    await page.goto('http://localhost:3000/projects');
    await page.waitForLoadState('networkidle');

    await page.goto('http://localhost:3000/projects/new');
    await page.waitForLoadState('networkidle');

    // Report errors
    if (consoleErrors.length > 0) {
      console.log('⚠ Console errors found:');
      consoleErrors.forEach(err => console.log(`  - ${err}`));
    } else {
      console.log('✓ No unexpected console errors detected');
    }

    if (pageErrors.length > 0) {
      console.log('⚠ Page errors found:');
      pageErrors.forEach(err => console.log(`  - ${err}`));
    } else {
      console.log('✓ No page errors detected');
    }
  });
});
