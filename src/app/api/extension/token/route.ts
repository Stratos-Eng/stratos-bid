import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

const EXTENSION_TOKEN_SECRET = process.env.EXTENSION_TOKEN_SECRET || 'dev-secret-change-in-prod';

export async function POST(_req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Generate a simple JWT-like token for the extension
  // In production, use proper JWT library (jsonwebtoken)
  const payload = {
    userId: session.user.id,
    email: session.user.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days
  };

  // Simple base64 encoding (in production, use proper JWT signing)
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const signature = btoa(
    simpleHash(`${header}.${body}.${EXTENSION_TOKEN_SECRET}`)
  );

  const token = `${header}.${body}.${signature}`;

  return NextResponse.json({
    token,
    userId: session.user.id,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  });
}

// Simple hash function for demo - use crypto.createHmac in production
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}
