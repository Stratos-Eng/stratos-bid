#!/usr/bin/env tsx

/**
 * Extract specific pages from large PDF files for signage takeoff
 */

import { readFileSync, writeFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import path from 'path';

async function extractPages(
  inputPath: string,
  outputPath: string,
  startPage: number,
  endPage: number
) {
  console.log(`Loading PDF: ${inputPath}`);
  const pdfBytes = readFileSync(inputPath);

  console.log('Parsing PDF...');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();

  console.log(`Total pages: ${totalPages}`);
  console.log(`Extracting pages ${startPage} to ${endPage}...`);

  // Create new document
  const newPdf = await PDFDocument.create();

  // Copy pages (0-indexed)
  for (let i = startPage - 1; i < endPage; i++) {
    const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
    newPdf.addPage(copiedPage);
  }

  // Save
  const newPdfBytes = await newPdf.save();
  writeFileSync(outputPath, newPdfBytes);

  console.log(`Saved ${endPage - startPage + 1} pages to: ${outputPath}`);
  console.log(`File size: ${(newPdfBytes.length / 1024 / 1024).toFixed(2)} MB`);
}

async function main() {
  const du40Path = '/Users/hamza/Downloads/ESFV LRT (Metro) - FFP 02 Maintenance Facility/6 - Contract Drawings/6 - Contract Drawings/DU40 - MSF_IDR-CR_85P.pdf';
  const outputDir = '/Users/hamza/Downloads/ESFV LRT (Metro) - FFP 02 Maintenance Facility/Signage';

  // Extract site plan sheets (pages 805-813)
  await extractPages(
    du40Path,
    path.join(outputDir, 'DU40_SitePlans_805-813.pdf'),
    805,
    813
  );

  console.log('\nExtraction complete!');
}

main().catch(console.error);
