import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { lineItems } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { TradeCode } from '@/lib/trade-definitions';

// GET /api/line-items - List line items with filters
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const bidId = searchParams.get('bidId');
    const documentId = searchParams.get('documentId');
    const tradeCode = searchParams.get('tradeCode') as TradeCode | null;
    const reviewStatus = searchParams.get('reviewStatus');

    // Build query conditions
    const conditions = [eq(lineItems.userId, session.user.id)];

    if (bidId) {
      conditions.push(eq(lineItems.bidId, bidId));
    }
    if (documentId) {
      conditions.push(eq(lineItems.documentId, documentId));
    }
    if (tradeCode) {
      conditions.push(eq(lineItems.tradeCode, tradeCode));
    }
    if (reviewStatus) {
      conditions.push(eq(lineItems.reviewStatus, reviewStatus));
    }

    const items = await db
      .select()
      .from(lineItems)
      .where(and(...conditions))
      .orderBy(lineItems.pageNumber, lineItems.category);

    return NextResponse.json({ items });
  } catch (error) {
    console.error('Line items GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PATCH /api/line-items - Update a line item
export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Verify ownership
    const [existing] = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.id, id))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    if (existing.userId !== session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Build update object with allowed fields
    const allowedUpdates: Partial<typeof lineItems.$inferInsert> = {};

    if (updates.category !== undefined) allowedUpdates.category = updates.category;
    if (updates.description !== undefined) allowedUpdates.description = updates.description;
    if (updates.estimatedQty !== undefined) allowedUpdates.estimatedQty = updates.estimatedQty;
    if (updates.unit !== undefined) allowedUpdates.unit = updates.unit;
    if (updates.notes !== undefined) allowedUpdates.notes = updates.notes;
    if (updates.reviewStatus !== undefined) {
      allowedUpdates.reviewStatus = updates.reviewStatus;
      if (updates.reviewStatus !== 'pending') {
        allowedUpdates.reviewedAt = new Date();
        allowedUpdates.reviewedBy = session.user.id;
      }
    }

    allowedUpdates.updatedAt = new Date();

    const [updated] = await db
      .update(lineItems)
      .set(allowedUpdates)
      .where(eq(lineItems.id, id))
      .returning();

    return NextResponse.json({ item: updated });
  } catch (error) {
    console.error('Line items PATCH error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/line-items - Delete a line item
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Verify ownership
    const [existing] = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.id, id))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    if (existing.userId !== session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    await db.delete(lineItems).where(eq(lineItems.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Line items DELETE error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
