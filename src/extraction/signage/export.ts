/**
 * Export Utilities for Signage Extraction Results
 *
 * Formats extraction results for Google Sheets / Excel export.
 * Uses "X to Y" format for quantities to avoid date interpretation.
 */

import { db } from '@/db';
import { documents, lineItems, bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getSignageLegend, type LegendDetectionResult } from './legend-detector';

export interface ExportRow {
  category: string;
  description: string;
  pages: string;
  estimatedQty: string;
  unit: string;
  notes: string;
  filePath: string;
  sheetReference: string;
  confidence: string;
}

export interface ExportOptions {
  includeFilePath?: boolean;
  includeLowConfidence?: boolean;  // Include items with confidence < 0.5
  maxNoteLength?: number;
  format?: 'tsv' | 'csv' | 'json';
}

/**
 * Format quantity to avoid Sheets date interpretation
 * "5-7" becomes "5 to 7"
 * "10-15" becomes "10 to 15"
 */
function formatQuantity(qty: string | null): string {
  if (!qty) return 'TBD';

  // Replace dash ranges with "to"
  // But preserve dashes in things like "TS-01"
  const formatted = qty.replace(/(\d+)\s*-\s*(\d+)/g, '$1 to $2');

  return formatted;
}

/**
 * Truncate notes to max length, preserving whole words
 */
function truncateNotes(notes: string | null, maxLength: number = 150): string {
  if (!notes) return '';
  if (notes.length <= maxLength) return notes;

  const truncated = notes.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.7) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Aggregate line items by category, combining page numbers
 */
function aggregateByCategory(
  items: Array<{
    category: string;
    description: string;
    pageNumber: number | null;
    pageReference: string | null;
    estimatedQty: string | null;
    unit: string | null;
    notes: string | null;
    pdfFilePath: string | null;
    extractionConfidence: number | null;
  }>
): Map<string, {
  descriptions: Set<string>;
  pages: Set<number>;
  pageRefs: Set<string>;
  quantities: string[];
  notes: Set<string>;
  filePath: string;
  maxConfidence: number;
}> {
  const aggregated = new Map<string, {
    descriptions: Set<string>;
    pages: Set<number>;
    pageRefs: Set<string>;
    quantities: string[];
    notes: Set<string>;
    filePath: string;
    maxConfidence: number;
  }>();

  for (const item of items) {
    const key = item.category;

    if (!aggregated.has(key)) {
      aggregated.set(key, {
        descriptions: new Set(),
        pages: new Set(),
        pageRefs: new Set(),
        quantities: [],
        notes: new Set(),
        filePath: item.pdfFilePath || '',
        maxConfidence: 0,
      });
    }

    const agg = aggregated.get(key)!;

    if (item.description) agg.descriptions.add(item.description);
    if (item.pageNumber) agg.pages.add(item.pageNumber);
    if (item.pageReference) agg.pageRefs.add(item.pageReference);
    if (item.estimatedQty) agg.quantities.push(item.estimatedQty);
    if (item.notes) agg.notes.add(item.notes);
    if (item.extractionConfidence && item.extractionConfidence > agg.maxConfidence) {
      agg.maxConfidence = item.extractionConfidence;
    }
  }

  return aggregated;
}

/**
 * Combine quantities intelligently
 * If all same: return that value
 * If different numbers: return range
 * If includes TBD: note it
 */
function combineQuantities(quantities: string[]): string {
  if (quantities.length === 0) return 'TBD';

  // Parse numeric values
  const numbers: number[] = [];
  let hasTBD = false;

  for (const qty of quantities) {
    if (qty.toLowerCase() === 'tbd' || qty === '') {
      hasTBD = true;
      continue;
    }

    // Try to extract number
    const match = qty.match(/(\d+)/);
    if (match) {
      numbers.push(parseInt(match[1], 10));
    }
  }

  if (numbers.length === 0) return 'TBD';

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const sum = numbers.reduce((a, b) => a + b, 0);

  // If single value or all same
  if (min === max) {
    return hasTBD ? `${sum}+` : String(sum);
  }

  // Return range
  return `${min} to ${max}`;
}

/**
 * Get export data for a single document
 */
export async function getDocumentExportData(
  documentId: string,
  options: ExportOptions = {}
): Promise<ExportRow[]> {
  const { includeLowConfidence = false, maxNoteLength = 150 } = options;

  // Get line items
  const items = await db
    .select({
      category: lineItems.category,
      description: lineItems.description,
      pageNumber: lineItems.pageNumber,
      pageReference: lineItems.pageReference,
      estimatedQty: lineItems.estimatedQty,
      unit: lineItems.unit,
      notes: lineItems.notes,
      pdfFilePath: lineItems.pdfFilePath,
      extractionConfidence: lineItems.extractionConfidence,
    })
    .from(lineItems)
    .where(
      and(
        eq(lineItems.documentId, documentId),
        eq(lineItems.tradeCode, 'division_10')
      )
    );

  // Filter low confidence if needed
  const filteredItems = includeLowConfidence
    ? items
    : items.filter(i => (i.extractionConfidence || 0) >= 0.5);

  // Aggregate by category
  const aggregated = aggregateByCategory(filteredItems);

  // Get legend for sheet references
  const legend = await getSignageLegend(documentId);

  // Build export rows
  const rows: ExportRow[] = [];

  for (const [category, data] of aggregated) {
    const pages = Array.from(data.pages).sort((a, b) => a - b);
    const pageRefs = Array.from(data.pageRefs);

    rows.push({
      category,
      description: Array.from(data.descriptions).slice(0, 2).join('; '),
      pages: pages.length > 5
        ? pages.slice(0, 5).join(', ') + '...'
        : pages.join(', '),
      estimatedQty: formatQuantity(combineQuantities(data.quantities)),
      unit: 'EA',
      notes: truncateNotes(Array.from(data.notes).join('. '), maxNoteLength),
      filePath: data.filePath,
      sheetReference: pageRefs.length > 0
        ? pageRefs.join(', ')
        : (legend?.sheetNumbers?.join(', ') || ''),
      confidence: data.maxConfidence >= 0.8 ? 'High'
        : data.maxConfidence >= 0.5 ? 'Medium'
        : 'Low',
    });
  }

  // Sort by category
  rows.sort((a, b) => a.category.localeCompare(b.category));

  return rows;
}

