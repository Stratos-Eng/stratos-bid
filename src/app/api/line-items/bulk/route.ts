import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { lineItems } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

// POST /api/line-items/bulk - Bulk update line items
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { ids, action, reviewStatus } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array is required' }, { status: 400 });
    }

    if (!action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    // Verify ownership of all items
    const existingItems = await db
      .select()
      .from(lineItems)
      .where(
        and(
          inArray(lineItems.id, ids),
          eq(lineItems.userId, session.user.id)
        )
      );

    if (existingItems.length !== ids.length) {
      return NextResponse.json(
        { error: 'Some items not found or unauthorized' },
        { status: 403 }
      );
    }

    let updatedCount = 0;

    switch (action) {
      case 'approve':
        await db
          .update(lineItems)
          .set({
            reviewStatus: 'approved',
            reviewedAt: new Date(),
            reviewedBy: session.user.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(lineItems.id, ids),
              eq(lineItems.userId, session.user.id)
            )
          );
        updatedCount = ids.length;
        break;

      case 'reject':
        await db
          .update(lineItems)
          .set({
            reviewStatus: 'rejected',
            reviewedAt: new Date(),
            reviewedBy: session.user.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(lineItems.id, ids),
              eq(lineItems.userId, session.user.id)
            )
          );
        updatedCount = ids.length;
        break;

      case 'reset':
        await db
          .update(lineItems)
          .set({
            reviewStatus: 'pending',
            reviewedAt: null,
            reviewedBy: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(lineItems.id, ids),
              eq(lineItems.userId, session.user.id)
            )
          );
        updatedCount = ids.length;
        break;

      case 'delete':
        await db
          .delete(lineItems)
          .where(
            and(
              inArray(lineItems.id, ids),
              eq(lineItems.userId, session.user.id)
            )
          );
        updatedCount = ids.length;
        break;

      case 'set_status':
        if (!reviewStatus) {
          return NextResponse.json(
            { error: 'reviewStatus is required for set_status action' },
            { status: 400 }
          );
        }
        await db
          .update(lineItems)
          .set({
            reviewStatus,
            reviewedAt: reviewStatus !== 'pending' ? new Date() : null,
            reviewedBy: reviewStatus !== 'pending' ? session.user.id : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(lineItems.id, ids),
              eq(lineItems.userId, session.user.id)
            )
          );
        updatedCount = ids.length;
        break;

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: true,
      action,
      updatedCount,
    });
  } catch (error) {
    console.error('Bulk line items error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
