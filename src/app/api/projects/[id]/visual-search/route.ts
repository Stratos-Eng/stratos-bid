import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids, symbolRegions } from '@/db/schema';
import { eq, sql, and } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { applyRateLimit, createRateLimitResponse, rateLimitConfigs } from '@/lib/rate-limit';
import { isBlobUrl } from '@/lib/storage';
import { pythonApi, PythonApiNotConfiguredError } from '@/lib/python-api';

interface VisualSearchRequest {
  documentId: string;
  pageNum: number;
  x: number; // Normalized 0-1
  y: number; // Normalized 0-1
  width?: number; // Crop width in pixels (default 100)
  height?: number; // Crop height in pixels (default 100)
}

interface SearchMatch {
  documentId: string;
  documentName: string;
  pageNumber: number;
  x: number;
  y: number;
  similarity: number;
  ocrText?: string;
  thumbnail?: string; // Base64 PNG
}

interface VisualSearchResponse {
  success: boolean;
  query: {
    documentId: string;
    pageNumber: number;
    x: number;
    y: number;
    thumbnail: string; // Base64 PNG of the clicked region
    ocrText?: string;
    ocrConfidence?: number;
  };
  searchMethod: 'text' | 'visual' | 'none';
  matches: SearchMatch[];
  error?: string;
}

// POST /api/projects/[id]/visual-search
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limiting: 20 requests per minute (AI operations are expensive)
    const rateLimit = applyRateLimit(request, rateLimitConfigs.extraction, session.user.id);
    if (!rateLimit.success) {
      return createRateLimitResponse(rateLimit);
    }

    const { id: projectId } = await params;
    const body: VisualSearchRequest = await request.json();

    const { documentId, pageNum, x, y, width = 100, height = 100 } = body;

    // Verify user has access to this project (via bid ownership)
    const [bid] = await db
      .select()
      .from(bids)
      .where(eq(bids.id, projectId))
      .limit(1);

    if (!bid || bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Get document and verify it belongs to this project
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.bidId, projectId)))
      .limit(1);

    if (!doc || !doc.storagePath) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Check if Python API is configured
    if (!pythonApi.isConfigured()) {
      return NextResponse.json(
        { error: 'Visual search service not configured' },
        { status: 503 }
      );
    }

    const storagePath = doc.storagePath;

    // Step 1: Crop region around click point
    // Use URL-based cropping for Blob URLs (memory efficient)
    // Fall back to base64 for local files
    let cropResult;
    try {
      if (isBlobUrl(storagePath)) {
        // Memory efficient: Python fetches PDF directly from Blob URL
        cropResult = await pythonApi.cropUrl({
          pdfUrl: storagePath,
          pageNum,
          x,
          y,
          width,
          height,
        });
      } else {
        // Local file: Read and send as base64
        let resolvedPath = storagePath;
        if (!path.isAbsolute(resolvedPath)) {
          resolvedPath = path.join(process.cwd(), resolvedPath);
        }
        if (!fs.existsSync(resolvedPath)) {
          return NextResponse.json({ error: 'PDF file not found' }, { status: 404 });
        }
        const pdfData = fs.readFileSync(resolvedPath);
        const pdfBase64 = pdfData.toString('base64');

        cropResult = await pythonApi.crop({
          pdfData: pdfBase64,
          pageNum,
          x,
          y,
          width,
          height,
        });
      }
    } catch (error) {
      console.error('Failed to crop region:', error);
      return NextResponse.json(
        { error: 'Failed to crop region' },
        { status: 500 }
      );
    }

    if (!cropResult.success || !cropResult.image) {
      return NextResponse.json(
        { error: cropResult.error || 'Failed to crop region' },
        { status: 500 }
      );
    }

    const croppedImage = cropResult.image;

    // Step 2: Try OCR on the cropped region
    let ocrText: string | undefined;
    let ocrConfidence: number | undefined;

    try {
      const ocrResult = await pythonApi.ocr({ image: croppedImage });
      if (ocrResult.success && ocrResult.text && ocrResult.text.trim()) {
        ocrText = ocrResult.text.trim();
        ocrConfidence = ocrResult.confidence;
      }
    } catch {
      // OCR failure is non-fatal, continue with visual search
    }

    // Prepare base response
    const response: VisualSearchResponse = {
      success: true,
      query: {
        documentId,
        pageNumber: pageNum,
        x,
        y,
        thumbnail: croppedImage,
        ocrText,
        ocrConfidence,
      },
      searchMethod: 'none',
      matches: [],
    };

    // Step 3: If text found, do text-based search
    if (ocrText && ocrConfidence && ocrConfidence > 0.5) {
      response.searchMethod = 'text';

      // Search for this text in all documents of the project
      const textMatches = await db.execute(sql`
        SELECT
          pt.document_id,
          d.filename as document_name,
          pt.page_number,
          ts_rank(pt.text_search, plainto_tsquery('english', ${ocrText})) as rank
        FROM page_text pt
        JOIN documents d ON d.id = pt.document_id
        WHERE d.bid_id = ${projectId}
          AND pt.text_search @@ plainto_tsquery('english', ${ocrText})
        ORDER BY rank DESC
        LIMIT 20
      `);

      response.matches = (textMatches.rows as any[]).map((row) => ({
        documentId: row.document_id,
        documentName: row.document_name,
        pageNumber: row.page_number,
        x: 0.5, // Center of page (we don't have exact position from FTS)
        y: 0.5,
        similarity: Math.min(1, parseFloat(row.rank) || 0),
        ocrText,
      }));

      // Save this region for future visual search
      await saveSymbolRegion({
        documentId,
        pageNumber: pageNum,
        x,
        y,
        width: width / 100, // Normalize
        height: height / 100,
        ocrText,
        ocrConfidence,
        source: 'user_click',
      });

      return NextResponse.json(response);
    }

    // Step 4: No text found, try visual search with CLIP
    response.searchMethod = 'visual';

    // Generate embedding for the clicked region
    let embedResult;
    try {
      embedResult = await pythonApi.embed({ image: croppedImage });
    } catch {
      // If embedding fails, still return success but with no matches
      response.searchMethod = 'none';
      return NextResponse.json(response);
    }

    if (!embedResult.success || !embedResult.embedding) {
      response.searchMethod = 'none';
      return NextResponse.json(response);
    }

    const embedding = embedResult.embedding;

    // Search for similar embeddings in the database
    // Using cosine similarity with pgvector
    const vectorMatches = await db.execute(sql`
      SELECT
        sr.document_id,
        d.filename as document_name,
        sr.page_number,
        sr.x,
        sr.y,
        sr.ocr_text,
        1 - (sr.embedding <=> ${JSON.stringify(embedding)}::vector) as similarity
      FROM symbol_regions sr
      JOIN documents d ON d.id = sr.document_id
      WHERE d.bid_id = ${projectId}
        AND sr.embedding IS NOT NULL
        AND sr.id != (
          SELECT id FROM symbol_regions
          WHERE document_id = ${documentId}
            AND page_number = ${pageNum}
            AND ABS(x - ${x}) < 0.05
            AND ABS(y - ${y}) < 0.05
          LIMIT 1
        )
      ORDER BY sr.embedding <=> ${JSON.stringify(embedding)}::vector
      LIMIT 20
    `);

    response.matches = (vectorMatches.rows as any[]).map((row) => ({
      documentId: row.document_id,
      documentName: row.document_name,
      pageNumber: row.page_number,
      x: row.x,
      y: row.y,
      similarity: parseFloat(row.similarity) || 0,
      ocrText: row.ocr_text,
    }));

    // Save this region with its embedding
    await saveSymbolRegion({
      documentId,
      pageNumber: pageNum,
      x,
      y,
      width: width / 100,
      height: height / 100,
      embedding,
      ocrText,
      ocrConfidence,
      source: 'user_click',
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error('Visual search error:', error);
    return NextResponse.json(
      { error: 'Visual search failed' },
      { status: 500 }
    );
  }
}

