import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredentials, type PasswordCredentials } from '@/lib/crypto';

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { platform, email, password } = await req.json();

    if (!platform || !email || !password) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const encryptedCreds = encryptCredentials({ email, password });

    // Check if connection exists
    const existing = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.userId, session.user.id),
          eq(connections.platform, platform)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing connection
      await db
        .update(connections)
        .set({
          credentials: encryptedCreds,
          authType: 'password',
          status: 'active',
        })
        .where(eq(connections.id, existing[0].id));

      return NextResponse.json({ success: true, id: existing[0].id });
    }

    // Create new connection
    const [newConnection] = await db
      .insert(connections)
      .values({
        userId: session.user.id,
        platform,
        authType: 'password',
        credentials: encryptedCreds,
        status: 'active',
      })
      .returning();

    return NextResponse.json({ success: true, id: newConnection.id });
  } catch (error: any) {
    console.error('Connection error:', error);
    return NextResponse.json(
      { error: 'Failed to save connection' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform');

  if (!platform) {
    return NextResponse.json(
      { error: 'Missing platform parameter' },
      { status: 400 }
    );
  }

  try {
    await db
      .delete(connections)
      .where(
        and(
          eq(connections.userId, session.user.id),
          eq(connections.platform, platform)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Delete connection error:', error);
    return NextResponse.json(
      { error: 'Failed to delete connection' },
      { status: 500 }
    );
  }
}
