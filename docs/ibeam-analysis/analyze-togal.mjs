import puppeteer from 'puppeteer';

const URL = 'https://www-prod.togal.ai/';

async function analyzeTogal() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const findings = {
    techStack: {},
    apiEndpoints: [],
    jsFiles: [],
    cssPatterns: [],
    domStructure: {}
  };

  // Capture all network traffic
  page.on('request', (request) => {
    const url = request.url();
    if (url.endsWith('.js') || url.includes('.js?')) {
      findings.jsFiles.push(url);
    }
  });

  page.on('response', async (response) => {
    const url = response.url();

    // Capture API calls
    if (url.includes('/api/') || url.includes('graphql')) {
      findings.apiEndpoints.push({
        url: url,
        status: response.status(),
        type: response.headers()['content-type']
      });
    }
  });

  console.log('Loading Togal.ai...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));

  // Take screenshot
  await page.screenshot({ path: '/Users/hamza/stratos/togal-screenshot.png', fullPage: false });
  console.log('Screenshot saved');

  // ============================================================================
  // TECH STACK ANALYSIS
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('TOGAL.AI TECH STACK ANALYSIS');
  console.log('='.repeat(80));

  const techStack = await page.evaluate(() => {
    const results = {};

    // Check for React
    results.hasReact = !!document.querySelector('[data-reactroot]') ||
                       !!window.React ||
                       !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__;

    // Check for Vue
    results.hasVue = !!window.Vue || !!document.querySelector('[data-v-]');

    // Check for Angular
    results.hasAngular = !!window.ng || !!document.querySelector('[ng-version]');

    // Check for Next.js
    results.hasNextJS = !!window.__NEXT_DATA__ || !!document.querySelector('#__next');

    // Check for specific libraries
    results.hasOpenLayers = !!window.ol;
    results.hasLeaflet = !!window.L;
    results.hasMapbox = !!window.mapboxgl;
    results.hasPDFJS = !!window.pdfjsLib || !!window.PDFJS;
    results.hasThreeJS = !!window.THREE;
    results.hasD3 = !!window.d3;
    results.hasFirebase = !!window.firebase;
    results.hasAWS = !!window.AWS;

    // Check meta tags
    const metaTags = {};
    document.querySelectorAll('meta').forEach(meta => {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      if (name) metaTags[name] = meta.getAttribute('content');
    });
    results.metaTags = metaTags;

    // Get page title
    results.title = document.title;

    // Check for common UI frameworks
    const hasAntd = !!document.querySelector('[class*="ant-"]');
    const hasMUI = !!document.querySelector('[class*="Mui"]') || !!document.querySelector('[class*="css-"]');
    const hasBootstrap = !!document.querySelector('[class*="btn-"]') || !!document.querySelector('.container');
    const hasTailwind = !!document.querySelector('[class*="flex"]') && !!document.querySelector('[class*="px-"]');

    results.uiFramework = {
      antd: hasAntd,
      mui: hasMUI,
      bootstrap: hasBootstrap,
      tailwind: hasTailwind
    };

    // Get all unique class prefixes (for CSS analysis)
    const classPrefixes = new Set();
    document.querySelectorAll('*').forEach(el => {
      el.classList.forEach(cls => {
        const prefix = cls.split('-')[0].split('_')[0];
        if (prefix.length > 2 && prefix.length < 20) {
          classPrefixes.add(prefix);
        }
      });
    });
    results.classPrefixes = [...classPrefixes].slice(0, 50);

    return results;
  });

  console.log('\nTech Stack:', JSON.stringify(techStack, null, 2));

  // ============================================================================
  // DOM STRUCTURE
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('DOM STRUCTURE');
  console.log('='.repeat(80));

  const domStructure = await page.evaluate(() => {
    const results = {};

    // Get main containers
    const mainContainers = document.querySelectorAll('main, #root, #app, #__next, .app, .main');
    results.mainContainers = Array.from(mainContainers).map(el => ({
      tagName: el.tagName,
      id: el.id,
      className: el.className
    }));

    // Count elements by type
    results.elementCounts = {
      divs: document.querySelectorAll('div').length,
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input').length,
      canvas: document.querySelectorAll('canvas').length,
      svg: document.querySelectorAll('svg').length,
      iframes: document.querySelectorAll('iframe').length
    };

    // Look for PDF/map viewers
    results.viewerElements = {
      canvas: Array.from(document.querySelectorAll('canvas')).map(c => ({
        id: c.id,
        className: c.className,
        width: c.width,
        height: c.height
      })),
      mapContainers: Array.from(document.querySelectorAll('[class*="map"], [class*="Map"], [id*="map"]')).map(el => ({
        tagName: el.tagName,
        className: el.className
      }))
    };

    // Get page structure
    const body = document.body;
    results.bodyClasses = body.className;
    results.childCount = body.children.length;

    return results;
  });

  console.log('\nDOM Structure:', JSON.stringify(domStructure, null, 2));

  // ============================================================================
  // JS BUNDLE ANALYSIS
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('JS FILES LOADED');
  console.log('='.repeat(80));

  const uniqueJS = [...new Set(findings.jsFiles)];
  console.log('\nTotal JS files:', uniqueJS.length);
  uniqueJS.forEach(url => {
    const name = url.split('/').pop().split('?')[0];
    console.log(`  ${name}`);
  });

  // ============================================================================
  // WINDOW OBJECTS
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('WINDOW OBJECTS (Libraries)');
  console.log('='.repeat(80));

  const windowAnalysis = await page.evaluate(() => {
    const interestingKeys = Object.keys(window).filter(key => {
      // Filter out default browser globals
      const defaults = ['self', 'document', 'location', 'navigator', 'history', 'screen',
                       'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'parent', 'top',
                       'frames', 'length', 'opener', 'closed', 'name', 'status', 'frameElement',
                       'customElements', 'visualViewport', 'speechSynthesis', 'isSecureContext',
                       'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage',
                       'caches', 'cookieStore', 'origin', 'crossOriginIsolated'];

      if (defaults.includes(key)) return false;
      if (key.startsWith('on')) return false;
      if (key.startsWith('webkit')) return false;
      if (key.startsWith('$')) return true;  // jQuery, etc.
      if (key.length < 2) return false;

      return true;
    });

    return interestingKeys.slice(0, 100);
  });

  console.log('\nWindow objects:', windowAnalysis.join(', '));

  // ============================================================================
  // CHECK FOR APP/LOGIN
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('PAGE CONTENT ANALYSIS');
  console.log('='.repeat(80));

  const pageContent = await page.evaluate(() => {
    const results = {};

    // Get visible text
    const bodyText = document.body.innerText;
    results.hasLoginForm = bodyText.toLowerCase().includes('login') ||
                          bodyText.toLowerCase().includes('sign in') ||
                          !!document.querySelector('input[type="password"]');

    results.hasSignupForm = bodyText.toLowerCase().includes('sign up') ||
                           bodyText.toLowerCase().includes('register');

    // Look for navigation
    const navLinks = document.querySelectorAll('nav a, header a, [class*="nav"] a');
    results.navLinks = Array.from(navLinks).map(a => ({
      text: a.textContent?.trim(),
      href: a.href
    })).filter(l => l.text && l.text.length < 50);

    // Look for CTAs
    const buttons = document.querySelectorAll('button, [role="button"], a.btn, a[class*="button"]');
    results.buttons = Array.from(buttons).map(b => b.textContent?.trim())
      .filter(t => t && t.length < 50)
      .slice(0, 20);

    // Page type detection
    results.isLandingPage = bodyText.includes('request demo') ||
                           bodyText.includes('Request Demo') ||
                           bodyText.includes('Get Started') ||
                           bodyText.includes('Free Trial');

    results.isAppPage = !!document.querySelector('[class*="toolbar"]') ||
                       !!document.querySelector('[class*="sidebar"]') ||
                       bodyText.includes('Dashboard');

    return results;
  });

  console.log('\nPage Content:', JSON.stringify(pageContent, null, 2));

  // Get current URL (in case of redirect)
  const currentUrl = page.url();
  console.log('\nCurrent URL:', currentUrl);

  // ============================================================================
  // API ENDPOINTS
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('API ENDPOINTS');
  console.log('='.repeat(80));

  console.log('\nAPI calls captured:', findings.apiEndpoints.length);
  findings.apiEndpoints.forEach(ep => {
    console.log(`  ${ep.url}`);
  });

  // Save full findings
  const fs = await import('fs');
  fs.writeFileSync('/Users/hamza/stratos/togal-analysis.json', JSON.stringify({
    techStack,
    domStructure,
    windowAnalysis,
    pageContent,
    jsFiles: uniqueJS,
    apiEndpoints: findings.apiEndpoints,
    currentUrl
  }, null, 2));

  console.log('\n\nFull analysis saved to: togal-analysis.json');

  await browser.close();
}

analyzeTogal().catch(console.error);
