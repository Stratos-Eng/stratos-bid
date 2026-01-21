import fs from 'fs';
import path from 'path';
import { extractText, getDocumentProxy } from 'unpdf';

export interface ParsedPage {
  pageNumber: number;
  text: string;
  hasContent: boolean;
}

export interface PdfMetadata {
  pageCount: number;
  title?: string;
  author?: string;
  creator?: string;
}

/**
 * Load PDF and get document proxy
 */
async function loadPdf(filePath: string) {
  const dataBuffer = fs.readFileSync(filePath);
  return getDocumentProxy(new Uint8Array(dataBuffer));
}

/**
 * Get metadata from a PDF file
 */
export async function getPdfMetadata(filePath: string): Promise<PdfMetadata> {
  const pdf = await loadPdf(filePath);

  // Get metadata from PDF
  const metadata = await pdf.getMetadata();
  const info = metadata?.info as Record<string, unknown> | undefined;

  const result = {
    pageCount: pdf.numPages,
    title: info?.Title as string | undefined,
    author: info?.Author as string | undefined,
    creator: info?.Creator as string | undefined,
  };

  // Clean up
  await pdf.cleanup();

  return result;
}

/**
 * Extract text from all pages of a PDF
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const pdf = await loadPdf(filePath);

  const { text } = await extractText(pdf, { mergePages: true });

  await pdf.cleanup();

  return text;
}

/**
 * Extract text page by page from a PDF
 * Returns array of parsed pages with their text content
 */
export async function extractPdfPageByPage(filePath: string): Promise<ParsedPage[]> {
  const pdf = await loadPdf(filePath);

  // Extract text per page (mergePages: false is default)
  const { text: pageTexts } = await extractText(pdf, { mergePages: false });

  const pages: ParsedPage[] = [];

  // pageTexts is an array when mergePages is false
  const textArray = Array.isArray(pageTexts) ? pageTexts : [pageTexts];

  for (let i = 0; i < textArray.length; i++) {
    const pageText = textArray[i] || '';
    const cleanedText = pageText.replace(/\s+/g, ' ').trim();

    pages.push({
      pageNumber: i + 1,
      text: cleanedText,
      hasContent: cleanedText.length > 50,
    });
  }

  await pdf.cleanup();

  return pages;
}

/**
 * Extract text from specific pages of a PDF
 */
export async function extractPdfPages(
  filePath: string,
  pageNumbers: number[]
): Promise<ParsedPage[]> {
  const allPages = await extractPdfPageByPage(filePath);
  return allPages.filter(p => pageNumbers.includes(p.pageNumber));
}

/**
 * Find pages that likely contain trade-specific content
 */
export async function findRelevantPages(
  filePath: string,
  keywords: string[]
): Promise<ParsedPage[]> {
  const allPages = await extractPdfPageByPage(filePath);

  return allPages.filter(page => {
    const lowerText = page.text.toLowerCase();
    return keywords.some(kw => lowerText.includes(kw.toLowerCase()));
  });
}

/**
 * Get file size in bytes
 */
export function getFileSize(filePath: string): number {
  const stats = fs.statSync(filePath);
  return stats.size;
}

/**
 * Check if file exists and is a PDF
 */
export function validatePdfFile(filePath: string): { valid: boolean; error?: string } {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: 'File not found' };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') {
    return { valid: false, error: 'File is not a PDF' };
  }

  const size = getFileSize(filePath);
  if (size === 0) {
    return { valid: false, error: 'File is empty' };
  }

  // Check for reasonable size (max 500MB)
  if (size > 500 * 1024 * 1024) {
    return { valid: false, error: 'File too large (max 500MB)' };
  }

  return { valid: true };
}
