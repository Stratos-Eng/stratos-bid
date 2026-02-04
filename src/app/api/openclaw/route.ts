import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { openclawChatCompletions } from '@/lib/openclaw';

/**
 * POST /api/openclaw
 *
 * Server-side proxy to OpenClaw's OpenAI-compatible Chat Completions endpoint.
 *
 * Why this exists:
 * - Keeps the OpenClaw API key off the client.
 * - Allows us to attach the authenticated user id (for future attribution/rate limits).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: 'Expected JSON body with { messages: [{role, content}, ...] }' },
        { status: 400 }
      );
    }

    // Basic normalization: only allow the minimal message shape for now.
    const messages = body.messages.map((m: any) => ({
      role: m.role,
      content: String(m.content ?? ''),
    }));

    const result = await openclawChatCompletions({
      // Optional override, otherwise uses OPENCLAW_AGENT_MODEL or default
      model: body.model,
      messages,
      temperature: body.temperature,
    });

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/openclaw] error', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
