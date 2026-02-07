import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { uploadFileStream } from '@/lib/storage';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';

/**
 * POST /api/upload/direct
 *
 * Server-side upload to DigitalOcean Spaces.
 *
 * This exists as a fallback when browser->Spaces direct PUT uploads fail due to CORS.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const form = await request.formData();
    const bidId = String(form.get('bidId') || '');
    const file = form.get('file');

    if (!bidId || !file || typeof file === 'string') {
      return NextResponse.json(
        { error: 'Missing required fields: bidId, file' },
        { status: 400 }
      );
    }

    // Validate bid ownership
    const [bid] = await db
      .select()
      .from(bids)
      .where(and(eq(bids.id, bidId), eq(bids.userId, session.user.id)))
      .limit(1);

    if (!bid) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 403 }
      );
    }

    const filename = String(form.get('filename') || (file as File).name || 'upload.pdf');

    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `projects/${bidId}/${timestamp}-${sanitizedFilename}`;

    const f = file as File;

    // Stream to Spaces to avoid buffering large PDFs in memory.
    // Note: AWS SDK expects a Node.js stream; convert from Web ReadableStream.
    const body = Readable.fromWeb(f.stream() as any);

    const uploaded = await uploadFileStream(body, key, {
      contentType: f.type || 'application/pdf',
      contentLength: f.size,
    });

    return NextResponse.json({
      url: uploaded.url,
      pathname: uploaded.pathname,
    });
  } catch (error) {
    console.error('[upload/direct] Error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to upload file',
      },
      { status: 500 }
    );
  }
}
