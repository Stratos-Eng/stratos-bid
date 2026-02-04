/**
 * AI-Powered Filename Classifier
 *
 * Uses Haiku (cheapest Claude model) to classify filenames when
 * deterministic patterns fail. Cost: ~$0.001 for 50 filenames.
 *
 * This is a fallback for edge cases like:
 * - "10D - Wayfinding & Graphics/Exhibits/A-Series.pdf"
 * - "Arch Drawings/Interior Signage Details.pdf"
 * - "Bid Documents/Addendum 3 - Revised Sign Legend.pdf"
 */

import { getAnthropicClient } from '@/lib/anthropic';

const anthropic = getAnthropicClient();

/**
 * Classification result for a single file
 */
export interface FileClassification {
  path: string;
  relevance: 'high' | 'medium' | 'low' | 'none';
  confidence: number;
  reason: string;
}

/**
 * Result from AI classification
 */
export interface ClassificationResult {
  classifications: FileClassification[];
  highRelevance: string[];
  mediumRelevance: string[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

/**
 * Trade-specific classification prompts
 */
const TRADE_PROMPTS: Record<string, string> = {
  division_10: `You are classifying construction document filenames for SIGNAGE extraction (Division 10).

HIGH relevance (score 90-100):
- Sign schedules, signage legends, exhibit A documents
- Files with "signage", "signs", "wayfinding", "graphics" in path
- ADA signage, tactile signs, room identification

MEDIUM relevance (score 50-89):
- Door schedules (often include room signs)
- Floor plans (may show sign locations)
- Finish schedules (sometimes include signage)

LOW relevance (score 20-49):
- General architectural drawings
- Specifications that might mention signage

NONE (score 0-19):
- MEP drawings, structural, civil
- Specifications unrelated to signage
- Photos, reports, admin documents`,

  division_08: `You are classifying construction document filenames for GLAZING extraction (Division 08).

HIGH relevance:
- Window schedules, glazing schedules, curtain wall details
- Storefront drawings, glass specifications

MEDIUM relevance:
- Elevations (show windows), door schedules (glass doors)
- Facade details

LOW/NONE:
- Interior plans, MEP, structural, signage`,
};

/**
 * Classify a list of filenames using Haiku
 *
 * @param filePaths - Array of file paths to classify
 * @param tradeCode - Trade to classify for (e.g., 'division_10')
 * @returns Classification results with relevance scores
 */
export async function classifyFilenames(
  filePaths: string[],
  tradeCode: string
): Promise<ClassificationResult> {
  const tradePrompt = TRADE_PROMPTS[tradeCode] || TRADE_PROMPTS.division_10;

  // Format file list for the prompt
  const fileList = filePaths
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-latest',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `${tradePrompt}

Classify these ${filePaths.length} files. Return JSON only:

FILES:
${fileList}

Return format:
{
  "classifications": [
    {"index": 1, "relevance": "high|medium|low|none", "confidence": 0.0-1.0, "reason": "brief reason"}
  ]
}

Be concise. Only include files with high or medium relevance in detail.`,
      },
    ],
  });

  // Parse response
  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Haiku');
  }

  // Extract JSON from response
  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse JSON from Haiku response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    classifications: Array<{
      index: number;
      relevance: 'high' | 'medium' | 'low' | 'none';
      confidence: number;
      reason: string;
    }>;
  };

  // Map back to file paths
  const classifications: FileClassification[] = parsed.classifications.map((c) => ({
    path: filePaths[c.index - 1],
    relevance: c.relevance,
    confidence: c.confidence,
    reason: c.reason,
  }));

  // Calculate cost (Haiku: $0.25/MTok input, $1.25/MTok output)
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const estimatedCostUsd =
    (inputTokens * 0.00025) / 1000 + (outputTokens * 0.00125) / 1000;

  return {
    classifications,
    highRelevance: classifications
      .filter((c) => c.relevance === 'high')
      .map((c) => c.path),
    mediumRelevance: classifications
      .filter((c) => c.relevance === 'medium')
      .map((c) => c.path),
    tokenUsage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd,
    },
  };
}

/**
 * Boost document scores using AI classification
 *
 * This is called when deterministic scoring doesn't find high-confidence matches.
 * It uses Haiku to classify filenames and boosts scores accordingly.
 */
export async function boostScoresWithAI(
  scores: Array<{ path: string; score: number; filename: string }>,
  tradeCode: string,
  minScoreThreshold: number = 50
): Promise<{
  boostedScores: Array<{ path: string; score: number; filename: string; aiBoosted?: boolean }>;
  aiClassification?: ClassificationResult;
}> {
  // Only use AI if we don't have any high-confidence matches
  const hasHighConfidence = scores.some((s) => s.score >= 80);
  if (hasHighConfidence) {
    return { boostedScores: scores };
  }

  // Get files that scored below threshold (candidates for AI boost)
  const lowScoreFiles = scores
    .filter((s) => s.score < minScoreThreshold)
    .map((s) => s.path);

  if (lowScoreFiles.length === 0) {
    return { boostedScores: scores };
  }

  // Limit to 50 files to control costs
  const filesToClassify = lowScoreFiles.slice(0, 50);

  console.log(
    `[ai-classifier] No high-confidence matches, using Haiku to classify ${filesToClassify.length} files`
  );

  try {
    const classification = await classifyFilenames(filesToClassify, tradeCode);

    console.log(
      `[ai-classifier] Found ${classification.highRelevance.length} high, ${classification.mediumRelevance.length} medium relevance (cost: $${classification.tokenUsage.estimatedCostUsd.toFixed(4)})`
    );

    // Create a map of path -> classification
    const classificationMap = new Map(
      classification.classifications.map((c) => [c.path, c])
    );

    // Boost scores based on AI classification
    const boostedScores = scores.map((s) => {
      const aiClass = classificationMap.get(s.path);
      if (!aiClass) return s;

      let boost = 0;
      if (aiClass.relevance === 'high') {
        boost = Math.round(40 * aiClass.confidence); // Up to +40 points
      } else if (aiClass.relevance === 'medium') {
        boost = Math.round(20 * aiClass.confidence); // Up to +20 points
      }

      if (boost > 0) {
        return {
          ...s,
          score: Math.min(95, s.score + boost), // Cap at 95 (never exceed deterministic max)
          aiBoosted: true,
        };
      }

      return s;
    });

    // Re-sort by score
    boostedScores.sort((a, b) => b.score - a.score);

    return {
      boostedScores,
      aiClassification: classification,
    };
  } catch (error) {
    console.error('[ai-classifier] Failed to classify files:', error);
    // Fall back to original scores on error
    return { boostedScores: scores };
  }
}
