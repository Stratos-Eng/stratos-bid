import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Simple runtime version endpoint to confirm deploy revision.
// DO App Platform can set GIT_SHA, VERCEL_GIT_COMMIT_SHA, or similar.
export async function GET() {
  return NextResponse.json(
    {
      sha:
        process.env.GIT_SHA ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.NEXT_PUBLIC_GIT_SHA ||
        null,
      app: process.env.APP_NAME || 'stratos-bid',
      builtAt: process.env.BUILT_AT || null,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
