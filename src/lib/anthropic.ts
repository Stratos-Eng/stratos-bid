import Anthropic from '@anthropic-ai/sdk';

/**
 * Centralized Anthropic client creation.
 *
 * Supports two modes:
 * 1) Direct Anthropic (default):
 *    - ANTHROPIC_API_KEY=...
 *
 * 2) OpenClaw as an inference gateway (Anthropic-compatible proxy):
 *    - INFERENCE_BASE_URL=https://openclaw.yourdomain.com
 *    - INFERENCE_API_KEY=... (shared secret for your gateway)
 *    - (optional) INFERENCE_PROVIDER=openclaw
 *
 * In OpenClaw mode, we still use the Anthropic SDK so tool-use and content blocks
 * behave exactly as before — we just send requests to your gateway instead of
 * api.anthropic.com.
 */
export function getAnthropicClient(): Anthropic {
  const baseURL = process.env.INFERENCE_BASE_URL;
  const apiKey = process.env.INFERENCE_API_KEY || process.env.ANTHROPIC_API_KEY;

  // During `next build`, Next.js can evaluate server modules while runtime secrets
  // are not available in the build environment (common on App Platform).
  // Avoid throwing at import-time; failures should happen at runtime when inference is used.
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build';

  if (!apiKey) {
    if (isBuild) {
      return new Anthropic({ apiKey: 'build-placeholder' });
    }
    throw new Error(
      'Missing API key. Set ANTHROPIC_API_KEY (direct) or INFERENCE_API_KEY (gateway).'
    );
  }

  // If baseURL is set, send requests there (OpenClaw gateway should expose Anthropic-compatible routes)
  if (baseURL) {
    return new Anthropic({
      apiKey,
      baseURL: baseURL.replace(/\/$/, ''),
    });
  }

  return new Anthropic({ apiKey });
}
