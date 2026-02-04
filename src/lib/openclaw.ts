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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Our public-facing auth header; Caddy validates this and injects Bearer upstream.
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ ...req, model }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenClaw chat.completions error ${res.status}: ${text}`);
  }

  return res.json();
}
