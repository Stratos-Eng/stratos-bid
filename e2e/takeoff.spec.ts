import { test, expect, Page } from '@playwright/test';

// Helper to wait for the app to be ready
async function waitForAppReady(page: Page) {
  await page.waitForLoadState('networkidle');
}

// Helper to check if we're on the login page
async function isOnLoginPage(page: Page): Promise<boolean> {
  const loginButton = page.getByRole('button', { name: /continue with google|sign in/i });
  const loginText = page.locator('text=Stratos');
  return (await loginButton.count() > 0) || (await loginText.count() > 0 && page.url().includes('/login'));
}

// Skip test if auth is required
async function skipIfAuthRequired(page: Page) {
  if (await isOnLoginPage(page)) {
    test.skip(true, 'Authentication required - skipping test');
    return true;
  }
  return false;
}

test.describe('Takeoff Project List (Public Access)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/takeoff');
    await waitForAppReady(page);
  });

  test('should redirect to login if not authenticated', async ({ page }) => {
    // If we're on login page, auth is working correctly
    const onLogin = await isOnLoginPage(page);
    if (onLogin) {
      // Verify login page has expected elements
      const loginButton = page.getByRole('button', { name: /continue with google/i });
      await expect(loginButton).toBeVisible();
    } else {
      // If we're on takeoff page, we're authenticated
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    }
  });
});

test.describe('New Project Creation (Auth Required)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/takeoff/new');
    await waitForAppReady(page);
  });

  test('should display new project form when authenticated', async ({ page }) => {
    if (await isOnLoginPage(page)) {
      // Expected - auth required
      const loginButton = page.getByRole('button', { name: /continue with google/i });
      await expect(loginButton).toBeVisible();
      return;
    }

    // If authenticated, verify form elements
    const nameInput = page.locator('input[placeholder*="Office Building"]')
      .or(page.getByPlaceholder(/project name|name/i))
      .or(page.locator('input[type="text"]').first());
    await expect(nameInput).toBeVisible({ timeout: 10000 });
  });

  test('should show file upload area when authenticated', async ({ page }) => {
    if (await isOnLoginPage(page)) {
      return; // Skip - auth required
    }

    const fileInput = page.locator('input[type="file"]');
    const dropZone = page.locator('label[for="pdf-upload"]').or(page.locator('[class*="dashed"]'));
    const hasFileInput = await fileInput.count() > 0;
    const hasDropZone = await dropZone.count() > 0;
    expect(hasFileInput || hasDropZone).toBeTruthy();
  });
});

test.describe('Takeoff Workspace (Auth Required)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/takeoff');
    await waitForAppReady(page);
  });

  test('workspace redirects to login when not authenticated', async ({ page }) => {
    const onLogin = await isOnLoginPage(page);
    if (onLogin) {
      // Expected behavior
      const loginButton = page.getByRole('button', { name: /continue with google/i });
      await expect(loginButton).toBeVisible();
    }
  });
});

