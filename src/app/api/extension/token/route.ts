import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { generateExtensionToken } from '@/lib/extension-auth';
import { rateLimiters, getRateLimitHeaders } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Rate limiting by user ID
  const rateLimitResult = rateLimiters.extensionToken(session.user.id);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
    );
  }

  // Generate a properly signed JWT for the extension
  const { token, expiresAt } = generateExtensionToken(
    session.user.id,
    session.user.email || ''
  );

  return NextResponse.json({
    token,
    userId: session.user.id,
    expiresAt: expiresAt.toISOString(),
  });
}
