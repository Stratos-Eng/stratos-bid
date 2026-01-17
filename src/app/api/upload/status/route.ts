import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { uploadSessions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

// GET /api/upload/status - Get upload session status (for reconnection)
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const uploadId = request.nextUrl.searchParams.get('uploadId');

    if (!uploadId) {
      return NextResponse.json({ error: 'Missing uploadId' }, { status: 400 });
    }

    // Get upload session
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
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: uploadSession.id,
      filename: uploadSession.filename,
      fileSize: uploadSession.fileSize,
      status: uploadSession.status,
      receivedChunks: uploadSession.receivedChunks,
      totalChunks: uploadSession.totalChunks,
      chunkSize: uploadSession.chunkSize,
      progress: uploadSession.totalChunks > 0
        ? (uploadSession.receivedChunks / uploadSession.totalChunks) * 100
        : 0,
      errorMessage: uploadSession.errorMessage,
      expiresAt: uploadSession.expiresAt,
      createdAt: uploadSession.createdAt,
    });
  } catch (error) {
    console.error('Status check error:', error);
    return NextResponse.json(
      { error: 'Failed to get upload status' },
      { status: 500 }
    );
  }
}
