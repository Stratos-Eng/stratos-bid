import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffCategories, takeoffProjects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  createCategorySchema,
  updateCategorySchema,
  formatZodError,
} from '@/lib/validations/takeoff';
import { z } from 'zod';

// POST /api/takeoff/categories - Create new category
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Validate request body with Zod
    const validation = createCategorySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { projectId, name, color, measurementType, sortOrder } = validation.data;

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

    // Create category
    const [category] = await db
      .insert(takeoffCategories)
      .values({
        id: body.id, // Use provided ID if available (for optimistic updates)
        projectId,
        name,
        color,
        measurementType,
        sortOrder: sortOrder ?? 0,
      })
      .returning();

    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    console.error('Category POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/takeoff/categories - Update category
export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Validate id separately since it's required
    const idValidation = z.string().uuid('Invalid category ID').safeParse(body.id);
    if (!idValidation.success) {
      return NextResponse.json(
        { error: formatZodError(idValidation.error) },
        { status: 400 }
      );
    }

    // Validate update fields
    const validation = updateCategorySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { name, color, measurementType, sortOrder } = validation.data;

    // Get category and verify ownership through project
    const [category] = await db
      .select({
        category: takeoffCategories,
        project: takeoffProjects,
      })
      .from(takeoffCategories)
      .innerJoin(takeoffProjects, eq(takeoffCategories.projectId, takeoffProjects.id))
      .where(eq(takeoffCategories.id, idValidation.data))
      .limit(1);

    if (!category || category.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 });
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (color !== undefined) updateData.color = color;
    if (measurementType !== undefined) updateData.measurementType = measurementType;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    // Only update if there are changes
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ category: category.category });
    }

    const [updated] = await db
      .update(takeoffCategories)
      .set(updateData)
      .where(eq(takeoffCategories.id, idValidation.data))
      .returning();

    return NextResponse.json({ category: updated });
  } catch (error) {
    console.error('Category PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/takeoff/categories - Delete category
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    // Validate UUID
    const idValidation = z.string().uuid('Invalid category ID').safeParse(id);
    if (!idValidation.success) {
      return NextResponse.json(
        { error: formatZodError(idValidation.error) },
        { status: 400 }
      );
    }

    // Get category and verify ownership through project
    const [category] = await db
      .select({
        category: takeoffCategories,
        project: takeoffProjects,
      })
      .from(takeoffCategories)
      .innerJoin(takeoffProjects, eq(takeoffCategories.projectId, takeoffProjects.id))
      .where(eq(takeoffCategories.id, idValidation.data))
      .limit(1);

    if (!category || category.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 });
    }

    // Delete category (measurements cascade via foreign key)
    await db.delete(takeoffCategories).where(eq(takeoffCategories.id, idValidation.data));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Category DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
