import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';

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
 * Get metadata from a PDF file
 */
export async function getPdfMetadata(filePath: string): Promise<PdfMetadata> {
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });

  const info = await parser.getInfo();

  const result = {
    pageCount: info.total,
    title: info.info?.Title as string | undefined,
    author: info.info?.Author as string | undefined,
    creator: info.info?.Creator as string | undefined,
  };

  await parser.destroy();
  return result;
}

/**
 * Extract text from all pages of a PDF
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });

  const textResult = await parser.getText();
  const text = textResult.text;

  await parser.destroy();
  return text;
}

/**
 * Extract text page by page from a PDF
 * Returns array of parsed pages with their text content
 */
export async function extractPdfPageByPage(filePath: string): Promise<ParsedPage[]> {
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });

  const textResult = await parser.getText();
  const pages: ParsedPage[] = [];

  // The text result has pages array with PageTextResult objects
  for (const page of textResult.pages) {
    pages.push({
      pageNumber: page.num,
      text: page.text.replace(/\s+/g, ' ').trim(),
      hasContent: page.text.length > 50,
    });
  }

  await parser.destroy();
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
