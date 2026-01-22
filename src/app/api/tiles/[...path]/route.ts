/**
 * Tile API Route
 *
 * Serves tiles from Vercel Blob storage, generating on-demand for higher zoom levels.
 *
 * Path format: /api/tiles/{sheetId}/{z}/{x}/{y}.webp
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffSheets, takeoffProjects, documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { tileExistsInBlob, generateSingleTile, MAX_ZOOM } from '@/lib/tile-generator';

// Validate UUID format
function validateUUID(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // Path format: [sheetId, z, x, y.webp]
  if (path.length !== 4) {
    return NextResponse.json({ error: 'Invalid path format' }, { status: 400 });
  }

  const [sheetId, zStr, xStr, yFile] = path;

  // Validate sheetId
  if (!validateUUID(sheetId)) {
    return NextResponse.json({ error: 'Invalid sheetId' }, { status: 400 });
  }

  // Parse coordinates
  const z = parseInt(zStr, 10);
  const x = parseInt(xStr, 10);
  const y = parseInt(yFile.replace('.webp', ''), 10);

  if (isNaN(z) || isNaN(x) || isNaN(y)) {
    return NextResponse.json({ error: 'Invalid tile coordinates' }, { status: 400 });
  }

  // Validate zoom level
  if (z < 0 || z > MAX_ZOOM) {
    return NextResponse.json({ error: `Zoom level must be 0-${MAX_ZOOM}` }, { status: 400 });
  }

  // Validate tile coordinates for zoom level
  const maxCoord = Math.pow(2, z) - 1;
  if (x < 0 || x > maxCoord || y < 0 || y > maxCoord) {
    return NextResponse.json({ error: 'Tile coordinates out of range' }, { status: 400 });
  }

  // Check if tile exists in Blob
  const existingUrl = await tileExistsInBlob(sheetId, z, x, y);
  if (existingUrl) {
    // Redirect to Blob URL
    return NextResponse.redirect(existingUrl, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // Tile doesn't exist - need to generate on-demand
  // First verify auth and get sheet info
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get sheet and verify ownership
  const [sheet] = await db
    .select({
      sheet: takeoffSheets,
      project: takeoffProjects,
      document: documents,
    })
    .from(takeoffSheets)
    .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
    .leftJoin(documents, eq(takeoffSheets.documentId, documents.id))
    .where(eq(takeoffSheets.id, sheetId))
    .limit(1);

  if (!sheet || sheet.project.userId !== session.user.id) {
    return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
  }

  // Get storage path from document
  const storagePath = sheet.document?.storagePath;
  if (!storagePath) {
    return NextResponse.json({ error: 'Document has no storage path' }, { status: 404 });
  }

  // Check if single-page PDFs are available (page-level architecture)
  // If pagesReady is true, use the pre-split single-page PDF for memory efficiency
  const pagesReady = sheet.document?.pagesReady ?? false;
  const documentId = sheet.document?.id;

  try {
    let effectiveStoragePath = storagePath;
    let effectivePageNum = sheet.sheet.pageNumber;

    if (pagesReady && documentId) {
      // Use single-page PDF URL instead of full document
      // Single-page PDFs are stored at: pages/{documentId}/{pageNumber}.pdf
      // Extract base URL from original storage path
      const baseUrl = new URL(storagePath);
      baseUrl.pathname = `/pages/${documentId}/${sheet.sheet.pageNumber}.pdf`;
      effectiveStoragePath = baseUrl.toString();
      effectivePageNum = 1; // Single-page PDF, always page 1
    }

    // Generate tile on-demand
    const tileUrl = await generateSingleTile(
      sheetId,
      effectiveStoragePath,
      effectivePageNum,
      z,
      x,
      y
    );

    if (!tileUrl) {
      return NextResponse.json({ error: 'Failed to generate tile' }, { status: 500 });
    }

    // Redirect to newly created tile
    return NextResponse.redirect(tileUrl, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('Tile generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate tile' },
      { status: 500 }
    );
  }
}
