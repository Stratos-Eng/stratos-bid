import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffSheets, takeoffProjects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';

// Schema for calibration data
const calibrationSchema = z.object({
  pixelLength: z.number().positive('Pixel length must be positive'),
  realLength: z.number().positive('Real length must be positive'),
  unit: z.enum(['ft', 'm']),
  pixelsPerUnit: z.number().positive('Pixels per unit must be positive'),
});

const updateSheetSchema = z.object({
  calibration: calibrationSchema.nullable().optional(),
  name: z.string().min(1).max(200).optional(),
});

// GET /api/takeoff/sheets/[sheetId] - Get sheet details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sheetId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { sheetId } = await params;

    // Get sheet with project ownership verification
    const [sheet] = await db
      .select({
        sheet: takeoffSheets,
        projectUserId: takeoffProjects.userId,
      })
      .from(takeoffSheets)
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .where(eq(takeoffSheets.id, sheetId))
      .limit(1);

    if (!sheet) {
      return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
    }

    if (sheet.projectUserId !== session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    return NextResponse.json({ sheet: sheet.sheet });
  } catch (error) {
    console.error('Get sheet error:', error);
    return NextResponse.json(
      { error: 'Failed to get sheet' },
      { status: 500 }
    );
  }
}

// PATCH /api/takeoff/sheets/[sheetId] - Update sheet (including calibration)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sheetId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { sheetId } = await params;
    const body = await request.json();

    // Validate input
    const validation = updateSheetSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') },
        { status: 400 }
      );
    }

    const { calibration, name } = validation.data;

    // Verify ownership
    const [sheet] = await db
      .select({
        sheet: takeoffSheets,
        projectUserId: takeoffProjects.userId,
      })
      .from(takeoffSheets)
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .where(eq(takeoffSheets.id, sheetId))
      .limit(1);

    if (!sheet) {
      return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
    }

    if (sheet.projectUserId !== session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Build update object
    const updateData: Partial<typeof takeoffSheets.$inferInsert> = {};

    if (calibration !== undefined) {
      updateData.calibration = calibration;
      // Also set the legacy scaleValue for backwards compatibility
      if (calibration) {
        updateData.scaleValue = calibration.pixelsPerUnit;
        updateData.scaleSource = 'manual';
        updateData.scaleConfidence = 1.0;
      }
    }

    if (name !== undefined) {
      updateData.name = name;
    }

    // Update the sheet
    const [updatedSheet] = await db
      .update(takeoffSheets)
      .set(updateData)
      .where(eq(takeoffSheets.id, sheetId))
      .returning();

    return NextResponse.json({ sheet: updatedSheet });
  } catch (error) {
    console.error('Update sheet error:', error);
    return NextResponse.json(
      { error: 'Failed to update sheet' },
      { status: 500 }
    );
  }
}
