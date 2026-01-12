/**
 * Test script to verify tracking URL resolution
 *
 * Usage: npx tsx scripts/test-tracking-urls.ts [url]
 *
 * This follows redirects from tracking URLs (like itb.planhub.com/ls/click?...)
 * to get the final destination URL.
 */

const testUrls: string[] = [
  // Add any tracking URLs from emails here for testing
  // 'https://itb.planhub.com/ls/click?...',
];

async function resolveTrackingUrl(url: string): Promise<{ finalUrl: string; redirectChain: string[] }> {
  const redirectChain: string[] = [url];
  let currentUrl = url;
  const maxRedirects = 10;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      // Check for redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          // Handle relative redirects
          if (location.startsWith('/')) {
            const urlObj = new URL(currentUrl);
            currentUrl = `${urlObj.protocol}//${urlObj.host}${location}`;
          } else if (!location.startsWith('http')) {
            // Relative to current path
            const urlObj = new URL(currentUrl);
            currentUrl = new URL(location, urlObj).href;
          } else {
            currentUrl = location;
          }
          redirectChain.push(currentUrl);
          console.log(`  → ${response.status} redirect to: ${currentUrl}`);
          continue;
        }
      }

      // No more redirects
      console.log(`  Final status: ${response.status}`);
      break;
    } catch (error) {
      console.error(`  Error at ${currentUrl}:`, error);
      break;
    }
  }

  return { finalUrl: currentUrl, redirectChain };
}

function extractProjectInfo(url: string): { platform: string; projectId?: string } {
  // PlanHub
  if (url.includes('planhub.com')) {
    // app.planhub.com/projects/abc123
    // subcontractor.planhub.com/leads/view/abc123
    const match = url.match(/\/(projects?|leads\/view)\/([a-zA-Z0-9-]+)/);
    return { platform: 'planhub', projectId: match?.[2] };
  }

  // BuildingConnected
  if (url.includes('buildingconnected.com')) {
    const match = url.match(/\/(bid-board|projects?)\/([a-zA-Z0-9-]+)/);
    return { platform: 'buildingconnected', projectId: match?.[2] };
  }

  return { platform: 'unknown' };
}

async function main() {
  const urlArg = process.argv[2];
  const urlsToTest = urlArg ? [urlArg] : testUrls;

  if (urlsToTest.length === 0) {
    console.log('Usage: npx tsx scripts/test-tracking-urls.ts <tracking-url>');
    console.log('\nNo URLs to test. Provide a URL as argument or add URLs to testUrls array.');
    console.log('\nExample tracking URLs:');
    console.log('  - https://itb.planhub.com/ls/click?upn=...');
    console.log('  - https://email.buildingconnected.com/...');
    return;
  }

  console.log(`Testing ${urlsToTest.length} tracking URL(s)...\n`);

  for (const url of urlsToTest) {
    console.log(`\nResolving: ${url.substring(0, 80)}...`);

    const { finalUrl, redirectChain } = await resolveTrackingUrl(url);
    const projectInfo = extractProjectInfo(finalUrl);

    console.log('\nResult:');
    console.log(`  Original:  ${url.substring(0, 80)}...`);
    console.log(`  Final:     ${finalUrl}`);
    console.log(`  Platform:  ${projectInfo.platform}`);
    console.log(`  Project ID: ${projectInfo.projectId || 'N/A'}`);
    console.log(`  Redirects: ${redirectChain.length - 1}`);

    // Check if final URL is actionable
    if (finalUrl.includes('login') || finalUrl.includes('signin')) {
      console.log('\n  ⚠️  Final URL is a login page - authentication required');
    } else if (projectInfo.projectId) {
      console.log('\n  ✓ Successfully resolved to project page');
    } else if (projectInfo.platform !== 'unknown') {
      console.log('\n  ✓ Resolved to platform domain');
    } else {
      console.log('\n  ⚠️  Could not determine project info from final URL');
    }
  }
}

main().catch(console.error);