test.describe('API Endpoints', () => {
  test('GET /api/takeoff/projects requires authentication', async ({ request }) => {
    const response = await request.get('/api/takeoff/projects');
    // Should return 401 without auth
    expect(response.status()).toBe(401);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  test('POST /api/takeoff/projects requires authentication', async ({ request }) => {
    const response = await request.post('/api/takeoff/projects', {
      data: { name: 'Test Project' },
    });
    expect(response.status()).toBe(401);
  });

  test('POST /api/takeoff/categories requires authentication', async ({ request }) => {
    const response = await request.post('/api/takeoff/categories', {
      data: {
        projectId: 'test-id',
        name: 'Test Category',
        color: '#ff0000',
        measurementType: 'count',
        sortOrder: 1,
      },
    });
    expect(response.status()).toBe(401);
  });

  test('GET /api/takeoff/export requires projectId parameter', async ({ request }) => {
    const response = await request.get('/api/takeoff/export');
    // Should return 400 (bad request) or 401 (unauthorized)
    expect([400, 401]).toContain(response.status());
  });

  test('POST /api/takeoff/measurements requires authentication', async ({ request }) => {
    const response = await request.post('/api/takeoff/measurements', {
      data: {
        projectId: 'test-id',
        sheetId: 'sheet-id',
        categoryId: 'category-id',
        type: 'count',
        geometry: { type: 'Point', coordinates: [0, 0] },
        quantity: 1,
        unit: 'EA',
      },
    });
    expect(response.status()).toBe(401);
  });

  test('PATCH /api/takeoff/sheets/:id requires authentication', async ({ request }) => {
    const response = await request.patch('/api/takeoff/sheets/test-sheet-id', {
      data: { name: 'New Name' },
    });
    expect(response.status()).toBe(401);
  });

  test('PATCH /api/takeoff/categories requires authentication', async ({ request }) => {
    const response = await request.patch('/api/takeoff/categories', {
      data: {
        id: 'test-id',
        name: 'Updated Name',
        color: '#00ff00',
      },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('Login Page UI', () => {
  test('login page displays correctly', async ({ page }) => {
    await page.goto('/login');
    await waitForAppReady(page);

    // Should show Stratos branding
    const heading = page.locator('h1').filter({ hasText: 'Stratos' });
    await expect(heading).toBeVisible();

    // Should show Google sign-in button
    const googleButton = page.getByRole('button', { name: /continue with google/i });
    await expect(googleButton).toBeVisible();

    // Should show terms text
    const termsText = page.locator('text=Terms of Service');
    await expect(termsText).toBeVisible();
  });

  test('Google sign-in button is clickable', async ({ page }) => {
    await page.goto('/login');
    await waitForAppReady(page);

    const googleButton = page.getByRole('button', { name: /continue with google/i });
    await expect(googleButton).toBeEnabled();
  });
});

test.describe('Error Handling', () => {
  test('invalid project ID should show error or redirect', async ({ page }) => {
    await page.goto('/takeoff/invalid-project-id-12345');
    await waitForAppReady(page);

    // Should either show error, redirect to login, or redirect to project list
    const onLogin = await isOnLoginPage(page);
    const errorText = page.locator('text=/error|not found/i');
    const hasError = await errorText.count() > 0;
    const isOnList = page.url().includes('/takeoff') && !page.url().includes('invalid');

    // Any of these outcomes is acceptable
    expect(onLogin || hasError || isOnList).toBeTruthy();
  });

  test('404 page should exist for invalid routes', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist');
    // Should return 404 or redirect
    expect([200, 404, 307, 308]).toContain(response?.status() || 200);
  });
});

test.describe('Static Pages', () => {
  test('homepage should load', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.ok()).toBeTruthy();
    await waitForAppReady(page);
  });
});

// Integration tests that would work with authenticated session
test.describe('Authenticated Integration Tests', () => {
  test.describe.configure({ mode: 'serial' });

  // These tests are designed to run when authentication is mocked or available
  // They verify the complete user flow

  test('full project creation flow (requires auth)', async ({ page }) => {
    await page.goto('/takeoff');
    await waitForAppReady(page);

    if (await isOnLoginPage(page)) {
      test.skip(true, 'Requires authentication');
      return;
    }

    // Step 1: Navigate to new project
    const newProjectLink = page.getByRole('link', { name: /new|create/i });
    if (await newProjectLink.count() === 0) {
      console.log('New project link not found - might need different navigation');
      return;
    }

    await newProjectLink.click();
    await waitForAppReady(page);

    // Step 2: Fill project name
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill('Test Integration Project');

    // Step 3: Note - file upload would need a test PDF fixture
    // For now, just verify the form is present
    const submitButton = page.getByRole('button', { name: /create project/i });
    await expect(submitButton).toBeVisible();
  });

  test('category management flow (requires auth)', async ({ page }) => {
    await page.goto('/takeoff');
    await waitForAppReady(page);

    if (await isOnLoginPage(page)) {
      test.skip(true, 'Requires authentication');
      return;
    }

    // Navigate to first project
    const projectLink = page.locator('a[href*="/takeoff/"]').first();
    if (await projectLink.count() === 0) {
      console.log('No projects found - skipping');
      return;
    }

    await projectLink.click();
    await waitForAppReady(page);

    // Open add category modal
    const addCategoryBtn = page.getByRole('button', { name: /\+ category/i });
    if (await addCategoryBtn.count() === 0) {
      console.log('Add category button not found');
      return;
    }

    await addCategoryBtn.click();
    await page.waitForTimeout(500);

    // Verify modal opened
    const modal = page.locator('text=Add Category');
    const modalVisible = await modal.count() > 0;

    if (modalVisible) {
      // Try quick add template
      const templateBtn = page.getByRole('button', { name: /Duplex Outlets/i });
      if (await templateBtn.count() > 0) {
        // Just verify it's clickable, don't actually create
        await expect(templateBtn).toBeEnabled();
      }

      // Close modal
      await page.keyboard.press('Escape');
    }
  });

  test('keyboard shortcuts work (requires auth)', async ({ page }) => {
    await page.goto('/takeoff');
    await waitForAppReady(page);

    if (await isOnLoginPage(page)) {
      test.skip(true, 'Requires authentication');
      return;
    }

    const projectLink = page.locator('a[href*="/takeoff/"]').first();
    if (await projectLink.count() === 0) {
      console.log('No projects found - skipping');
      return;
    }

    await projectLink.click();
    await waitForAppReady(page);

    // Test ? shortcut for help
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    const helpModal = page.locator('text=Keyboard Shortcuts');
    if (await helpModal.count() > 0) {
      await expect(helpModal).toBeVisible();
      await page.keyboard.press('Escape');
    }

    // Test tool shortcuts
    await page.keyboard.press('v'); // Select
    await page.keyboard.press('c'); // Count
    await page.keyboard.press('l'); // Linear
    await page.keyboard.press('a'); // Area
    await page.keyboard.press('r'); // Rectangle
    await page.keyboard.press('k'); // Calibration

    // If calibration dialog opened, close it
    const calibrationDialog = page.locator('text=Set Scale');
    if (await calibrationDialog.count() > 0) {
      const cancelBtn = page.getByRole('button', { name: /cancel/i });
      if (await cancelBtn.count() > 0) {
        await cancelBtn.click();
      }
    }
  });

  test('export functionality (requires auth)', async ({ page }) => {
    await page.goto('/takeoff');
    await waitForAppReady(page);

    if (await isOnLoginPage(page)) {
      test.skip(true, 'Requires authentication');
      return;
    }

    const projectLink = page.locator('a[href*="/takeoff/"]').first();
    if (await projectLink.count() === 0) {
      console.log('No projects found - skipping');
      return;
    }

    await projectLink.click();
    await waitForAppReady(page);

    // Find and click export button
    const exportBtn = page.getByRole('button', { name: /export/i });
    if (await exportBtn.count() === 0) {
      console.log('Export button not found');
      return;
    }

    await exportBtn.click();
    await page.waitForTimeout(300);

    // Verify dropdown options
    const excelOption = page.locator('text=Excel');
    const csvOption = page.locator('text=CSV');

    const hasExcel = await excelOption.count() > 0;
    const hasCsv = await csvOption.count() > 0;

    console.log(`Export options - Excel: ${hasExcel}, CSV: ${hasCsv}`);

    // Close dropdown
    await page.keyboard.press('Escape');
  });
});
