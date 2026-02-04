# Inference Gateway (OpenClaw) Integration

Goal: run all LLM calls through **your OpenClaw Gateway** instead of embedding provider API keys in the app.

## How it works

This codebase uses the **Anthropic SDK** for:
- simple text calls (e.g. filename classification)
- agentic extraction with **tool use** (tool_use / tool_result blocks)

To keep behavior identical, we keep using the Anthropic SDK, but optionally point it at a different base URL.

### Modes

#### A) Direct Anthropic (default)

- `ANTHROPIC_API_KEY=...`
- No `INFERENCE_BASE_URL`

Requests go to `https://api.anthropic.com`.

#### B) OpenClaw gateway (recommended)

- `INFERENCE_BASE_URL=https://openclaw.<yourdomain>`
- `INFERENCE_API_KEY=<shared-secret>`
- (optional) `INFERENCE_PROVIDER=openclaw` (informational)

Requests go to your OpenClaw gateway, which must expose an **Anthropic-compatible** endpoint surface.

## Expected Gateway API surface

Your OpenClaw gateway should accept the same request shape as Anthropic's Messages API.

- `POST /v1/messages`
  - body: `{ model, max_tokens, system?, tools?, messages }`
  - returns: `{ content: [...], usage: { input_tokens, output_tokens }, ... }`

Because we reuse the Anthropic SDK, tool-use blocks and message history work without custom glue.

## Auth

Suggested: a shared secret header, independent from Clerk user auth.

- App → Gateway: `x-api-key: <INFERENCE_API_KEY>` (or similar)
- Gateway validates and forwards to the model provider.

You can optionally forward the authenticated Clerk user id in another header for attribution/rate limiting.

## Env vars to add in DigitalOcean App Platform

- `INFERENCE_BASE_URL` (e.g. `https://openclaw.stratos.to`)
- `INFERENCE_API_KEY` (random secret)

Then you can remove `ANTHROPIC_API_KEY` from the app if your gateway is the only caller.
