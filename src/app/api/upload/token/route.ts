import { NextRequest, NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects, bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

// Force Node.js runtime
export const runtime = 'nodejs';

// POST /api/upload/token - Handle Vercel Blob client upload
export async function POST(request: NextRequest) {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Authenticate user
        const session = await auth();
        if (!session?.user?.id) {
          throw new Error('Unauthorized');
        }

        // Extract project/bid ID from pathname
        // Expected format: takeoff/{projectId}/{filename} or projects/{bidId}/{filename}
        const parts = pathname.split('/');
        const uploadType = parts[0]; // 'takeoff' or 'projects'
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
            throw new Error('Project not found or access denied');
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
            throw new Error('Project not found or access denied');
          }
        }

        // Only allow PDFs
        return {
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: 500 * 1024 * 1024, // 500MB
          tokenPayload: JSON.stringify({
            userId: session.user.id,
            uploadType,
            resourceId,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // This is called by Vercel after upload completes
        // We don't process here - the client will call /api/upload/blob-complete
        console.log('[upload/token] Upload completed:', {
          url: blob.url,
          pathname: blob.pathname,
          tokenPayload,
        });
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    console.error('[upload/token] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 400 }
    );
  }
}
