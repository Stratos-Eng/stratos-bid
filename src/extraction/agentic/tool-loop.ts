/**
 * Agentic Tool Loop for Signage Extraction
 *
 * Implements the tool execution loop where Claude investigates
 * documents iteratively using tools until extraction is complete.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '@/lib/anthropic';
import type {
  DocumentInfo,
  AgenticExtractionResult,
  SubmitEntriesInput,
  SubmittedEntry,
  SignageEntry,
  TokenUsage,
} from './types';
import { EXTRACTION_SYSTEM_PROMPT, buildInitialPrompt } from './prompts';
import { EXTRACTION_TOOLS, executeToolCall } from './tools';

const MAX_ITERATIONS = 15; // Reduced from 25 - most extractions converge in 4-7
const COST_BUDGET_USD = 0.25; // Stop if cost exceeds this
const STABILITY_THRESHOLD = 3; // Exit if no new entries for N iterations

// Model configuration - use EXTRACTION_MODEL env var to override
// Default to Claude Haiku 4.5 for excellent tool use at reasonable cost
const MODEL = process.env.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001';

// Pricing per 1M tokens (as of Jan 2026)
// Sources:
// - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
// - OpenAI: https://openai.com/api/pricing/
// - Google: https://ai.google.dev/gemini-api/docs/pricing
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic (current)
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-5-20251101': { input: 5.0, output: 25.0 },
  // Anthropic (legacy)
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.0 },
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  // Google Gemini
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-3-flash': { input: 0.50, output: 3.0 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

function getModelPricing() {
  return MODEL_PRICING[MODEL] || { input: 1.0, output: 5.0 }; // Default to Haiku 4.5 pricing if unknown
}

/**
 * Run the agentic extraction loop
 */
