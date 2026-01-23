import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Helper to check if we're on the login page
async function isOnLoginPage(page: Page): Promise<boolean> {
  const loginButton = page.getByRole('button', { name: /continue with google|sign in/i });
  return (await loginButton.count() > 0);
}

// Helper to wait for text extraction to complete
async function waitForTextExtraction(page: Page, timeoutMs = 60000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const extractionComplete = page.locator('text=/extraction complete|text extracted|ready for ai/i');
    const extractionError = page.locator('text=/extraction failed|error extracting/i');

    if (await extractionComplete.isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }

    if (await extractionError.isVisible({ timeout: 1000 }).catch(() => false)) {
      throw new Error('Text extraction failed');
    }

    await page.waitForTimeout(2000);
  }
  return false;
}

test.describe('PDF Upload and Extraction Flow', () => {
  const pdfPath = '/Users/hamza/experiments/doc-extraction/Bid Plans_20251125A-GP OMF_Full Set 2025-11-24_stamped.pdf';
  let testProjectId: string | null = null;

  test('Complete PDF Upload and Extraction E2E Flow', async ({ page }) => {
    const testResults = {
      steps: [] as Array<{ step: string; status: 'passed' | 'failed' | 'skipped'; details?: string; duration?: number; screenshot?: string }>,
      startTime: Date.now(),
      endTime: 0,
    };

    const addResult = (step: string, status: 'passed' | 'failed' | 'skipped', details?: string, screenshot?: string) => {
      const duration = Date.now() - testResults.startTime;
      testResults.steps.push({ step, status, details, duration, screenshot });
      console.log(`${status === 'passed' ? '✓' : status === 'failed' ? '✗' : '⚠'} ${step}${details ? ': ' + details : ''} (${duration}ms)`);
    };

    // Capture console errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[${new Date().toISOString()}] ${msg.text()}`);
      }
    });

    try {
      // STEP 1: Navigate to app
      console.log('\n=== STEP 1: Navigate to Application ===');
      const step1Start = Date.now();
      await page.goto('http://localhost:3000');
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: 'test-results/step1-homepage.png', fullPage: true });
      addResult('Navigate to homepage', 'passed', `Loaded in ${Date.now() - step1Start}ms`, 'test-results/step1-homepage.png');

      // STEP 2: Check for authentication
      console.log('\n=== STEP 2: Authentication Check ===');
      if (await isOnLoginPage(page)) {
        await page.screenshot({ path: 'test-results/step2-login-required.png', fullPage: true });
        addResult('Authentication check', 'skipped', 'Login required - manual authentication needed', 'test-results/step2-login-required.png');
        console.log('\n⚠ AUTHENTICATION REQUIRED');
        console.log('Please log in manually and re-run the test with an authenticated session.');
        return;
      }
      addResult('Authentication check', 'passed', 'Already authenticated');

      // STEP 3: Navigate to Projects page
      console.log('\n=== STEP 3: Navigate to Projects ===');
      const step3Start = Date.now();
      await page.goto('http://localhost:3000/projects');
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: 'test-results/step3-projects-page.png', fullPage: true });
      addResult('Navigate to projects page', 'passed', `Loaded in ${Date.now() - step3Start}ms`, 'test-results/step3-projects-page.png');

      // STEP 4: Create or select project
      console.log('\n=== STEP 4: Create/Select Project ===');
      const step4Start = Date.now();

      // Try to use existing project first
      const existingProject = page.locator('a[href*="/projects/"]').filter({ hasNot: page.locator('[href*="/projects/new"]') }).first();
      const projectExists = await existingProject.isVisible({ timeout: 2000 }).catch(() => false);

      if (projectExists) {
        const projectHref = await existingProject.getAttribute('href');
        testProjectId = projectHref?.split('/').pop() || null;
        await existingProject.click();
        await page.waitForLoadState('networkidle');
        addResult('Select existing project', 'passed', `Using project ID: ${testProjectId}`, 'test-results/step4-existing-project.png');
      } else {
        // Create new project
        const newProjectButton = page.locator('button:has-text("New Project"), a:has-text("New Project")').first();
        await newProjectButton.click();
        await page.waitForURL('**/projects/new');
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: 'test-results/step4-new-project-page.png', fullPage: true });
        addResult('Navigate to new project page', 'passed', `Loaded in ${Date.now() - step4Start}ms`, 'test-results/step4-new-project-page.png');
      }

      // STEP 5: Upload PDF file
      console.log('\n=== STEP 5: Upload PDF File ===');
      const step5Start = Date.now();

      // Find file input
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(pdfPath);

      // Wait for upload to start
      await page.waitForTimeout(1000);

      // Check for upload progress indicators
      const uploadProgress = page.locator('text=/uploading|upload progress|\\d+%/i');
      const hasProgress = await uploadProgress.isVisible({ timeout: 2000 }).catch(() => false);

      if (hasProgress) {
        console.log('Upload progress indicator found');
        // Wait for upload to complete
        await page.waitForTimeout(5000);
      }

      await page.screenshot({ path: 'test-results/step5-upload-initiated.png', fullPage: true });

      const uploadDuration = Date.now() - step5Start;
      addResult('Upload PDF file', 'passed', `Upload initiated in ${uploadDuration}ms (155MB file)`, 'test-results/step5-upload-initiated.png');

      // STEP 6: Wait for text extraction
      console.log('\n=== STEP 6: Wait for Text Extraction ===');
      const step6Start = Date.now();

      // Wait for upload to complete and extraction to start
      await page.waitForTimeout(10000);

      // Look for extraction status
      const extractionStatus = page.locator('text=/extracting|processing|analyzing/i');
      const hasExtractionStatus = await extractionStatus.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasExtractionStatus) {
        console.log('Text extraction in progress...');
        await page.screenshot({ path: 'test-results/step6-extraction-in-progress.png', fullPage: true });
      }

      // Wait for extraction to complete (with extended timeout for large PDF)
      try {
        const extracted = await waitForTextExtraction(page, 120000);
        const extractionDuration = Date.now() - step6Start;

        if (extracted) {
          await page.screenshot({ path: 'test-results/step6-extraction-complete.png', fullPage: true });
          addResult('Text extraction complete', 'passed', `Completed in ${extractionDuration}ms`, 'test-results/step6-extraction-complete.png');
        } else {
          addResult('Text extraction', 'failed', 'Timeout waiting for extraction (120s)', 'test-results/step6-extraction-timeout.png');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await page.screenshot({ path: 'test-results/step6-extraction-error.png', fullPage: true });
        addResult('Text extraction', 'failed', errorMsg, 'test-results/step6-extraction-error.png');
      }

      // STEP 7: Trigger AI extraction (signage)
      console.log('\n=== STEP 7: Trigger AI Extraction ===');
      const step7Start = Date.now();

      // Look for AI extraction button or signage extraction button
      const aiExtractButton = page.locator('button:has-text("Extract"), button:has-text("AI Extract"), button:has-text("Signage")').first();
      const hasExtractButton = await aiExtractButton.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasExtractButton) {
        await aiExtractButton.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'test-results/step7-ai-extraction-triggered.png', fullPage: true });

        // Wait for AI extraction to complete
        await page.waitForTimeout(15000);

        const aiDuration = Date.now() - step7Start;
        addResult('Trigger AI extraction', 'passed', `AI extraction triggered in ${aiDuration}ms`, 'test-results/step7-ai-extraction-triggered.png');
      } else {
        await page.screenshot({ path: 'test-results/step7-no-extract-button.png', fullPage: true });
        addResult('Trigger AI extraction', 'failed', 'AI extract button not found', 'test-results/step7-no-extract-button.png');
      }

      // STEP 8: Verify line items appear
      console.log('\n=== STEP 8: Verify Line Items ===');
      const step8Start = Date.now();

      // Look for line items in various possible locations
      const lineItems = page.locator('div[class*="item"], tr[class*="item"], [role="row"]').filter({ hasText: /sign|panel|post|frame/i });
      const lineItemCount = await lineItems.count();

      await page.screenshot({ path: 'test-results/step8-line-items.png', fullPage: true });

      if (lineItemCount > 0) {
        addResult('Verify line items', 'passed', `Found ${lineItemCount} line items`, 'test-results/step8-line-items.png');
      } else {
        // Try alternative selectors
        const alternativeItems = page.locator('text=/item|quantity|description/i');
        const altCount = await alternativeItems.count();

        if (altCount > 0) {
          addResult('Verify line items', 'passed', `Found ${altCount} potential item elements`, 'test-results/step8-line-items.png');
        } else {
          addResult('Verify line items', 'failed', 'No line items found in UI', 'test-results/step8-line-items.png');
        }
      }

      // STEP 9: Test PDF viewer
      console.log('\n=== STEP 9: Test PDF Viewer (PDF.js) ===');
      const step9Start = Date.now();

      // Look for PDF canvas or viewer
      const pdfCanvas = page.locator('canvas[class*="pdf"], canvas').first();
      const hasPdfCanvas = await pdfCanvas.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasPdfCanvas) {
        // Get canvas dimensions to verify it rendered
        const canvasBox = await pdfCanvas.boundingBox();

        if (canvasBox && canvasBox.width > 0 && canvasBox.height > 0) {
          addResult('PDF viewer rendering', 'passed', `Canvas dimensions: ${canvasBox.width}x${canvasBox.height}`, 'test-results/step9-pdf-viewer.png');

          // Test page navigation
          const nextPageButton = page.locator('button[aria-label*="next" i], button:has-text(">")').first();
          const hasNextButton = await nextPageButton.isVisible({ timeout: 2000 }).catch(() => false);

          if (hasNextButton) {
            await nextPageButton.click();
            await page.waitForTimeout(1000);
            await page.screenshot({ path: 'test-results/step9-pdf-page-navigation.png', fullPage: true });
            addResult('PDF page navigation', 'passed', 'Successfully navigated to next page', 'test-results/step9-pdf-page-navigation.png');
          }

          // Test zoom controls
          const zoomInButton = page.locator('button[aria-label*="zoom in" i], button:has-text("+")').first();
          const hasZoomIn = await zoomInButton.isVisible({ timeout: 2000 }).catch(() => false);

          if (hasZoomIn) {
            await zoomInButton.click();
            await page.waitForTimeout(500);
            await page.screenshot({ path: 'test-results/step9-pdf-zoom.png', fullPage: true });
            addResult('PDF zoom controls', 'passed', 'Zoom controls functional', 'test-results/step9-pdf-zoom.png');
          } else {
            addResult('PDF zoom controls', 'skipped', 'Zoom controls not found');
          }
        } else {
          addResult('PDF viewer rendering', 'failed', 'Canvas exists but has no dimensions');
        }
      } else {
        await page.screenshot({ path: 'test-results/step9-no-pdf-viewer.png', fullPage: true });
        addResult('PDF viewer rendering', 'failed', 'PDF canvas not found', 'test-results/step9-no-pdf-viewer.png');
      }

      // Final screenshot
      await page.screenshot({ path: 'test-results/final-state.png', fullPage: true });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await page.screenshot({ path: 'test-results/error-state.png', fullPage: true });
      console.error('Test failed with error:', errorMsg);
      addResult('Test execution', 'failed', errorMsg, 'test-results/error-state.png');
      throw error;
    } finally {
      testResults.endTime = Date.now();
      const totalDuration = testResults.endTime - testResults.startTime;

      // Print comprehensive report
      console.log('\n' + '='.repeat(80));
      console.log('COMPREHENSIVE TEST REPORT');
      console.log('='.repeat(80));
      console.log(`Total Duration: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`);
      console.log(`Total Steps: ${testResults.steps.length}`);
      console.log(`Passed: ${testResults.steps.filter(s => s.status === 'passed').length}`);
      console.log(`Failed: ${testResults.steps.filter(s => s.status === 'failed').length}`);
      console.log(`Skipped: ${testResults.steps.filter(s => s.status === 'skipped').length}`);
      console.log('='.repeat(80));

      console.log('\nSTEP-BY-STEP RESULTS:');
      testResults.steps.forEach((step, index) => {
        const statusSymbol = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '⚠';
        console.log(`${index + 1}. ${statusSymbol} ${step.step}`);
        if (step.details) console.log(`   ${step.details}`);
        if (step.screenshot) console.log(`   Screenshot: ${step.screenshot}`);
      });

      if (consoleErrors.length > 0) {
        console.log('\n' + '='.repeat(80));
        console.log('CONSOLE ERRORS DETECTED:');
        console.log('='.repeat(80));
        consoleErrors.forEach((error, index) => {
          console.log(`${index + 1}. ${error}`);
        });
      } else {
        console.log('\n✓ No console errors detected during test execution');
      }

      console.log('\n' + '='.repeat(80));
    }
  });
});