// Helper to save a symbol region
async function saveSymbolRegion(data: {
  documentId: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  embedding?: number[];
  ocrText?: string;
  ocrConfidence?: number;
  source: string;
}) {
  try {
    // Check if similar region already exists
    const existing = await db
      .select()
      .from(symbolRegions)
      .where(
        and(
          eq(symbolRegions.documentId, data.documentId),
          eq(symbolRegions.pageNumber, data.pageNumber),
          sql`ABS(${symbolRegions.x} - ${data.x}) < 0.05`,
          sql`ABS(${symbolRegions.y} - ${data.y}) < 0.05`
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing region
      await db
        .update(symbolRegions)
        .set({
          embedding: data.embedding,
          ocrText: data.ocrText,
          ocrConfidence: data.ocrConfidence,
        })
        .where(eq(symbolRegions.id, existing[0].id));
    } else {
      // Insert new region
      await db.insert(symbolRegions).values({
        documentId: data.documentId,
        pageNumber: data.pageNumber,
        x: data.x,
        y: data.y,
        width: data.width,
        height: data.height,
        embedding: data.embedding,
        ocrText: data.ocrText,
        ocrConfidence: data.ocrConfidence,
        source: data.source,
      });
    }
  } catch (error) {
    console.error('Failed to save symbol region:', error);
    // Don't throw - this is non-critical
  }
}