export async function runExtractionLoop(
  bidFolder: string,
  documents: DocumentInfo[]
): Promise<AgenticExtractionResult> {
  const client = getAnthropicClient();
  const messages: Anthropic.MessageParam[] = [];

  // Initial prompt
  messages.push({
    role: 'user',
    content: buildInitialPrompt(bidFolder, documents),
  });

  let iterationsUsed = 0;
  let toolCallsCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Track entry stability for early exit
  let lastEntryCount = 0;
  let stabilityCounter = 0;

  const pricing = getModelPricing();
  console.log(`[agentic] Starting extraction with model: ${MODEL} (pricing: $${pricing.input}/$${pricing.output} per 1M tokens)`);
  console.log(`[agentic] Limits: ${MAX_ITERATIONS} iterations, $${COST_BUDGET_USD} budget`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterationsUsed++;

    console.log(`[agentic] Iteration ${iterationsUsed}...`);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: EXTRACTION_SYSTEM_PROMPT,
      tools: EXTRACTION_TOOLS,
      messages,
    });

    // Track token usage
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    const costSoFar = calculateCost(totalInputTokens, totalOutputTokens);
    console.log(`[agentic] Tokens this call: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out | Total: ${totalInputTokens} in / ${totalOutputTokens} out | Est. cost: $${costSoFar.toFixed(4)}`);

    // Extract tool_use blocks FIRST (needed for budget handling and tool execution)
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    // Cost budget check — hard termination, no looping
    if (costSoFar > COST_BUDGET_USD) {
      console.log(`[agentic] Cost budget exceeded ($${costSoFar.toFixed(4)} > $${COST_BUDGET_USD}), forcing completion`);

      // Check if THIS response already contains submit_entries
      const budgetSubmitCall = toolUseBlocks.find(b => b.name === 'submit_entries');
      if (budgetSubmitCall) {
        const input = budgetSubmitCall.input as SubmitEntriesInput;
        console.log(`[agentic] Found submit_entries in budget-exceeded response with ${input.entries.length} entries, completing`);
        console.log(`[agentic] Final token usage: ${totalInputTokens} input, ${totalOutputTokens} output, est. $${costSoFar.toFixed(4)}`);
        return buildResult(input, iterationsUsed, toolCallsCount, buildTokenUsage(totalInputTokens, totalOutputTokens));
      }

      // Give Claude ONE final chance to call submit_entries
      messages.push({ role: 'assistant', content: response.content });

      const userContent: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
      for (const block of toolUseBlocks) {
        userContent.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Skipped — cost budget exceeded.',
          is_error: true,
        });
      }
      userContent.push({
        type: 'text',
        text: 'URGENT: Cost budget exceeded. You MUST call submit_entries NOW with all findings so far. Do not call any other tools.',
      });
      messages.push({ role: 'user', content: userContent });

      // Make ONE final API call
      console.log(`[agentic] Making final budget-exceeded API call...`);
      const finalResponse = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: EXTRACTION_SYSTEM_PROMPT,
        tools: EXTRACTION_TOOLS,
        messages,
      });

      totalInputTokens += finalResponse.usage.input_tokens;
      totalOutputTokens += finalResponse.usage.output_tokens;
      iterationsUsed++;

      const finalCost = calculateCost(totalInputTokens, totalOutputTokens);
      console.log(`[agentic] Final call tokens: ${finalResponse.usage.input_tokens} in / ${finalResponse.usage.output_tokens} out | Total cost: $${finalCost.toFixed(4)}`);

      // Check for submit_entries in final response
      const finalSubmit = finalResponse.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'submit_entries'
      );

      if (finalSubmit) {
        const input = finalSubmit.input as SubmitEntriesInput;
        console.log(`[agentic] Final call returned submit_entries with ${input.entries.length} entries`);
        return buildResult(input, iterationsUsed, toolCallsCount, buildTokenUsage(totalInputTokens, totalOutputTokens));
      }

      // Last resort: try to parse entries from text in the final response
      const finalTextBlocks = finalResponse.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      if (finalTextBlocks.length > 0) {
        const parsed = tryParseEntriesFromText(finalTextBlocks[0].text);
        if (parsed) {
          console.log(`[agentic] Parsed ${parsed.entries.length} entries from final text response`);
          return buildResult(parsed, iterationsUsed, toolCallsCount, buildTokenUsage(totalInputTokens, totalOutputTokens));
        }
      }

      // Nothing recoverable — return empty
      console.warn(`[agentic] Budget exceeded, could not extract entries after final attempt`);
      return {
        entries: [],
        totalCount: 0,
        confidence: 0,
        notes: 'Budget exceeded, extraction incomplete',
        iterationsUsed,
        toolCallsCount,
        tokenUsage: buildTokenUsage(totalInputTokens, totalOutputTokens),
      };
    }

    // Check for submit_entries - this means we're done
    const submitCall = toolUseBlocks.find(
      (block) => block.name === 'submit_entries'
    );
    if (submitCall) {
      const input = submitCall.input as SubmitEntriesInput;
      const currentEntryCount = input.entries.length;

      // Check for entry stability (early exit if no progress)
      if (currentEntryCount === lastEntryCount && currentEntryCount > 0) {
        stabilityCounter++;
        if (stabilityCounter >= STABILITY_THRESHOLD) {
          console.log(`[agentic] Entries stabilized for ${STABILITY_THRESHOLD} iterations (${currentEntryCount} entries), completing`);
          console.log(`[agentic] Final token usage: ${totalInputTokens} input, ${totalOutputTokens} output, est. $${calculateCost(totalInputTokens, totalOutputTokens).toFixed(4)}`);
          return buildResult(input, iterationsUsed, toolCallsCount, buildTokenUsage(totalInputTokens, totalOutputTokens));
        }
      } else {
        stabilityCounter = 0;
        lastEntryCount = currentEntryCount;
      }

      console.log(`[agentic] Received submit_entries, completing extraction`);
      console.log(`[agentic] Final token usage: ${totalInputTokens} input, ${totalOutputTokens} output, est. $${calculateCost(totalInputTokens, totalOutputTokens).toFixed(4)}`);
      return buildResult(input, iterationsUsed, toolCallsCount, buildTokenUsage(totalInputTokens, totalOutputTokens));
    }

    // If no tool calls, check if we have a final text response
    if (toolUseBlocks.length === 0) {
      // Extract any text content
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );

      if (textBlocks.length > 0) {
        console.log(`[agentic] No more tool calls, attempting to parse response`);
        // Try to extract entries from text response
        const parsed = tryParseEntriesFromText(textBlocks[0].text);
        if (parsed) {
          return buildResult(parsed, iterationsUsed, toolCallsCount, buildTokenUsage(totalInputTokens, totalOutputTokens));
        }
      }

      // No tool calls and no parseable response - ask Claude to submit
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content:
          'Please use the submit_entries tool to submit your findings, even if incomplete.',
      });
      continue;
    }

    // Add assistant's response to history
    messages.push({ role: 'assistant', content: response.content });

    // Execute tools and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const call of toolUseBlocks) {
      toolCallsCount++;
      console.log(`[agentic] Executing tool: ${call.name}`);

      const result = await executeToolCall(
        call.name,
        call.input as Record<string, unknown>,
        bidFolder
      );

      // Build content - either text or image+text for vision tools
      let content: Anthropic.ToolResultBlockParam['content'];

      if (result.imageData) {
        // Vision tool - return image with text description
        content = [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: result.imageData.media_type,
              data: result.imageData.data,
            },
          },
          {
            type: 'text' as const,
            text: result.content,
          },
        ];
        console.log(`[agentic] Returning image for ${call.name} (${Math.round(result.imageData.data.length / 1024)}KB)`);
      } else {
        content = result.content;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content,
        is_error: result.is_error,
      });
    }

    // Add tool results to messages
    messages.push({
      role: 'user',
      content: toolResults,
    });
  }

  // Max iterations reached
  console.warn(`[agentic] Max iterations (${MAX_ITERATIONS}) reached`);
  console.log(`[agentic] Final token usage: ${totalInputTokens} input, ${totalOutputTokens} output, est. $${calculateCost(totalInputTokens, totalOutputTokens).toFixed(4)}`);
  return {
    entries: [],
    totalCount: 0,
    confidence: 0,
    notes: `Extraction did not complete within ${MAX_ITERATIONS} iterations`,
    iterationsUsed,
    toolCallsCount,
    tokenUsage: buildTokenUsage(totalInputTokens, totalOutputTokens),
  };
}

