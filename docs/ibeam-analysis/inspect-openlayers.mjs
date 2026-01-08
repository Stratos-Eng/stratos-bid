import puppeteer from 'puppeteer';

const URL = 'https://app.ibeam.ai/blueprint/shared-view?fid=all_pdf&id=ce4cc515-a229-448b-b518-23ce95ef46bd&selected_sheet=f924bcf8-5003-43df-9903-add33ca1516a&tab=all_features&wspc=false';

async function inspectOpenLayers() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('Loading page...');
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  // 1. OpenLayers Map Analysis
  console.log('\n' + '='.repeat(80));
  console.log('OPENLAYERS IMPLEMENTATION DETAILS');
  console.log('='.repeat(80));

  const olAnalysis = await page.evaluate(() => {
    const result = {};

    // Find OpenLayers map instance
    const olViewport = document.querySelector('.ol-viewport');
    if (!olViewport) {
      return { error: 'No OpenLayers viewport found' };
    }

    result.viewport = {
      width: olViewport.offsetWidth,
      height: olViewport.offsetHeight,
      classes: olViewport.className
    };

    // Find the canvas
    const canvas = olViewport.querySelector('canvas');
    if (canvas) {
      result.canvas = {
        width: canvas.width,
        height: canvas.height,
        style: canvas.style.cssText
      };
    }

    // Find overlays (for annotations/markers)
    const overlays = olViewport.querySelectorAll('.ol-overlay-container');
    result.overlays = {
      count: overlays.length,
      samples: Array.from(overlays).slice(0, 5).map(o => ({
        classes: o.className,
        childCount: o.children.length
      }))
    };

    // Look for ol global or map instance
    result.olGlobal = typeof window.ol !== 'undefined';

    // Try to find map instance through DOM
    const mapContainer = document.querySelector('[class*="mapContainer"], [class*="ol-"], .map');
    if (mapContainer) {
      // Look for __reactFiber to find React-managed map state
      const fiberKey = Object.keys(mapContainer).find(k => k.startsWith('__reactFiber'));
      if (fiberKey) {
        result.reactManagedMap = true;
      }
    }

    return result;
  });

  console.log(JSON.stringify(olAnalysis, null, 2));

  // 2. Analyze the tile layer structure
  console.log('\n' + '='.repeat(80));
  console.log('TILE LAYER STRUCTURE (PDF as tiles)');
  console.log('='.repeat(80));

  const tileAnalysis = await page.evaluate(() => {
    const result = {};

    // Find all images that look like tiles
    const images = Array.from(document.querySelectorAll('img'));
    const tileImages = images.filter(img => {
      const src = img.src || '';
      return src.includes('storage.googleapis.com') ||
             src.includes('tile') ||
             src.includes('PDFTo');
    });

    result.tileImages = tileImages.map(img => ({
      src: img.src,
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      parent: img.parentElement?.className?.slice(0, 50)
    }));

    // Check for tile loading patterns in the URL structure
    const tileSrcs = tileImages.map(img => img.src);
    if (tileSrcs.length > 0) {
      // Analyze URL pattern
      const sampleUrl = tileSrcs[0];
      result.urlPattern = {
        sample: sampleUrl,
        hasZoomLevel: /\/\d+\/\d+\/\d+/.test(sampleUrl),
        hasTimestamp: /\d{4}\/\d+\//.test(sampleUrl)
      };
    }

    return result;
  });

  console.log(JSON.stringify(tileAnalysis, null, 2));

  // 3. Analyze the GeoJSON/Feature layer
  console.log('\n' + '='.repeat(80));
  console.log('GEOJSON / FEATURE LAYER ANALYSIS');
  console.log('='.repeat(80));

  const featureAnalysis = await page.evaluate(() => {
    const result = {};

    // Check the hidden input for GeoJSON
    const geojsonInput = document.getElementById('input_geojson');
    if (geojsonInput && geojsonInput.value) {
      try {
        const geojson = JSON.parse(geojsonInput.value);
        result.geojsonData = {
          type: geojson.type,
          featureCount: geojson.features?.length || 0,
          geometryTypes: [...new Set(geojson.features?.map(f => f.geometry?.type) || [])],
          sampleFeature: geojson.features?.[0] ? {
            type: geojson.features[0].type,
            geometryType: geojson.features[0].geometry?.type,
            properties: Object.keys(geojson.features[0].properties || {}),
            coordinatesLength: geojson.features[0].geometry?.coordinates?.length
          } : null,
          allPropertyKeys: [...new Set(
            geojson.features?.flatMap(f => Object.keys(f.properties || {})) || []
          )]
        };
      } catch (e) {
        result.geojsonParseError = e.message;
      }
    }

    // Look for SVG overlays (vector features rendered as SVG)
    const svgOverlays = document.querySelectorAll('svg');
    result.svgOverlays = {
      count: svgOverlays.length,
      samples: Array.from(svgOverlays).slice(0, 3).map(svg => ({
        width: svg.getAttribute('width'),
        height: svg.getAttribute('height'),
        childCount: svg.children.length,
        hasPath: svg.querySelector('path') !== null,
        hasPolygon: svg.querySelector('polygon') !== null
      }))
    };

    // Look for feature markers (the red diamonds in the screenshot)
    const markers = document.querySelectorAll('[class*="marker"], [class*="point"], [class*="feature"]');
    result.markers = {
      count: markers.length,
      classes: [...new Set(Array.from(markers).map(m => m.className).filter(c => c))]
    };

    return result;
  });

  console.log(JSON.stringify(featureAnalysis, null, 2));

  // 4. Analyze interaction handlers
  console.log('\n' + '='.repeat(80));
  console.log('INTERACTION / EVENT HANDLING');
  console.log('='.repeat(80));

  const interactionAnalysis = await page.evaluate(() => {
    const result = {};

    // Check for zoom controls
    const zoomControls = document.querySelectorAll('.ol-zoom, [class*="zoom"]');
    result.zoomControls = {
      count: zoomControls.length,
      types: Array.from(zoomControls).map(z => z.className?.slice(0, 50))
    };

    // Check for custom controls
    const customControls = document.querySelectorAll('.ol-control, [class*="control"]');
    result.customControls = customControls.length;

    // Look for toolbar buttons
    const toolbarButtons = document.querySelectorAll('button[class*="tool"], [class*="toolbar"] button');
    result.toolbarButtons = Array.from(toolbarButtons).map(b => ({
      text: b.textContent?.slice(0, 30),
      class: b.className?.slice(0, 50),
      ariaLabel: b.getAttribute('aria-label')
    }));

    return result;
  });

  console.log(JSON.stringify(interactionAnalysis, null, 2));

  // 5. Get the actual GeoJSON data if available
  console.log('\n' + '='.repeat(80));
  console.log('FULL GEOJSON SAMPLE (first feature)');
  console.log('='.repeat(80));

  const fullGeojson = await page.evaluate(() => {
    const geojsonInput = document.getElementById('input_geojson');
    if (geojsonInput && geojsonInput.value) {
      try {
        const geojson = JSON.parse(geojsonInput.value);
        return {
          type: geojson.type,
          totalFeatures: geojson.features?.length,
          firstFeature: geojson.features?.[0],
          lastFeature: geojson.features?.[geojson.features?.length - 1]
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    return null;
  });

  console.log(JSON.stringify(fullGeojson, null, 2));

  // 6. Check for measurement/annotation tools
  console.log('\n' + '='.repeat(80));
  console.log('MEASUREMENT / ANNOTATION SYSTEM');
  console.log('='.repeat(80));

  const measurementAnalysis = await page.evaluate(() => {
    const result = {};

    // Look for measurement-related elements
    const measurementElements = document.querySelectorAll(
      '[class*="measure"], [class*="annotation"], [class*="takeoff"], [class*="output"]'
    );
    result.measurementElements = Array.from(measurementElements).slice(0, 10).map(el => ({
      tag: el.tagName,
      class: el.className?.slice(0, 100),
      text: el.textContent?.slice(0, 50)
    }));

    // Look for the feature panel items
    const featureItems = document.querySelectorAll('[class*="feat-panel"], [class*="feature-content"]');
    result.featurePanelItems = Array.from(featureItems).slice(0, 5).map(item => ({
      text: item.textContent?.slice(0, 100),
      class: item.className?.slice(0, 100)
    }));

    // Look for count badges
    const countBadges = document.querySelectorAll('[class*="count"], [class*="badge"]');
    result.counts = Array.from(countBadges).slice(0, 10).map(badge => ({
      text: badge.textContent?.trim(),
      class: badge.className?.slice(0, 50)
    }));

    return result;
  });

  console.log(JSON.stringify(measurementAnalysis, null, 2));

  // 7. Analyze API response structure for outputs
  console.log('\n' + '='.repeat(80));
  console.log('FETCHING USER-OUTPUTS API FOR REAL DATA STRUCTURE');
  console.log('='.repeat(80));

  try {
    const apiData = await page.evaluate(async () => {
      const response = await fetch(
        'https://feathers.ibeam.ai/api/user-outputs/?attach_geojson=true&attach_attributes=false&attach_assemblies=false&worksheet_id=f924bcf8-5003-43df-9903-add33ca1516a&shared_id=ce4cc515-a229-448b-b518-23ce95ef46bd'
      );
      return await response.json();
    });

    // Sanitize and show structure
    console.log('\nAPI Response Structure:');
    console.log('Keys:', Object.keys(apiData));

    if (apiData.outputs && apiData.outputs.length > 0) {
      console.log('\nSample Output Object:');
      const sampleOutput = apiData.outputs[0];
      console.log(JSON.stringify({
        keys: Object.keys(sampleOutput),
        output_id: sampleOutput.output_id,
        feature_id: sampleOutput.feature_id,
        geojsonType: sampleOutput.geojson?.type,
        geojsonGeometryType: sampleOutput.geojson?.geometry?.type,
        geojsonProperties: sampleOutput.geojson?.properties ? Object.keys(sampleOutput.geojson.properties) : null
      }, null, 2));

      // Show full sample
      console.log('\nFull first output (truncated):');
      console.log(JSON.stringify(sampleOutput, null, 2).slice(0, 2000));
    }
  } catch (e) {
    console.log('Error fetching API:', e.message);
  }

  await browser.close();
  console.log('\nDone!');
}

inspectOpenLayers().catch(console.error);
