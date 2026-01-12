import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects, takeoffSheets, takeoffCategories } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { updateProjectSchema, formatZodError } from '@/lib/validations/takeoff';
import { z } from 'zod';

// GET /api/takeoff/projects/[projectId] - Get project with sheets and categories
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await params;

    // Validate UUID
    const idValidation = z.string().uuid('Invalid project ID').safeParse(projectId);
    if (!idValidation.success) {
      return NextResponse.json(
        { error: formatZodError(idValidation.error) },
        { status: 400 }
      );
    }

    // Get project
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

    // Get sheets
    const sheets = await db
      .select()
      .from(takeoffSheets)
      .where(eq(takeoffSheets.projectId, projectId))
      .orderBy(takeoffSheets.pageNumber);

    // Get categories
    const categories = await db
      .select()
      .from(takeoffCategories)
      .where(eq(takeoffCategories.projectId, projectId))
      .orderBy(takeoffCategories.sortOrder);

    // Format response to match store types
    const formattedProject = {
      id: project.id,
      name: project.name,
      bidId: project.bidId,
      defaultUnit: project.defaultUnit as 'imperial' | 'metric',
      sheets: sheets.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        documentId: s.documentId,
        pageNumber: s.pageNumber,
        name: s.name || `Page ${s.pageNumber}`,
        widthPx: s.widthPx || 1000,
        heightPx: s.heightPx || 800,
        scale: s.scaleValue,
        scaleUnit: 'ft', // Default to feet
        tilesReady: s.tilesReady,
        tileUrlTemplate: s.tileUrlTemplate,
      })),
      categories: categories.map((c) => ({
        id: c.id,
        projectId: c.projectId,
        name: c.name,
        color: c.color,
        measurementType: c.measurementType as 'count' | 'linear' | 'area',
        sortOrder: c.sortOrder,
      })),
    };

    return NextResponse.json({ project: formattedProject });
  } catch (error) {
    console.error('Project GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/takeoff/projects/[projectId] - Update project
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await params;

    // Validate UUID
    const idValidation = z.string().uuid('Invalid project ID').safeParse(projectId);
    if (!idValidation.success) {
      return NextResponse.json(
        { error: formatZodError(idValidation.error) },
        { status: 400 }
      );
    }

    const body = await request.json();

    // Validate request body with Zod
    const validation = updateProjectSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { name, clientName, address, defaultUnit, status } = validation.data;

    // Verify ownership
    const [existing] = await db
      .select()
      .from(takeoffProjects)
      .where(
        and(
          eq(takeoffProjects.id, projectId),
          eq(takeoffProjects.userId, session.user.id)
        )
      )
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (name !== undefined) updateData.name = name;
    if (clientName !== undefined) updateData.clientName = clientName;
    if (address !== undefined) updateData.address = address;
    if (defaultUnit !== undefined) updateData.defaultUnit = defaultUnit;
    if (status !== undefined) updateData.status = status;

    const [updated] = await db
      .update(takeoffProjects)
      .set(updateData)
      .where(eq(takeoffProjects.id, projectId))
      .returning();

    return NextResponse.json({ project: updated });
  } catch (error) {
    console.error('Project PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/takeoff/projects/[projectId] - Delete project
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await params;

    // Validate UUID
    const idValidation = z.string().uuid('Invalid project ID').safeParse(projectId);
    if (!idValidation.success) {
      return NextResponse.json(
        { error: formatZodError(idValidation.error) },
        { status: 400 }
      );
    }

    // Verify ownership
    const [existing] = await db
      .select()
      .from(takeoffProjects)
      .where(
        and(
          eq(takeoffProjects.id, projectId),
          eq(takeoffProjects.userId, session.user.id)
        )
      )
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Delete project (cascades to sheets, categories, measurements)
    await db.delete(takeoffProjects).where(eq(takeoffProjects.id, projectId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Project DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
