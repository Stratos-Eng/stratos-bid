import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bids, connections } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

interface ExtractedBid {
  sourceBidId: string;
  title: string;
  description?: string;
  projectAddress?: string;
  city?: string;
  state?: string;
  bidDueDate?: string;
  postedDate?: string;
  sourceUrl: string;
  documents: { filename: string; docType?: string }[];
}

interface SyncRequest {
  platform: string;
  portalId?: string;
  bids: ExtractedBid[];
}

export async function POST(req: NextRequest) {
  // Verify auth token from extension
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
    const body: SyncRequest = await req.json();
    const { platform, portalId, bids: extractedBids } = body;

    // Find or create connection
    let connection = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.userId, userId),
          eq(connections.platform, platform)
        )
      )
      .limit(1)
      .then(rows => rows[0]);

    if (!connection) {
      const [newConn] = await db
        .insert(connections)
        .values({
          userId,
          platform,
          authType: 'extension',
          status: 'active',
        })
        .returning();
      connection = newConn;
    }

    // Upsert bids
    let inserted = 0;
    let updated = 0;

    for (const bid of extractedBids) {
      const existing = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.userId, userId),
            eq(bids.sourcePlatform, platform),
            eq(bids.sourceBidId, bid.sourceBidId)
          )
        )
        .limit(1)
        .then(rows => rows[0]);

      if (existing) {
        await db
          .update(bids)
          .set({
            title: bid.title,
            description: bid.description,
            projectAddress: bid.projectAddress,
            city: bid.city,
            state: bid.state,
            bidDueDate: bid.bidDueDate ? new Date(bid.bidDueDate) : null,
            postedDate: bid.postedDate ? new Date(bid.postedDate) : null,
            sourceUrl: bid.sourceUrl,
            updatedAt: new Date(),
          })
          .where(eq(bids.id, existing.id));
        updated++;
      } else {
        await db
          .insert(bids)
          .values({
            userId,
            connectionId: connection.id,
            sourcePlatform: platform,
            sourceBidId: bid.sourceBidId,
            title: bid.title,
            description: bid.description,
            projectAddress: bid.projectAddress,
            city: bid.city,
            state: bid.state,
            bidDueDate: bid.bidDueDate ? new Date(bid.bidDueDate) : null,
            postedDate: bid.postedDate ? new Date(bid.postedDate) : null,
            sourceUrl: bid.sourceUrl,
          });
        inserted++;
      }
    }

    // Update connection last synced
    await db
      .update(connections)
      .set({ lastSynced: new Date(), status: 'active' })
      .where(eq(connections.id, connection.id));

    return NextResponse.json({
      success: true,
      inserted,
      updated,
      total: extractedBids.length,
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Extension sync error:', error);
    return NextResponse.json(
      { error: 'Sync failed', details: errorMessage },
      { status: 500 }
    );
  }
}

async function verifyExtensionToken(token: string): Promise<string | null> {
  // Simple JWT-like token verification
  // In production, use proper JWT verification with jsonwebtoken
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]));

    // Check expiration
    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null;
    }

    return payload.userId;
  } catch {
    return null;
  }
}
