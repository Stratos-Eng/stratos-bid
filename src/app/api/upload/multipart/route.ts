import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects, bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

// Force Node.js runtime for file handling
export const runtime = 'nodejs';

// Increase body size limit and timeout for large files
export const maxDuration = 300; // 5 minutes

// POST /api/upload/multipart - Handle large file uploads server-side
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const pathname = formData.get('pathname') as string | null;

    if (!file || !pathname) {
      return NextResponse.json(
        { error: 'Missing required fields: file, pathname' },
        { status: 400 }
      );
    }

    // Extract project/bid ID from pathname for authorization
    // Expected format: takeoff/{projectId}/{filename} or projects/{bidId}/{filename}
    const parts = pathname.split('/');
    const uploadType = parts[0];
    const resourceId = parts[1];

    // Validate ownership
    if (uploadType === 'takeoff' && resourceId) {
      const [project] = await db
        .select()
        .from(takeoffProjects)
        .where(
          and(
            eq(takeoffProjects.id, resourceId),
            eq(takeoffProjects.userId, session.user.id)
          )
        )
        .limit(1);

      if (!project) {
        return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
      }
    } else if (uploadType === 'projects' && resourceId) {
      const [bid] = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.id, resourceId),
            eq(bids.userId, session.user.id)
          )
        )
        .limit(1);

      if (!bid) {
        return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid pathname format' }, { status: 400 });
    }

    // Validate file type
    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Only PDF files are allowed' }, { status: 400 });
    }

    // Validate file size (500MB max)
    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `File too large. Maximum size is 500MB, got ${(file.size / 1024 / 1024).toFixed(1)}MB` },
        { status: 400 }
      );
    }

    console.log(`[multipart] Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    // Upload using Vercel Blob's server-side multipart upload
    // This is more reliable for large files as it handles chunking internally
    const blob = await put(pathname, file, {
      access: 'public',
      multipart: true, // Enable multipart upload for large files
    });

    console.log(`[multipart] Upload complete: ${blob.url}`);

    return NextResponse.json({
      success: true,
      url: blob.url,
      pathname: blob.pathname,
    });
  } catch (error) {
    console.error('[multipart] Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