/**
 * Calculate estimated cost in USD
 */
function calculateCost(inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing();
  return (inputTokens / 1_000_000) * pricing.input +
         (outputTokens / 1_000_000) * pricing.output;
}

/**
 * Build token usage object
 */
function buildTokenUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: calculateCost(inputTokens, outputTokens),
  };
}

/**
 * Build the final result from submitted entries
 */
function buildResult(
  input: SubmitEntriesInput,
  iterationsUsed: number,
  toolCallsCount: number,
  tokenUsage: TokenUsage
): AgenticExtractionResult {
  const entries: SignageEntry[] = input.entries.map(
    (e: SubmittedEntry, index: number) => ({
      id: `ae-${index.toString().padStart(3, '0')}`,
      identifier: e.roomNumber || e.roomName,
      name: e.roomName.toUpperCase(),
      roomNumber: e.roomNumber,
      signTypeCode: e.signType,
      quantity: e.quantity || 1,
      isGrouped: e.isGrouped || false,
      groupRange: e.groupRange,
      source: 'ai_extraction' as const,
      sheetRefs: e.sheetRef ? [e.sheetRef] : [],
      pageNumbers: e.pageNumber ? [e.pageNumber] : [],
      confidence: e.confidence || input.confidence,
      notes: e.notes,
    })
  );

  const totalCount = entries.reduce((sum, e) => sum + e.quantity, 0);

  return {
    entries,
    totalCount,
    confidence: input.confidence,
    notes: input.notes || '',
    iterationsUsed,
    toolCallsCount,
    tokenUsage,
  };
}

/**
 * Try to parse entries from a text response (fallback)
 */
function tryParseEntriesFromText(text: string): SubmitEntriesInput | null {
  // Look for JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*"entries"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.entries)) {
      return {
        entries: parsed.entries,
        confidence: parsed.confidence || 0.5,
        notes: parsed.notes,
      };
    }
  } catch {
    // Not valid JSON
  }

  return null;
}

/**
 * Export for index
 */
export { runExtractionLoop as extractSignageAgentic };
