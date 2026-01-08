import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { inngest } from '@/inngest/client';

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { connectionId } = await req.json();

    // Send event to Inngest to trigger sync
    await inngest.send({
      name: 'sync/connection',
      data: {
        userId: session.user.id,
        connectionId,
      },
    });

    return NextResponse.json({ success: true, message: 'Sync triggered' });
  } catch (error: any) {
    console.error('Sync trigger error:', error);
    return NextResponse.json(
      { error: 'Failed to trigger sync' },
      { status: 500 }
    );
  }
}
