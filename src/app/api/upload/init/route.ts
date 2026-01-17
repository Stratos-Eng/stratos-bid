import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { uploadSessions, takeoffProjects, bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Default chunk size: 5MB (good balance for PDF uploads)
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

// POST /api/upload/init - Initialize a chunked upload session
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      filename,
      fileSize,
      mimeType,
      projectId,
      bidId, // For projects flow (uses bids table)
      chunkSize = DEFAULT_CHUNK_SIZE,
      folderName,
      relativePath,
    } = body;

    // Validate required fields
    if (!filename || !fileSize || !mimeType) {
      return NextResponse.json(
        { error: 'Missing required fields: filename, fileSize, mimeType' },
        { status: 400 }
      );
    }

    // Only allow PDFs
    if (mimeType !== 'application/pdf' && !filename.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json(
        { error: 'Only PDF files are allowed' },
        { status: 400 }
      );
    }

    // Validate project ownership if projectId provided (takeoff flow)
    if (projectId) {
      const [project] = await db
        .select()
        .from(takeoffProjects)
        .where(
          and(
            eq(takeoffProjects.id, projectId),
            eq(takeoffProjects.userId, session.user.id)
          )
        )
        .limit(1);

      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
    }

    // Validate bid ownership if bidId provided (projects flow)
    if (bidId) {
      const [bid] = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.id, bidId),
            eq(bids.userId, session.user.id)
          )
        )
        .limit(1);

      if (!bid) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
    }

    // Calculate total chunks
    const totalChunks = Math.ceil(fileSize / chunkSize);

    // Create temp directory for chunks
    const uploadId = randomUUID();
    const tempDir = join(process.cwd(), 'uploads', 'temp', uploadId);
    await mkdir(tempDir, { recursive: true });

    // Set expiration (24 hours from now)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Create upload session record
    const [uploadSession] = await db
      .insert(uploadSessions)
      .values({
        id: uploadId,
        userId: session.user.id,
        projectId: projectId || null,
        bidId: bidId || null, // For projects flow
        filename,
        fileSize,
        mimeType,
        chunkSize,
        totalChunks,
        tempDir,
        folderName: folderName || null,
        relativePath: relativePath || null,
        expiresAt,
      })
      .returning();

    return NextResponse.json({
      uploadId: uploadSession.id,
      chunkSize,
      totalChunks,
      endpoint: `/api/upload/chunk?uploadId=${uploadSession.id}`,
    });
  } catch (error) {
    console.error('Upload init error:', error);
    return NextResponse.json(
      { error: 'Failed to initialize upload' },
      { status: 500 }
    );
  }
}