/**
 * Get export data for all documents in a bid
 */
export async function getBidExportData(
  bidId: string,
  options: ExportOptions = {}
): Promise<ExportRow[]> {
  // Get all documents for bid
  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.bidId, bidId));

  // Aggregate across all documents
  const allRows: ExportRow[] = [];

  for (const doc of docs) {
    const docRows = await getDocumentExportData(doc.id, options);
    allRows.push(...docRows);
  }

  // Re-aggregate across documents (combine same categories)
  const combined = new Map<string, ExportRow>();

  for (const row of allRows) {
    if (!combined.has(row.category)) {
      combined.set(row.category, { ...row });
    } else {
      const existing = combined.get(row.category)!;
      // Combine pages
      const allPages = new Set([
        ...existing.pages.split(', ').filter(p => p),
        ...row.pages.split(', ').filter(p => p),
      ]);
      existing.pages = Array.from(allPages).slice(0, 10).join(', ');
      // Keep higher confidence
      if (row.confidence === 'High' || (row.confidence === 'Medium' && existing.confidence === 'Low')) {
        existing.confidence = row.confidence;
      }
    }
  }

  return Array.from(combined.values()).sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Format rows as tab-separated values (for Google Sheets)
 */
export function formatAsTSV(rows: ExportRow[], options: ExportOptions = {}): string {
  const { includeFilePath = false } = options;

  // Header
  const headers = includeFilePath
    ? ['Category', 'Description', 'Pages', 'Est Qty', 'Unit', 'Notes', 'File Path', 'Sheet Ref', 'Confidence']
    : ['Category', 'Description', 'Pages', 'Est Qty', 'Unit', 'Notes', 'Sheet Ref', 'Confidence'];

  const lines = [headers.join('\t')];

  // Data rows
  for (const row of rows) {
    const values = includeFilePath
      ? [row.category, row.description, row.pages, row.estimatedQty, row.unit, row.notes, row.filePath, row.sheetReference, row.confidence]
      : [row.category, row.description, row.pages, row.estimatedQty, row.unit, row.notes, row.sheetReference, row.confidence];

    // Escape tabs and newlines in values
    const escaped = values.map(v => v.replace(/[\t\n\r]/g, ' '));
    lines.push(escaped.join('\t'));
  }

  return lines.join('\n');
}

/**
 * Format rows as CSV
 */
export function formatAsCSV(rows: ExportRow[], options: ExportOptions = {}): string {
  const { includeFilePath = false } = options;

  const headers = includeFilePath
    ? ['Category', 'Description', 'Pages', 'Est Qty', 'Unit', 'Notes', 'File Path', 'Sheet Ref', 'Confidence']
    : ['Category', 'Description', 'Pages', 'Est Qty', 'Unit', 'Notes', 'Sheet Ref', 'Confidence'];

  const lines = [headers.map(h => `"${h}"`).join(',')];

  for (const row of rows) {
    const values = includeFilePath
      ? [row.category, row.description, row.pages, row.estimatedQty, row.unit, row.notes, row.filePath, row.sheetReference, row.confidence]
      : [row.category, row.description, row.pages, row.estimatedQty, row.unit, row.notes, row.sheetReference, row.confidence];

    // Escape quotes in values
    const escaped = values.map(v => `"${v.replace(/"/g, '""')}"`);
    lines.push(escaped.join(','));
  }

  return lines.join('\n');
}

/**
 * Full export function - get data and format
 */
export async function exportDocumentSignage(
  documentId: string,
  options: ExportOptions = {}
): Promise<string> {
  const rows = await getDocumentExportData(documentId, options);
  const format = options.format || 'tsv';

  switch (format) {
    case 'csv':
      return formatAsCSV(rows, options);
    case 'json':
      return JSON.stringify(rows, null, 2);
    case 'tsv':
    default:
      return formatAsTSV(rows, options);
  }
}

/**
 * Full export function for bid
 */
export async function exportBidSignage(
  bidId: string,
  options: ExportOptions = {}
): Promise<string> {
  const rows = await getBidExportData(bidId, options);
  const format = options.format || 'tsv';

  switch (format) {
    case 'csv':
      return formatAsCSV(rows, options);
    case 'json':
      return JSON.stringify(rows, null, 2);
    case 'tsv':
    default:
      return formatAsTSV(rows, options);
  }
}
