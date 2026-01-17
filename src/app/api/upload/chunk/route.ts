import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { uploadSessions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { writeFile, readdir } from 'fs/promises';
import { join } from 'path';

// Parse Content-Range header: "bytes start-end/total"
function parseContentRange(header: string | null): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const match = header.match(/bytes (\d+)-(\d+)\/(\d+)/);
  if (!match) return null;
  return {
    start: parseInt(match[1], 10),
    end: parseInt(match[2], 10),
    total: parseInt(match[3], 10),
  };
}

// PUT /api/upload/chunk - Receive a single chunk
export async function PUT(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const uploadId = request.nextUrl.searchParams.get('uploadId');
    const contentRange = parseContentRange(request.headers.get('content-range'));

    if (!uploadId) {
      return NextResponse.json({ error: 'Missing uploadId' }, { status: 400 });
    }

    if (!contentRange) {
      return NextResponse.json({ error: 'Missing or invalid Content-Range header' }, { status: 400 });
    }

    // Verify upload session ownership
    const [uploadSession] = await db
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, uploadId),
          eq(uploadSessions.userId, session.user.id)
        )
      )
      .limit(1);

    if (!uploadSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    // Check if already finalized
    if (uploadSession.status === 'completed' || uploadSession.status === 'failed') {
      return NextResponse.json({ error: 'Upload already finalized' }, { status: 400 });
    }

    // Check expiration
    if (new Date() > uploadSession.expiresAt) {
      // Mark as expired
      await db
        .update(uploadSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(uploadSessions.id, uploadId));

      return NextResponse.json({ error: 'Upload session expired' }, { status: 410 });
    }

    // Read chunk data from request body
    const chunk = await request.arrayBuffer();

    // Calculate chunk index from byte range (use start byte position for ordering)
    const chunkIndex = Math.floor(contentRange.start / uploadSession.chunkSize);

    // Write chunk to temp directory with zero-padded index for proper ordering
    const chunkFilename = `chunk-${chunkIndex.toString().padStart(6, '0')}`;
    const chunkPath = join(uploadSession.tempDir, chunkFilename);
    await writeFile(chunkPath, Buffer.from(chunk));

    // Count received chunks
    const files = await readdir(uploadSession.tempDir);
    const receivedChunks = files.filter((f) => f.startsWith('chunk-')).length;

    // Update session
    await db
      .update(uploadSessions)
      .set({
        receivedChunks,
        status: 'uploading',
        updatedAt: new Date(),
      })
      .where(eq(uploadSessions.id, uploadId));

    return NextResponse.json({
      received: receivedChunks,
      total: uploadSession.totalChunks,
      complete: receivedChunks === uploadSession.totalChunks,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    return NextResponse.json(
      { error: 'Failed to save chunk' },
      { status: 500 }
    );
  }
}
