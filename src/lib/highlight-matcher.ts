/**
 * Highlight Matcher - Utilities for matching search terms to text positions
 * and converting PDF coordinates to OpenLayers coordinates.
 */

export interface TextPosition {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Find text positions that match any of the search terms.
 * Performs case-insensitive matching.
 */
export function findMatchingPositions(
  textPositions: TextPosition[],
  searchTerms: string[]
): TextPosition[] {
  if (!searchTerms.length || !textPositions.length) {
    return [];
  }

  // Normalize search terms for case-insensitive matching
  const normalizedTerms = searchTerms
    .map(term => term.toLowerCase().trim())
    .filter(term => term.length > 0);

  if (normalizedTerms.length === 0) {
    return [];
  }

  return textPositions.filter(pos => {
    const normalizedText = pos.text.toLowerCase();
    return normalizedTerms.some(term => normalizedText.includes(term));
  });
}

/**
 * Extract search terms from a query string.
 * Handles phrase queries (quoted) and regular word splitting.
 */
export function extractSearchTerms(query: string): string[] {
  if (!query || !query.trim()) {
    return [];
  }

  const terms: string[] = [];
  const trimmed = query.trim();

  // Check for phrase query (wrapped in quotes)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // Phrase query - keep as single term
    const phrase = trimmed.slice(1, -1).trim();
    if (phrase) {
      terms.push(phrase);
    }
  } else {
    // Regular query - split into words
    const words = trimmed.split(/\s+/).filter(word => word.length > 0);
    terms.push(...words);
  }

  return terms;
}

/**
 * Convert PDF coordinates to OpenLayers coordinates.
 *
 * PDF coordinate system:
 * - Origin at bottom-left
 * - Y increases upward
 * - Units are points (72 per inch)
 *
 * OpenLayers coordinate system (in our setup):
 * - Same as PDF: origin at bottom-left, Y increases upward
 * - Units are pixels at 150 DPI
 * - The image extent is [0, 0, width*scale, height*scale]
 *
 * @param pdfX - X coordinate in PDF points
 * @param pdfY - Y coordinate in PDF points (bottom-left origin, text baseline)
 * @param pdfWidth - Width in PDF points
 * @param pdfHeight - Height in PDF points
 * @param pageHeight - Total page height in PDF points (unused, kept for API compat)
 * @param dpi - Target DPI (default 150)
 */
export function pdfToOLCoords(
  pdfX: number,
  pdfY: number,
  pdfWidth: number,
  pdfHeight: number,
  pageHeight: number,
  dpi: number = 150
): HighlightRect {
  // Scale factor: PDF points to pixels at target DPI
  // PDF uses 72 points per inch
  const scale = dpi / 72;

  // Both PDF and our OL setup use bottom-left origin with Y up
  // Just scale the coordinates
  const olX = pdfX * scale;
  const olY = pdfY * scale; // baseline of text

  // Scale dimensions
  const olWidth = pdfWidth * scale;
  const olHeight = pdfHeight * scale;

  return {
    x: olX,
    y: olY,
    width: olWidth,
    height: olHeight,
  };
}

/**
 * Convert an array of matching text positions to OpenLayers highlight rectangles.
 */
export function textPositionsToHighlights(
  positions: TextPosition[],
  pageHeight: number,
  dpi: number = 150
): HighlightRect[] {
  return positions.map(pos =>
    pdfToOLCoords(pos.x, pos.y, pos.width, pos.height, pageHeight, dpi)
  );
}

/**
 * Merge overlapping or adjacent highlight rectangles to reduce visual clutter.
 * Rectangles within `threshold` pixels are considered adjacent.
 */
export function mergeAdjacentHighlights(
  highlights: HighlightRect[],
  threshold: number = 2
): HighlightRect[] {
  if (highlights.length <= 1) {
    return highlights;
  }

  // Sort by Y then X
  const sorted = [...highlights].sort((a, b) => {
    if (Math.abs(a.y - b.y) < threshold) {
      return a.x - b.x;
    }
    return a.y - b.y;
  });

  const merged: HighlightRect[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    // Check if on same line and adjacent
    const sameRow = Math.abs(current.y - next.y) < threshold;
    const adjacent = next.x <= current.x + current.width + threshold;

    if (sameRow && adjacent) {
      // Merge: extend current to include next
      const newRight = Math.max(current.x + current.width, next.x + next.width);
      current.width = newRight - current.x;
      current.height = Math.max(current.height, next.height);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}
