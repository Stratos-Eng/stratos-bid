export type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type OpenAIChatCompletionRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function openclawChatCompletions(
  req: Omit<OpenAIChatCompletionRequest, 'model'> & { model?: string }
) {
  const url = process.env.OPENCLAW_INFERENCE_URL;
  const apiKey = process.env.OPENCLAW_API_KEY;

  if (!url) {
    throw new Error('OPENCLAW_INFERENCE_URL is not set');
  }
  if (!apiKey) {
    throw new Error('OPENCLAW_API_KEY is not set');
  }

  const model = req.model || process.env.OPENCLAW_AGENT_MODEL || 'openclaw:Stratos-bid';

  const payload = JSON.stringify({ ...req, model });

  // Network can be flaky; instance-miner especially depends on this call.
  // Retry transient failures (fetch errors, 408/429/5xx) with exponential backoff.
  const maxAttempts = Number(process.env.OPENCLAW_FETCH_RETRIES || 4);

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutMs = Number(process.env.OPENCLAW_FETCH_TIMEOUT_MS || 120_000);
      const t = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Our public-facing auth header; Caddy validates this and injects Bearer upstream.
          'x-api-key': apiKey,
        },
        body: payload,
        signal: controller.signal,
      }).finally(() => clearTimeout(t));

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = [408, 425, 429].includes(res.status) || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        throw new Error(`OpenClaw chat.completions error ${res.status}: ${text}`);
      }

      return res.json();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /fetch failed|aborted|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg);
      if (retryable && attempt < maxAttempts) {
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
      throw e;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
