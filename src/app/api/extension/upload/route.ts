import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bids, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const userId = await verifyExtensionToken(token);

  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
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

    // Save file to disk
    const docsDir = join(process.cwd(), 'docs', platform, bidId);
    await mkdir(docsDir, { recursive: true });

    const filePath = join(docsDir, file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    // Create document record
    const [doc] = await db
      .insert(documents)
      .values({
        bidId: bid.id,
        filename: file.name,
        docType: classifyDocType(file.name),
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

function classifyDocType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('plan') || lower.includes('drawing')) return 'plans';
  if (lower.includes('spec')) return 'specs';
  if (lower.includes('addend')) return 'addendum';
  return 'other';
}

async function verifyExtensionToken(token: string): Promise<string | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]));

    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null;
    }

    return payload.userId;
  } catch {
    return null;
  }
}
