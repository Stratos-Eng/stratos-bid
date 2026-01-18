import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

interface TextPosition {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// GET /api/documents/[id]/page/[pageNum]/text - Get text positions for a page
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; pageNum: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id, pageNum: pageNumStr } = await params;
    const pageNum = parseInt(pageNumStr, 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return NextResponse.json({ error: 'Invalid page number' }, { status: 400 });
    }

    // Get document and verify ownership through bid
    const [doc] = await db
      .select({
        document: documents,
        bid: bids,
      })
      .from(documents)
      .innerJoin(bids, eq(documents.bidId, bids.id))
      .where(eq(documents.id, id))
      .limit(1);

    if (!doc || doc.bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Resolve the file path
    let resolvedPath = doc.document.storagePath;
    if (resolvedPath && !path.isAbsolute(resolvedPath)) {
      resolvedPath = path.join(process.cwd(), resolvedPath);
    }

    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      return NextResponse.json({ error: 'PDF file not found' }, { status: 404 });
    }

    // Load PDF and extract text positions
    const data = new Uint8Array(fs.readFileSync(resolvedPath));
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDocument = await loadingTask.promise;

    if (pageNum > pdfDocument.numPages) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    // Convert text items to positions using viewport transform
    const textPositions: TextPosition[] = [];

    for (const item of textContent.items) {
      // Skip non-text items
      if (!('str' in item) || !item.str.trim()) continue;

      // Transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const transform = item.transform;
      const scaleX = Math.abs(transform[0]);
      const scaleY = Math.abs(transform[3]);

      // Get font size from transform
      const fontSize = scaleY || scaleX || 12;

      // Estimate width
      let width = item.width ? item.width * (scaleX || 1) : 0;
      if (!width || width === 0) {
        width = item.str.length * fontSize * 0.6;
      }

      // Estimate height
      let height = item.height ? item.height * (scaleY || 1) : fontSize;
      if (!height || height < 8) {
        height = fontSize || 12;
      }

      // Use pdf.js Util to transform coordinates through the viewport
      // This handles rotation and any other page transforms
      const tx = pdfjsLib.Util.transform(viewport.transform, transform);
      // tx is [scaleX, skewX, skewY, scaleY, x, y] in viewport coordinates
      const x = tx[4];
      const y = tx[5];

      textPositions.push({
        text: item.str,
        x,
        // Convert Y: viewport has origin top-left, we need bottom-left for OL
        y: viewport.height - y,
        // Width and height are already in PDF points, just use them directly
        width,
        height,
      });
    }

    return NextResponse.json({
      pageNum,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      rotation: viewport.rotation || 0,
      textPositions,
    });
  } catch (error) {
    console.error('Text extraction error:', error);
    return NextResponse.json(
      { error: 'Failed to extract text' },
      { status: 500 }
    );
  }
}
