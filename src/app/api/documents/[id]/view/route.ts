import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getFileInfo } from '@/lib/storage';
import { HeadObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

function getBareEndpoint(bucket: string, regionFallback: string): string {
  const raw = process.env.DO_SPACES_ENDPOINT || `https://${regionFallback}.digitaloceanspaces.com`;
  try {
    const u = new URL(raw);
    const parts = u.hostname.split('.');
    if (parts.length >= 3 && parts[0] === bucket) {
      u.hostname = parts.slice(1).join('.');
    }
    return u.origin;
  } catch {
    return raw;
  }
}

function getRegionFromEndpoint(endpoint: string, fallback: string): string {
  try {
    const u = new URL(endpoint);
    return u.hostname.split('.')[0] || fallback;
  } catch {
    return fallback;
  }
}

function getS3Client(): S3Client {
  const bucket = process.env.DO_SPACES_BUCKET || '';
  const regionFallback = process.env.DO_SPACES_REGION || 'nyc3';
  const endpoint = getBareEndpoint(bucket, regionFallback);
  const region = getRegionFromEndpoint(endpoint, regionFallback);

  return new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId: process.env.DO_SPACES_KEY || '',
      secretAccessKey: process.env.DO_SPACES_SECRET || '',
    },
    forcePathStyle: false,
  });
}

function extractKeyFromUrl(url: string): string {
  const u = new URL(url);
  return u.pathname.replace(/^\//, '');
}

function parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;

  const startStr = m[1];
  const endStr = m[2];

  // bytes=-500 (suffix)
  if (!startStr && endStr) {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  // bytes=0- / bytes=0-499
  const start = Number(startStr);
  const end = endStr ? Number(endStr) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  if (start >= size) return null;

  return { start, end: Math.min(end, size - 1) };
}

function webStreamFromNode(body: any): ReadableStream<Uint8Array> {
  // AWS SDK v3 returns a Node Readable in Node runtime.
  // Convert to Web ReadableStream without buffering the whole file.
  const r = body as unknown as Readable;
  // @ts-ignore
  return Readable.toWeb(r) as ReadableStream<Uint8Array>;
}

// GET /api/documents/[id]/view - Serve PDF file for viewing (supports Range for fast large-PDF navigation)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Get document and verify ownership through bid
    const [doc] = await db
      .select({
        document: documents,
        bid: bids,
      })
      .from(documents)
      .innerJoin(bids, eq(documents.bidId, bids.id))
      .where(eq(documents.id, id))
      .limit(1);

    if (!doc || doc.bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const storagePath = doc.document.storagePath;
    if (!storagePath) {
      return NextResponse.json({ error: 'Document file path not available' }, { status: 404 });
    }

    const filename = doc.document.filename || 'document.pdf';
    const rangeHeader = request.headers.get('range');

    // If it's a DO Spaces URL, serve through S3 SDK with Range + streaming.
    if (storagePath.startsWith('https://') && storagePath.includes('.digitaloceanspaces.com')) {
      const info = await getFileInfo(storagePath);
      const size = info.size || 0;

      if (!size) {
        return NextResponse.json({ error: 'Missing content length for document' }, { status: 500 });
      }

      const r = parseRange(rangeHeader, size);
      const bucket = process.env.DO_SPACES_BUCKET || '';
      const key = extractKeyFromUrl(storagePath);

      const s3 = getS3Client();
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: r ? `bytes=${r.start}-${r.end}` : undefined,
      });
      const obj = await s3.send(cmd);

      if (!obj.Body) {
        return NextResponse.json({ error: 'Empty response body from storage' }, { status: 500 });
      }

      const start = r?.start ?? 0;
      const end = r?.end ?? (size - 1);
      const contentLength = (end - start + 1);

      const headers: Record<string, string> = {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      };

      if (r) {
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        headers['Content-Length'] = String(contentLength);
        return new NextResponse(webStreamFromNode(obj.Body), { status: 206, headers });
      }

      headers['Content-Length'] = String(size);
      return new NextResponse(webStreamFromNode(obj.Body), { status: 200, headers });
    }

    // Fallback: proxy via fetch (attempt to preserve Range).
    if (storagePath.startsWith('https://')) {
      const upstream = await fetch(storagePath, {
        headers: rangeHeader ? { range: rangeHeader } : undefined,
      });

      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: 'Failed to retrieve document' }, { status: 502 });
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
        'Cache-Control': 'private, max-age=3600',
      };

      const contentRange = upstream.headers.get('content-range');
      const contentLength = upstream.headers.get('content-length');
      if (contentRange) headers['Content-Range'] = contentRange;
      if (contentLength) headers['Content-Length'] = contentLength;

      const status = upstream.status === 206 ? 206 : 200;
      return new NextResponse(upstream.body, { status, headers });
    }

    return NextResponse.json({ error: 'Unsupported storage path' }, { status: 400 });
  } catch (error) {
    console.error('Document view error:', error);
    return NextResponse.json({ error: 'Failed to retrieve document' }, { status: 500 });
  }
}
