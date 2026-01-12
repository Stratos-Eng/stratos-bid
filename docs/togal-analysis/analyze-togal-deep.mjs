import puppeteer from 'puppeteer';

const URL = 'https://www-prod.togal.ai/auth/login';

async function analyzeTogalDeep() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const jsContent = {};
  const allJSUrls = [];

  // Intercept JS files and analyze content
  page.on('response', async (response) => {
    const url = response.url();
    if ((url.endsWith('.js') || url.includes('.js?')) && url.includes('togal.ai')) {
      allJSUrls.push(url);
      try {
        const buffer = await response.buffer();
        const content = buffer.toString('utf-8');

        // Look for specific patterns
        const patterns = {
          // PDF Libraries
          mupdf: content.includes('mupdf') || content.includes('libmupdf'),
          pdfjs: content.includes('pdfjsLib') || content.includes('pdfjs'),

          // 3D/Canvas
          threejs: content.includes('THREE') || content.includes('BufferGeometry'),
          webgl: content.includes('WebGL') || content.includes('webgl'),
          canvas2d: content.includes('getContext') && content.includes('2d'),

          // Map/Drawing
          openlayers: content.includes('ol/') || content.includes('openlayers'),
          leaflet: content.includes('leaflet') || content.includes('L.map'),
          mapbox: content.includes('mapbox'),
          fabric: content.includes('fabric.js') || content.includes('fabric.Canvas'),
          konva: content.includes('Konva'),
          paperjs: content.includes('paper.js'),

          // Drawing interactions
          drawInteraction: content.includes('draw') && content.includes('interaction'),
          polygon: content.includes('polygon') || content.includes('Polygon'),
          polyline: content.includes('polyline') || content.includes('LineString'),

          // Measurement
          measurement: content.includes('measurement') || content.includes('measure'),
          scale: content.includes('scale') && content.includes('calibrat'),
          area: content.includes('calculateArea') || content.includes('getArea'),
          length: content.includes('calculateLength') || content.includes('getLength'),

          // Data/State
          redux: content.includes('redux') || content.includes('createStore'),
          mobx: content.includes('mobx') || content.includes('observable'),
          zustand: content.includes('zustand'),
          reactQuery: content.includes('useQuery') || content.includes('tanstack'),

          // Real-time
          websocket: content.includes('WebSocket') || content.includes('socket.io'),
          firebase: content.includes('firebase'),
          pusher: content.includes('pusher'),

          // Export
          xlsx: content.includes('xlsx') || content.includes('SheetJS'),
          jspdf: content.includes('jsPDF') || content.includes('jspdf'),
          filesaver: content.includes('FileSaver') || content.includes('saveAs'),

          // AI/ML
          tensorflow: content.includes('tensorflow') || content.includes('@tensorflow'),
          onnx: content.includes('onnx'),

          // API patterns
          graphql: content.includes('graphql') || content.includes('__typename'),
          rest: content.includes('/api/v1') || content.includes('/api/v2'),
        };

        const hasPatterns = Object.values(patterns).some(v => v);
        if (hasPatterns) {
          const fileName = url.split('/').pop().split('?')[0];
          jsContent[fileName] = {
            url,
            size: content.length,
            patterns: Object.fromEntries(Object.entries(patterns).filter(([k, v]) => v))
          };
        }

        // Also search for specific function names and classes
        const specificFinds = [];

        // Look for specific API endpoints
        const apiMatches = content.match(/["']\/api\/v\d+\/[^"']+["']/g);
        if (apiMatches) {
          specificFinds.push(...apiMatches.slice(0, 20));
        }

        // Look for route definitions
        const routeMatches = content.match(/path:\s*["'][^"']+["']/g);
        if (routeMatches) {
          specificFinds.push(...routeMatches.slice(0, 20));
        }

        if (specificFinds.length > 0) {
          const fileName = url.split('/').pop().split('?')[0];
          if (!jsContent[fileName]) {
            jsContent[fileName] = { url, size: content.length, patterns: {} };
          }
          jsContent[fileName].specificFinds = [...new Set(specificFinds)];
        }

      } catch (e) {
        // Ignore errors
      }
    }
  });

  console.log('Loading Togal.ai...');
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  // ============================================================================
  // DEEP WINDOW ANALYSIS
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('DEEP WINDOW ANALYSIS');
  console.log('='.repeat(80));

  const windowDeep = await page.evaluate(() => {
    const results = {};

    // Check for MuPDF
    results.mupdfFunctions = Object.keys(window).filter(k => k.includes('mupdf') || k.includes('libmupdf'));

    // Check for Three.js
    if (window.__THREE__) {
      results.threeVersion = window.__THREE__;
    }

    // Check for Sentry config
    if (window.__SENTRY__) {
      results.sentryHub = !!window.__SENTRY__.hub;
    }

    // React Router version
    results.reactRouterVersion = window.__reactRouterVersion;

    // Check for segment/analytics
    if (window.__SEGMENT_INSPECTOR__) {
      results.hasSegment = true;
    }

    // Auth context
    if (window.authContext) {
      results.authContextKeys = Object.keys(window.authContext);
    }

    // Check for theme
    results.hasTheme = !!window.theme;
    results.hasLightTheme = !!window.lightTheme;
    results.hasDarkTheme = !!window.darkTheme;

    // Look for global app state
    const stateKeys = Object.keys(window).filter(k =>
      k.includes('store') || k.includes('Store') ||
      k.includes('state') || k.includes('State') ||
      k.includes('redux') || k.includes('Redux')
    );
    results.stateKeys = stateKeys;

    // Check for API request function
    if (window.apiRequest) {
      results.hasApiRequest = true;
      results.apiRequestType = typeof window.apiRequest;
    }

    return results;
  });

  console.log('\nWindow Deep Analysis:', JSON.stringify(windowDeep, null, 2));

  // ============================================================================
  // JS BUNDLE ANALYSIS
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('JS BUNDLE PATTERNS');
  console.log('='.repeat(80));

  for (const [name, data] of Object.entries(jsContent)) {
    console.log(`\n${name} (${(data.size / 1024).toFixed(1)}KB)`);

    if (Object.keys(data.patterns).length > 0) {
      console.log('  Patterns:');
      for (const [pattern, found] of Object.entries(data.patterns)) {
        console.log(`    ✓ ${pattern}`);
      }
    }

    if (data.specificFinds && data.specificFinds.length > 0) {
      console.log('  API/Routes found:');
      data.specificFinds.slice(0, 10).forEach(f => console.log(`    ${f}`));
    }
  }

  // ============================================================================
  // ALL JS FILES
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('ALL JS FILES FROM TOGAL.AI');
  console.log('='.repeat(80));

  const togalJS = allJSUrls.filter(u => u.includes('togal.ai'));
  console.log('\nTogal JS files:', togalJS.length);
  togalJS.forEach(url => {
    const name = url.split('/').pop().split('?')[0];
    console.log(`  ${name}`);
  });

  // ============================================================================
  // TRY TO FIND PUBLIC ROUTES
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('INFERRING APPLICATION STRUCTURE');
  console.log('='.repeat(80));

  // Look at the main bundle for route info
  const mainBundle = Object.values(jsContent).find(b => b.size > 100000);
  if (mainBundle && mainBundle.specificFinds) {
    console.log('\nLikely routes/endpoints:');
    mainBundle.specificFinds.forEach(f => console.log(`  ${f}`));
  }

  // Save full analysis
  const fs = await import('fs');
  fs.writeFileSync('/Users/hamza/stratos/togal-deep-analysis.json', JSON.stringify({
    windowDeep,
    jsContent,
    allJSUrls: togalJS
  }, null, 2));

  console.log('\n\nFull analysis saved to: togal-deep-analysis.json');

  await browser.close();
}

analyzeTogalDeep().catch(console.error);
