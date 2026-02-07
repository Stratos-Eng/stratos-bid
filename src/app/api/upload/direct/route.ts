import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { uploadFileStream } from '@/lib/storage';
import Busboy from 'busboy';
import { Readable, PassThrough } from 'node:stream';

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

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
    }

    if (!request.body) {
      return NextResponse.json({ error: 'Missing request body' }, { status: 400 });
    }

    // Stream-parse multipart using busboy (NextRequest.formData() can fail on some platforms/large bodies)
    const bb = Busboy({ headers: { 'content-type': contentType } });

    let bidId = '';
    let filename = '';
    let bidValidated = false;

    const finish = new Promise<NextResponse>((resolve, reject) => {
      let fileHandled = false;

      bb.on('field', async (name, val) => {
        if (name === 'bidId') bidId = String(val || '');
        if (name === 'filename') filename = String(val || '');

        // Validate bid ownership as soon as we have bidId.
        if (name === 'bidId' && bidId && !bidValidated) {
          try {
            const [bid] = await db
              .select()
              .from(bids)
              .where(and(eq(bids.id, bidId), eq(bids.userId, session.user.id)))
              .limit(1);

            if (!bid) {
              reject(new Error('Project not found or access denied'));
              return;
            }

            bidValidated = true;
          } catch (e) {
            reject(e);
          }
        }
      });

      bb.on('file', async (_name, file, info) => {
        try {
          fileHandled = true;

          if (!bidId) throw new Error('Missing required field: bidId');
          if (!bidValidated) {
            // In practice bidId arrives before file (we append it first in FormData).
            throw new Error('Upload not authorized (bid not validated)');
          }

          const effectiveName = filename || info.filename || 'upload.pdf';
          const timestamp = Date.now();
          const sanitizedFilename = String(effectiveName).replace(/[^a-zA-Z0-9.-]/g, '_');
          const key = `projects/${bidId}/${timestamp}-${sanitizedFilename}`;

          // Stream to Spaces. Use PassThrough so we can hand a clean stream to the SDK.
          const pass = new PassThrough();
          file.pipe(pass);

          const uploaded = await uploadFileStream(pass, key, {
            contentType: info.mimeType || 'application/pdf',
          });

          resolve(
            NextResponse.json({
              url: uploaded.url,
              pathname: uploaded.pathname,
            })
          );
        } catch (e) {
          reject(e);
        }
      });

      bb.on('error', (err) => reject(err));

      bb.on('finish', () => {
        if (!fileHandled) {
          reject(new Error('Missing required field: file'));
        }
      });
    });

    // Pipe web stream -> node stream -> busboy
    Readable.fromWeb(request.body as any).pipe(bb);

    return await finish;
  } catch (error) {
    const msg =
      error instanceof Error
        ? error.message
        : 'Failed to upload file';

    console.error('[upload/direct] Error:', error);

    // Preserve previous contract: return JSON error body
    // so the client can display something meaningful.
    const status = msg.includes('access denied') ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
