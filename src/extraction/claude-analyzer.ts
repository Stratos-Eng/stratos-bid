import Anthropic from '@anthropic-ai/sdk';
import { TradeCode, TRADE_DEFINITIONS } from '@/lib/trade-definitions';
import {
  SIGNAGE_SYSTEM_PROMPT,
  SIGNAGE_EXTRACTION_PROMPT,
  SIGNAGE_VISION_PROMPT,
} from './prompts/signage';

export interface ExtractedLineItem {
  category: string;
  description: string;
  estimatedQty: string | null;
  unit: string | null;
  notes: string | null;
  specifications: Record<string, string>;
  confidence: number;
  pageReference?: string;
}

export interface ExtractionResult {
  pageNumber: number;
  items: ExtractedLineItem[];
  tradeCode: TradeCode;
  rawResponse: string;
  processingTimeMs: number;
}

const anthropic = new Anthropic();

function getPromptsForTrade(tradeCode: TradeCode) {
  // Currently only supporting signage (Division 10)
  // TODO: Add other trade prompts when needed
  return {
    system: SIGNAGE_SYSTEM_PROMPT,
    extraction: SIGNAGE_EXTRACTION_PROMPT,
    vision: SIGNAGE_VISION_PROMPT,
  };
}

/**
 * Analyze a page using text extraction
 */
export async function analyzePageText(
  pageText: string,
  pageNumber: number,
  tradeCode: TradeCode
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const prompts = getPromptsForTrade(tradeCode);

  // Skip pages with minimal content
  if (pageText.length < 100) {
    return {
      pageNumber,
      items: [],
      tradeCode,
      rawResponse: 'Page skipped - insufficient content',
      processingTimeMs: Date.now() - startTime,
    };
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: prompts.system,
      messages: [
        {
          role: 'user',
          content: `${prompts.extraction}\n\n---PAGE ${pageNumber} CONTENT---\n${pageText.substring(0, 15000)}\n---END PAGE---`,
        },
      ],
    });

    // Log token usage
    console.log(`[Claude] Page ${pageNumber} (text): ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

    const rawResponse =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const items = parseExtractionResponse(rawResponse, tradeCode);

    return {
      pageNumber,
      items,
      tradeCode,
      rawResponse,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    console.error(`Error analyzing page ${pageNumber}:`, error);
    return {
      pageNumber,
      items: [],
      tradeCode,
      rawResponse: `Error: ${error}`,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Analyze a page using vision (PDF page image)
 */
export async function analyzePageVision(
  imageBase64: string,
  pageNumber: number,
  tradeCode: TradeCode,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png'
): Promise<ExtractionResult> {
  const startTime = Date.now();
  const prompts = getPromptsForTrade(tradeCode);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: `${prompts.vision}\n\nThis is page ${pageNumber} of the construction document.`,
            },
          ],
        },
      ],
    });

    // Log token usage (vision includes image tokens)
    console.log(`[Claude] Page ${pageNumber} (vision): ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

    const rawResponse =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const items = parseExtractionResponse(rawResponse, tradeCode);

    return {
      pageNumber,
      items,
      tradeCode,
      rawResponse,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    console.error(`Error analyzing page ${pageNumber} (vision):`, error);
    return {
      pageNumber,
      items: [],
      tradeCode,
      rawResponse: `Error: ${error}`,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Hybrid analysis: try text first, fall back to vision if text extraction poor
 */
export async function analyzePageHybrid(
  pageText: string,
  imageBase64: string | null,
  pageNumber: number,
  tradeCode: TradeCode
): Promise<ExtractionResult> {
  // First try text-based analysis
  const textResult = await analyzePageText(pageText, pageNumber, tradeCode);

  // If text extraction found items with good confidence, use it
  if (textResult.items.length > 0) {
    const avgConfidence =
      textResult.items.reduce((sum, item) => sum + item.confidence, 0) /
      textResult.items.length;
    if (avgConfidence > 0.7) {
      return textResult;
    }
  }

  // If we have an image and text extraction was poor, try vision
  if (imageBase64 && (textResult.items.length === 0 || pageText.length < 500)) {
    console.log(
      `Page ${pageNumber}: Text extraction insufficient, trying vision...`
    );
    const visionResult = await analyzePageVision(
      imageBase64,
      pageNumber,
      tradeCode
    );

    // Merge results, preferring vision for low-confidence text items
    if (visionResult.items.length > textResult.items.length) {
      return visionResult;
    }
  }

  return textResult;
}

/**
 * Parse Claude's JSON response into structured items
 */
function parseExtractionResponse(
  response: string,
  tradeCode: TradeCode
): ExtractedLineItem[] {
  try {
    // Find JSON array in response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const trade = TRADE_DEFINITIONS[tradeCode];

    return parsed
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any) => ({
        category: validateCategory(item.category, trade.categories),
        description: String(item.description || '').trim(),
        estimatedQty: item.estimatedQty ? String(item.estimatedQty) : null,
        unit: item.unit ? String(item.unit).toUpperCase() : null,
        notes: item.notes ? String(item.notes).trim() : null,
        specifications: item.specifications || {},
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
        pageReference: item.pageReference,
      }))
      .filter((item: ExtractedLineItem) => item.description.length > 0);
  } catch (error) {
    console.error('Error parsing extraction response:', error);
    return [];
  }
}

/**
 * Validate and normalize category
 */
function validateCategory(
  category: string | undefined,
  validCategories: readonly string[]
): string {
  if (!category) return 'Other';

  // Try exact match first
  const exactMatch = validCategories.find(
    c => c.toLowerCase() === category.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  // Try partial match
  const partialMatch = validCategories.find(
    c =>
      c.toLowerCase().includes(category.toLowerCase()) ||
      category.toLowerCase().includes(c.toLowerCase())
  );
  if (partialMatch) return partialMatch;

  return category; // Return as-is if no match
}

/**
 * Batch analyze multiple pages
 */
export async function analyzePages(
  pages: Array<{ pageNumber: number; text: string; imageBase64?: string }>,
  tradeCode: TradeCode,
  options: { useVision?: boolean; concurrency?: number } = {}
): Promise<ExtractionResult[]> {
  const { useVision = false, concurrency = 3 } = options;
  const results: ExtractionResult[] = [];

  // Process in batches to avoid rate limits
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async page => {
        if (useVision && page.imageBase64) {
          return analyzePageHybrid(
            page.text,
            page.imageBase64,
            page.pageNumber,
            tradeCode
          );
        } else {
          return analyzePageText(page.text, page.pageNumber, tradeCode);
        }
      })
    );

    results.push(...batchResults);

    // Brief pause between batches to avoid rate limits
    if (i + concurrency < pages.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}
