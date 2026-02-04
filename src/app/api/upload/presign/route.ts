import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getPresignedUploadUrl } from '@/lib/storage';

// POST /api/upload/presign - Generate presigned URL for client-side upload
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { filename, bidId } = await request.json();

    if (!filename || !bidId) {
      return NextResponse.json(
        { error: 'Missing required fields: filename, bidId' },
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

    // Build storage key
    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `projects/${bidId}/${timestamp}-${sanitizedFilename}`;

    const presigned = await getPresignedUploadUrl(key, 'application/pdf');

    return NextResponse.json({
      uploadUrl: presigned.url,
      key: presigned.key,
      publicUrl: presigned.publicUrl,
    });
  } catch (error) {
    console.error('[upload/presign] Error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to generate upload URL',
      },
      { status: 500 }
    );
  }
}
