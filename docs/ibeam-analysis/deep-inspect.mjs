import puppeteer from 'puppeteer';
import fs from 'fs';

const URL = 'https://app.ibeam.ai/blueprint/shared-view?fid=all_pdf&id=ce4cc515-a229-448b-b518-23ce95ef46bd&selected_sheet=f924bcf8-5003-43df-9903-add33ca1516a&tab=all_features&wspc=false';

async function deepInspect() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Capture all network requests
  const apiRequests = [];
  const jsFiles = [];

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (url.includes('feathers.ibeam.ai/api')) {
      try {
        const data = await response.json();
        apiRequests.push({
          url: url.split('?')[0],
          method: response.request().method(),
          status: response.status(),
          dataKeys: Object.keys(data || {}),
          sampleData: JSON.stringify(data).slice(0, 500)
        });
      } catch (e) {}
    }

    if (contentType.includes('javascript') && url.includes('ibeam.ai')) {
      jsFiles.push(url);
    }
  });

  console.log('Navigating...');
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  // 1. DEEP DOM ANALYSIS
  console.log('\n' + '='.repeat(80));
  console.log('DEEP DOM ANALYSIS - Understanding the UI Structure');
  console.log('='.repeat(80));

  const domAnalysis = await page.evaluate(() => {
    const analysis = {};

    // Find the main content areas
    analysis.mainLayout = {};

    // Left sidebar (Features panel)
    const sidebar = document.querySelector('[class*="appSidebar"]');
    if (sidebar) {
      analysis.mainLayout.leftSidebar = {
        classes: sidebar.className,
        children: Array.from(sidebar.children).map(c => ({
          tag: c.tagName,
          class: c.className?.slice(0, 100),
          role: c.getAttribute('role')
        }))
      };
    }

    // Main canvas area
    const canvasContainer = document.querySelector('[class*="canvasContainer"], canvas, [class*="maplibre"], [class*="leaflet"]');
    if (canvasContainer) {
      analysis.mainLayout.canvas = {
        tag: canvasContainer.tagName,
        classes: canvasContainer.className,
        id: canvasContainer.id
      };
    }

    // Find all canvas elements
    analysis.canvasElements = Array.from(document.querySelectorAll('canvas')).map(c => ({
      id: c.id,
      class: c.className,
      width: c.width,
      height: c.height,
      parent: c.parentElement?.className?.slice(0, 100)
    }));

    // Find map libraries
    analysis.mapLibraries = {
      maplibre: !!window.maplibregl,
      leaflet: !!window.L,
      mapbox: !!window.mapboxgl,
      openlayers: !!window.ol,
      googleMaps: !!window.google?.maps
    };

    // Right panel (Plans)
    const rightPanel = document.querySelector('[class*="Plans"], [class*="rightPanel"]');
    if (rightPanel) {
      analysis.mainLayout.rightPanel = {
        classes: rightPanel.className?.slice(0, 200)
      };
    }

    // Feature list items
    const featureItems = document.querySelectorAll('[class*="feature"], [class*="Point"]');
    analysis.featureList = {
      count: featureItems.length,
      sampleClasses: Array.from(featureItems).slice(0, 3).map(f => f.className?.slice(0, 100))
    };

    // Find React Fiber data
    const rootEl = document.getElementById('root');
    if (rootEl) {
      const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber'));
      analysis.reactFiberFound = !!fiberKey;
    }

    // Window globals related to the app
    analysis.windowGlobals = Object.keys(window).filter(k =>
      k.toLowerCase().includes('beam') ||
      k.toLowerCase().includes('map') ||
      k.toLowerCase().includes('layer') ||
      k.toLowerCase().includes('tile') ||
      k.toLowerCase().includes('feature') ||
      k.toLowerCase().includes('geojson')
    );

    return analysis;
  });

  console.log(JSON.stringify(domAnalysis, null, 2));

  // 2. ANALYZE THE MAP/CANVAS IMPLEMENTATION
  console.log('\n' + '='.repeat(80));
  console.log('MAP/CANVAS IMPLEMENTATION');
  console.log('='.repeat(80));

  const mapAnalysis = await page.evaluate(() => {
    const result = {};

    // Check for MapLibre GL
    if (window.maplibregl) {
      result.mapLibrary = 'MapLibre GL JS';

      // Try to find map instance
      const mapContainers = document.querySelectorAll('.maplibregl-map, [class*="map"]');
      result.mapContainers = mapContainers.length;

      // Check for map instance in window
      for (const key of Object.keys(window)) {
        const val = window[key];
        if (val && typeof val === 'object' && val.getCenter && val.getZoom) {
          result.mapInstanceFound = key;
          try {
            result.mapState = {
              center: val.getCenter(),
              zoom: val.getZoom(),
              bearing: val.getBearing?.(),
              pitch: val.getPitch?.()
            };
            result.mapLayers = val.getStyle?.()?.layers?.slice(0, 10)?.map(l => ({
              id: l.id,
              type: l.type,
              source: l.source
            }));
            result.mapSources = Object.keys(val.getStyle?.()?.sources || {});
          } catch (e) {}
          break;
        }
      }
    }

    // Check for Leaflet
    if (window.L) {
      result.mapLibrary = result.mapLibrary || 'Leaflet';
    }

    // Check for OpenLayers
    const olMaps = document.querySelectorAll('.ol-viewport');
    if (olMaps.length > 0) {
      result.mapLibrary = 'OpenLayers';
      result.olViewports = olMaps.length;
    }

    // Analyze WebGL context
    const canvases = document.querySelectorAll('canvas');
    result.webglCanvases = [];
    canvases.forEach((canvas, i) => {
      try {
        const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
        if (gl) {
          result.webglCanvases.push({
            index: i,
            width: canvas.width,
            height: canvas.height,
            renderer: gl.getParameter(gl.RENDERER),
            vendor: gl.getParameter(gl.VENDOR)
          });
        }
      } catch (e) {}
    });

    return result;
  });

  console.log(JSON.stringify(mapAnalysis, null, 2));

  // 3. ANALYZE TILE LOADING (PDF rendered as tiles)
  console.log('\n' + '='.repeat(80));
  console.log('TILE LOADING SYSTEM (PDF as Map Tiles)');
  console.log('='.repeat(80));

  const tileInfo = await page.evaluate(() => {
    const images = Array.from(document.querySelectorAll('img'));
    const tileImages = images.filter(img =>
      img.src.includes('tile') ||
      img.src.includes('Tiles') ||
      img.src.includes('/0/') ||
      img.src.includes('storage.googleapis.com')
    );

    return {
      totalImages: images.length,
      tileImages: tileImages.length,
      tileSources: tileImages.slice(0, 5).map(img => img.src)
    };
  });

  console.log(JSON.stringify(tileInfo, null, 2));

  // Check network requests for tile patterns
  const tileRequests = apiRequests.filter(r =>
    r.url.includes('tile') || r.url.includes('Tiles')
  );
  console.log('\nTile API requests:', tileRequests.length);

  // 4. ANALYZE STATE MANAGEMENT
  console.log('\n' + '='.repeat(80));
  console.log('STATE MANAGEMENT');
  console.log('='.repeat(80));

  const stateAnalysis = await page.evaluate(() => {
    const result = {};

    // Check for Redux
    if (window.__REDUX_DEVTOOLS_EXTENSION__) {
      result.redux = true;
    }

    // Check for Zustand
    const zustandStores = Object.keys(window).filter(k =>
      k.includes('zustand') || k.includes('store')
    );
    if (zustandStores.length) {
      result.zustandLike = zustandStores;
    }

    // Check for React Query
    const reactQueryClient = Object.keys(window).filter(k =>
      k.includes('query') || k.includes('Query')
    );
    if (reactQueryClient.length) {
      result.reactQuery = reactQueryClient;
    }

    // Look for global state objects
    const stateObjects = {};
    for (const key of Object.keys(window)) {
      const val = window[key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (key.toLowerCase().includes('state') ||
            key.toLowerCase().includes('store') ||
            key.toLowerCase().includes('context')) {
          stateObjects[key] = Object.keys(val).slice(0, 10);
        }
      }
    }
    result.globalStateObjects = stateObjects;

    return result;
  });

  console.log(JSON.stringify(stateAnalysis, null, 2));

  // 5. API STRUCTURE
  console.log('\n' + '='.repeat(80));
  console.log('API ENDPOINTS & DATA STRUCTURE');
  console.log('='.repeat(80));

  console.log('\nDiscovered API endpoints:');
  apiRequests.forEach(req => {
    console.log(`\n${req.method} ${req.url}`);
    console.log(`  Status: ${req.status}`);
    console.log(`  Keys: ${req.dataKeys.join(', ')}`);
    console.log(`  Sample: ${req.sampleData.slice(0, 200)}...`);
  });

  // 6. COMPONENT HIERARCHY
  console.log('\n' + '='.repeat(80));
  console.log('REACT COMPONENT HIERARCHY');
  console.log('='.repeat(80));

  const componentTree = await page.evaluate(() => {
    function getReactComponentName(fiber) {
      if (!fiber) return null;
      if (fiber.type) {
        if (typeof fiber.type === 'string') return fiber.type;
        return fiber.type.displayName || fiber.type.name || 'Anonymous';
      }
      return null;
    }

    function buildTree(element, depth = 0) {
      if (depth > 6 || !element) return null;

      const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber'));
      const fiber = fiberKey ? element[fiberKey] : null;
      const componentName = getReactComponentName(fiber);

      const children = [];
      for (const child of element.children || []) {
        const childTree = buildTree(child, depth + 1);
        if (childTree) children.push(childTree);
      }

      // Only include if it has a component name or interesting children
      if (componentName || children.length > 0) {
        return {
          component: componentName || element.tagName?.toLowerCase(),
          className: element.className?.split?.(' ')?.[0]?.slice(0, 50),
          children: children.slice(0, 5)
        };
      }
      return null;
    }

    const root = document.getElementById('root');
    return buildTree(root);
  });

  console.log(JSON.stringify(componentTree, null, 2));

  // 7. GEOJSON / FEATURE DATA STRUCTURE
  console.log('\n' + '='.repeat(80));
  console.log('GEOJSON / FEATURE DATA STRUCTURE');
  console.log('='.repeat(80));

  const geojsonInput = await page.evaluate(() => {
    const input = document.getElementById('input_geojson');
    if (input && input.value) {
      try {
        const data = JSON.parse(input.value);
        return {
          type: data.type,
          featuresCount: data.features?.length,
          sampleFeature: data.features?.[0],
          featureTypes: [...new Set(data.features?.map(f => f.geometry?.type) || [])]
        };
      } catch (e) {
        return { raw: input.value.slice(0, 500) };
      }
    }
    return null;
  });

  console.log(JSON.stringify(geojsonInput, null, 2));

  // 8. CSS MODULE PATTERNS
  console.log('\n' + '='.repeat(80));
  console.log('CSS ARCHITECTURE');
  console.log('='.repeat(80));

  const cssAnalysis = await page.evaluate(() => {
    const allClasses = new Set();
    document.querySelectorAll('*').forEach(el => {
      if (el.className && typeof el.className === 'string') {
        el.className.split(' ').forEach(c => allClasses.add(c));
      }
    });

    const patterns = {
      cssModules: [],      // style-module_xxx__hash
      muiComponents: [],   // Mui*
      antdComponents: [],  // ant-*
      tailwind: [],        // p-4, flex, etc
      bem: []              // block__element--modifier
    };

    allClasses.forEach(c => {
      if (c.match(/style-module_\w+__\w+/)) patterns.cssModules.push(c);
      else if (c.startsWith('Mui')) patterns.muiComponents.push(c);
      else if (c.startsWith('ant-')) patterns.antdComponents.push(c);
      else if (c.match(/^(p|m|flex|grid|text|bg|border|rounded)-/)) patterns.tailwind.push(c);
      else if (c.includes('__') || c.includes('--')) patterns.bem.push(c);
    });

    return {
      cssModulesCount: patterns.cssModules.length,
      cssModulesSample: [...new Set(patterns.cssModules.map(c => c.split('__')[0]))].slice(0, 20),
      muiCount: patterns.muiComponents.length,
      muiSample: [...new Set(patterns.muiComponents)].slice(0, 20),
      antdCount: patterns.antdComponents.length,
      tailwindCount: patterns.tailwind.length
    };
  });

  console.log(JSON.stringify(cssAnalysis, null, 2));

  // 9. JS FILE ANALYSIS
  console.log('\n' + '='.repeat(80));
  console.log('JAVASCRIPT BUNDLES');
  console.log('='.repeat(80));

  console.log('Loaded JS files:');
  jsFiles.forEach(f => console.log(f));

  // Save all analysis to a file
  const fullAnalysis = {
    domAnalysis,
    mapAnalysis,
    tileInfo,
    stateAnalysis,
    apiRequests,
    componentTree,
    geojsonInput,
    cssAnalysis,
    jsFiles
  };

  fs.writeFileSync('/Users/hamza/stratos/ibeam-analysis.json', JSON.stringify(fullAnalysis, null, 2));
  console.log('\nFull analysis saved to ibeam-analysis.json');

  await browser.close();
}

deepInspect().catch(console.error);
