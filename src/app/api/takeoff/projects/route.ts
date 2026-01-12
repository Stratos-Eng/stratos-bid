import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { createProjectSchema, formatZodError } from '@/lib/validations/takeoff';

// GET /api/takeoff/projects - List user's projects
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projects = await db
      .select()
      .from(takeoffProjects)
      .where(eq(takeoffProjects.userId, session.user.id))
      .orderBy(desc(takeoffProjects.createdAt));

    return NextResponse.json({ projects });
  } catch (error) {
    console.error('Projects GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/takeoff/projects - Create new project
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Validate request body with Zod
    const validation = createProjectSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { name, bidId, clientName, address, defaultUnit } = validation.data;

    const [project] = await db
      .insert(takeoffProjects)
      .values({
        userId: session.user.id,
        name,
        bidId: bidId ?? null,
        clientName: clientName ?? null,
        address: address ?? null,
        defaultUnit,
        status: 'active',
      })
      .returning();

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    console.error('Projects POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
