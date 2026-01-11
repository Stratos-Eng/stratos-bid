import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bids, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { verifyExtensionToken } from '@/lib/extension-auth';
import { rateLimiters, getRateLimitHeaders } from '@/lib/rate-limit';

// Security constants
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB max
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.dwg', '.dxf', '.zip', '.rar'];
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/acad',
  'application/x-autocad',
  'application/zip',
  'application/x-rar-compressed',
  'application/octet-stream', // Some browsers send this for unknown types
];

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const userId = verifyExtensionToken(token);

  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  // Rate limiting
  const rateLimitResult = rateLimiters.extensionUpload(userId);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const bidId = formData.get('bidId') as string;
    const platform = formData.get('platform') as string;

    if (!file || !bidId || !platform) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // === Security validations ===

    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 413 }
      );
    }

    // Validate file extension
    const filename = file.name.toLowerCase();
    const ext = filename.substring(filename.lastIndexOf('.'));
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate MIME type (if provided)
    if (file.type && !ALLOWED_MIME_TYPES.includes(file.type)) {
      console.warn(`Suspicious MIME type: ${file.type} for file: ${file.name}`);
      // We log but don't reject - some browsers report incorrect MIME types
    }

    // Sanitize filename to prevent path traversal
    const sanitizedFilename = sanitizeFilename(file.name);
    if (!sanitizedFilename) {
      return NextResponse.json(
        { error: 'Invalid filename' },
        { status: 400 }
      );
    }

    // Sanitize bidId and platform to prevent path traversal
    const sanitizedBidId = bidId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sanitizedPlatform = platform.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Find the bid
    const bid = await db
      .select()
      .from(bids)
      .where(
        and(
          eq(bids.userId, userId),
          eq(bids.sourcePlatform, platform),
          eq(bids.sourceBidId, bidId)
        )
      )
      .limit(1)
      .then(rows => rows[0]);

    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }

    // Save file to disk with sanitized paths
    const docsDir = join(process.cwd(), 'docs', sanitizedPlatform, sanitizedBidId);
    await mkdir(docsDir, { recursive: true });

    const filePath = join(docsDir, sanitizedFilename);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    // Create document record
    const [doc] = await db
      .insert(documents)
      .values({
        bidId: bid.id,
        filename: sanitizedFilename,
        docType: classifyDocType(sanitizedFilename),
        storagePath: filePath,
        downloadedAt: new Date(),
      })
      .returning();

    return NextResponse.json({
      success: true,
      documentId: doc.id,
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Sanitize filename to prevent path traversal and other attacks
 */
function sanitizeFilename(filename: string): string | null {
  if (!filename) return null;

  // Remove path components
  let sanitized = filename.replace(/^.*[\\\/]/, '');

  // Remove null bytes and control characters
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

  // Remove potentially dangerous characters
  sanitized = sanitized.replace(/[<>:"|?*]/g, '_');

  // Limit length
  if (sanitized.length > 255) {
    const ext = sanitized.substring(sanitized.lastIndexOf('.'));
    sanitized = sanitized.substring(0, 255 - ext.length) + ext;
  }

  // Must have a name
  if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
    return null;
  }

  return sanitized;
}

function classifyDocType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('plan') || lower.includes('drawing')) return 'plans';
  if (lower.includes('spec')) return 'specs';
  if (lower.includes('addend')) return 'addendum';
  return 'other';
}

