import puppeteer from 'puppeteer';

const URL = 'https://app.ibeam.ai/blueprint/shared-view?fid=all_pdf&id=ce4cc515-a229-448b-b518-23ce95ef46bd&selected_sheet=f924bcf8-5003-43df-9903-add33ca1516a&tab=all_features&wspc=false';

async function inspectIbeam() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Set a realistic viewport
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('Navigating to ibeam.ai...');

  try {
    await page.goto(URL, {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    console.log('\n=== PAGE TITLE ===');
    console.log(await page.title());

    console.log('\n=== PAGE URL ===');
    console.log(page.url());

    // Get the HTML structure
    console.log('\n=== HTML STRUCTURE ===');
    const htmlStructure = await page.evaluate(() => {
      const root = document.getElementById('root') || document.getElementById('__next') || document.body;

      function getStructure(el, depth = 0) {
        if (depth > 4) return '';
        const indent = '  '.repeat(depth);
        const tag = el.tagName?.toLowerCase() || 'text';
        const id = el.id ? `#${el.id}` : '';
        const classes = el.className && typeof el.className === 'string'
          ? `.${el.className.split(' ').filter(c => c).slice(0, 3).join('.')}`
          : '';
        const dataAttrs = Array.from(el.attributes || [])
          .filter(a => a.name.startsWith('data-'))
          .map(a => `[${a.name}]`)
          .join('');

        let result = `${indent}<${tag}${id}${classes}${dataAttrs}>\n`;

        Array.from(el.children || []).slice(0, 10).forEach(child => {
          result += getStructure(child, depth + 1);
        });

        return result;
      }

      return getStructure(root);
    });
    console.log(htmlStructure);

    // Get all script sources to identify the framework
    console.log('\n=== SCRIPT SOURCES ===');
    const scripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.src)
        .filter(src => src.includes('chunk') || src.includes('main') || src.includes('bundle') || src.includes('app'));
    });
    scripts.forEach(s => console.log(s));

    // Check for React/Next.js/Vue markers
    console.log('\n=== FRAMEWORK DETECTION ===');
    const frameworkInfo = await page.evaluate(() => {
      const info = {};

      // React
      if (window.React || document.querySelector('[data-reactroot]') || document.querySelector('#__next')) {
        info.react = true;
        info.reactVersion = window.React?.version || 'unknown';
      }

      // Next.js
      if (window.__NEXT_DATA__ || document.querySelector('#__next')) {
        info.nextjs = true;
        info.nextData = window.__NEXT_DATA__?.buildId || 'unknown';
      }

      // Vue
      if (window.__VUE__ || document.querySelector('[data-v-]')) {
        info.vue = true;
      }

      // Redux
      if (window.__REDUX_DEVTOOLS_EXTENSION__) {
        info.reduxDevTools = true;
      }

      // Check for state management in window
      const stateKeys = Object.keys(window).filter(k =>
        k.includes('store') || k.includes('redux') || k.includes('zustand') || k.includes('state')
      );
      if (stateKeys.length) info.stateManagement = stateKeys;

      return info;
    });
    console.log(JSON.stringify(frameworkInfo, null, 2));

    // Get CSS frameworks
    console.log('\n=== CSS ANALYSIS ===');
    const cssInfo = await page.evaluate(() => {
      const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map(l => l.href);

      // Check for Tailwind
      const hasTailwind = document.querySelector('[class*="flex"]') &&
                          document.querySelector('[class*="px-"]');

      // Check for styled-components
      const hasStyledComponents = document.querySelectorAll('style[data-styled]').length > 0;

      // Check for emotion
      const hasEmotion = document.querySelectorAll('style[data-emotion]').length > 0;

      // Check for MUI
      const hasMUI = document.querySelector('[class*="MuiBox"]') ||
                     document.querySelector('[class*="css-"]');

      return {
        stylesheets: styles,
        tailwind: hasTailwind,
        styledComponents: hasStyledComponents,
        emotion: hasEmotion,
        mui: hasMUI
      };
    });
    console.log(JSON.stringify(cssInfo, null, 2));

    // Get all component-like class names
    console.log('\n=== COMPONENT CLASSES (likely component names) ===');
    const componentClasses = await page.evaluate(() => {
      const allClasses = new Set();
      document.querySelectorAll('*').forEach(el => {
        if (el.className && typeof el.className === 'string') {
          el.className.split(' ').forEach(c => {
            // Look for PascalCase or component-like names
            if (c.match(/^[A-Z]/) || c.includes('__') || c.includes('--')) {
              allClasses.add(c);
            }
          });
        }
      });
      return Array.from(allClasses).slice(0, 50);
    });
    console.log(componentClasses.join('\n'));

    // Screenshot
    console.log('\n=== TAKING SCREENSHOT ===');
    await page.screenshot({ path: '/Users/hamza/stratos/ibeam-screenshot.png', fullPage: false });
    console.log('Screenshot saved to /Users/hamza/stratos/ibeam-screenshot.png');

    // Get network requests for API endpoints
    console.log('\n=== API ENDPOINTS DETECTED ===');
    const apiCalls = await page.evaluate(() => {
      // Check for any fetch/XHR calls stored in performance
      const resources = performance.getEntriesByType('resource');
      return resources
        .filter(r => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
        .map(r => r.name)
        .filter(url => url.includes('api') || url.includes('graphql'));
    });
    apiCalls.forEach(api => console.log(api));

  } catch (error) {
    console.error('Error:', error.message);

    // Even on error, try to get what we can
    console.log('\n=== CURRENT PAGE STATE ===');
    console.log('URL:', page.url());

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || 'No body');
    console.log('Body text:', bodyText);
  }

  await browser.close();
  console.log('\nDone!');
}

inspectIbeam().catch(console.error);
