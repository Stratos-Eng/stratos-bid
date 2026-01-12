import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffMeasurements, takeoffSheets, takeoffProjects } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import {
  createMeasurementSchema,
  updateMeasurementSchema,
  getMeasurementsSchema,
  formatZodError,
} from '@/lib/validations/takeoff';
import { z } from 'zod';

// GET /api/takeoff/measurements - Get measurements for a sheet or project
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const params = {
      sheetId: searchParams.get('sheetId') || undefined,
      projectId: searchParams.get('projectId') || undefined,
    };

    // Validate query params
    const validation = getMeasurementsSchema.safeParse(params);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { sheetId, projectId } = validation.data;
    type Measurement = typeof takeoffMeasurements.$inferSelect;
    let measurements: Measurement[] = [];

    if (sheetId) {
      // Verify sheet ownership through project
      const [sheet] = await db
        .select({
          sheet: takeoffSheets,
          project: takeoffProjects,
        })
        .from(takeoffSheets)
        .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
        .where(eq(takeoffSheets.id, sheetId))
        .limit(1);

      if (!sheet || sheet.project.userId !== session.user.id) {
        return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
      }

      measurements = await db
        .select()
        .from(takeoffMeasurements)
        .where(eq(takeoffMeasurements.sheetId, sheetId));
    } else if (projectId) {
      // Verify project ownership
      const [project] = await db
        .select()
        .from(takeoffProjects)
        .where(
          and(
            eq(takeoffProjects.id, projectId),
            eq(takeoffProjects.userId, session.user.id)
          )
        )
        .limit(1);

      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }

      // Get all sheets for project
      const sheets = await db
        .select({ id: takeoffSheets.id })
        .from(takeoffSheets)
        .where(eq(takeoffSheets.projectId, projectId));

      const sheetIds = sheets.map((s) => s.id);

      if (sheetIds.length > 0) {
        // Get all measurements for all sheets in one query
        measurements = await db
          .select()
          .from(takeoffMeasurements)
          .where(inArray(takeoffMeasurements.sheetId, sheetIds));
      }
    }

    // Return measurements with persisted type/unit/label
    const formatted = measurements.map((m) => ({
      id: m.id,
      sheetId: m.sheetId,
      categoryId: m.categoryId,
      type: m.measurementType,
      geometry: m.geometry,
      quantity: m.quantity,
      unit: m.unit,
      label: m.label,
      createdAt: m.createdAt,
    }));

    return NextResponse.json({ measurements: formatted });
  } catch (error) {
    console.error('Measurements GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/takeoff/measurements - Create new measurement
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Validate request body with Zod
    const validation = createMeasurementSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { id, sheetId, categoryId, type, geometry, quantity, unit, label } = validation.data;

    // Verify sheet ownership through project
    const [sheet] = await db
      .select({
        sheet: takeoffSheets,
        project: takeoffProjects,
      })
      .from(takeoffSheets)
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .where(eq(takeoffSheets.id, sheetId))
      .limit(1);

    if (!sheet || sheet.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
    }

    // Create measurement with persisted type/unit/label
    const [measurement] = await db
      .insert(takeoffMeasurements)
      .values({
        id,
        sheetId,
        categoryId,
        geometry,
        measurementType: type,
        unit,
        label: label ?? null,
        quantity,
        createdBy: session.user.id,
        source: 'manual',
      })
      .returning();

    // Return formatted measurement matching GET response shape
    return NextResponse.json({
      measurement: {
        id: measurement.id,
        sheetId: measurement.sheetId,
        categoryId: measurement.categoryId,
        type: measurement.measurementType,
        geometry: measurement.geometry,
        quantity: measurement.quantity,
        unit: measurement.unit,
        label: measurement.label,
        createdAt: measurement.createdAt,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('Measurements POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/takeoff/measurements - Update measurement
export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Validate request body with Zod
    const validation = updateMeasurementSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { id, geometry, quantity, label, type, unit } = validation.data;

    // Get measurement and verify ownership through sheet->project
    const [measurement] = await db
      .select()
      .from(takeoffMeasurements)
      .where(eq(takeoffMeasurements.id, id))
      .limit(1);

    if (!measurement) {
      return NextResponse.json({ error: 'Measurement not found' }, { status: 404 });
    }

    const [sheet] = await db
      .select({
        sheet: takeoffSheets,
        project: takeoffProjects,
      })
      .from(takeoffSheets)
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .where(eq(takeoffSheets.id, measurement.sheetId))
      .limit(1);

    if (!sheet || sheet.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (geometry !== undefined) updateData.geometry = geometry;
    if (quantity !== undefined) updateData.quantity = quantity;
    if (type !== undefined) updateData.measurementType = type;
    if (unit !== undefined) updateData.unit = unit;
    if (label !== undefined) updateData.label = label;

    const [updated] = await db
      .update(takeoffMeasurements)
      .set(updateData)
      .where(eq(takeoffMeasurements.id, id))
      .returning();

    // Return formatted measurement matching GET response shape
    return NextResponse.json({
      measurement: {
        id: updated.id,
        sheetId: updated.sheetId,
        categoryId: updated.categoryId,
        type: updated.measurementType,
        geometry: updated.geometry,
        quantity: updated.quantity,
        unit: updated.unit,
        label: updated.label,
        createdAt: updated.createdAt,
      },
    });
  } catch (error) {
    console.error('Measurements PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/takeoff/measurements - Delete measurement
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    // Validate UUID
    const idValidation = z.string().uuid('Invalid measurement ID').safeParse(id);
    if (!idValidation.success) {
      return NextResponse.json(
        { error: formatZodError(idValidation.error) },
        { status: 400 }
      );
    }

    // Get measurement and verify ownership through sheet->project
    const [measurement] = await db
      .select()
      .from(takeoffMeasurements)
      .where(eq(takeoffMeasurements.id, idValidation.data))
      .limit(1);

    if (!measurement) {
      return NextResponse.json({ error: 'Measurement not found' }, { status: 404 });
    }

    const [sheet] = await db
      .select({
        sheet: takeoffSheets,
        project: takeoffProjects,
      })
      .from(takeoffSheets)
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .where(eq(takeoffSheets.id, measurement.sheetId))
      .limit(1);

    if (!sheet || sheet.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Delete measurement
    await db.delete(takeoffMeasurements).where(eq(takeoffMeasurements.id, idValidation.data));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Measurements DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
