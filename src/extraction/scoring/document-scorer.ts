/**
 * Document Scorer
 *
 * Deterministic document ranking that runs BEFORE Claude reads anything.
 * This is completely free (no AI cost) and eliminates wasted tokens.
 *
 * Scoring strategy:
 * 1. Score by folder path (e.g., "Signage" folder = 100 points)
 * 2. Score by filename (e.g., "Exhibit A" = 95 points)
 * 3. Take the maximum score from all signals
 * 4. FALLBACK: If no high-confidence match, use Haiku to classify (~$0.001)
 */

import { readdir, stat } from 'fs/promises';
import { join, basename, extname, relative } from 'path';
import type { DocumentScore, ScoreSignal } from './patterns/types';
import { scoreFolderPath, scoreFilename } from './patterns';
import { boostScoresWithAI } from './ai-classifier';

/**
 * Document info for scoring
 */
export interface DocumentInfo {
  id: string;
  name: string;
  path: string;
  pageCount?: number;
}

/**
 * Score a single document
 */
export function scoreDocument(
  doc: DocumentInfo,
  tradeCode: string,
  bidFolder: string
): DocumentScore {
  const signals: ScoreSignal[] = [];
  let score = 0;

  // Get relative path for folder scoring
  const relPath = relative(bidFolder, doc.path);

  // Score by folder path
  const folderScore = scoreFolderPath(relPath, tradeCode);
  if (folderScore > 0) {
    signals.push({
      type: 'folder',
      pattern: extractFolderMatch(relPath, tradeCode),
      points: folderScore,
      description: `Found in relevant folder`,
    });
    score = Math.max(score, folderScore);
  }

  // Score by filename
  const filenameScore = scoreFilename(doc.name, tradeCode);
  if (filenameScore > 0) {
    signals.push({
      type: 'filename',
      pattern: doc.name,
      points: filenameScore,
      description: `Filename matches pattern`,
    });
    score = Math.max(score, filenameScore);
  }

  // If nothing matched, give a low baseline for PDFs
  if (score === 0 && extname(doc.name).toLowerCase() === '.pdf') {
    score = 10;
  }

  return {
    documentId: doc.id,
    filename: doc.name,
    path: doc.path,
    score,
    signals,
    priority: score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low',
  };
}

/**
 * Score multiple documents and sort by relevance
 */
export function scoreDocuments(
  documents: DocumentInfo[],
  tradeCode: string,
  bidFolder: string
): DocumentScore[] {
  return documents
    .map((doc) => scoreDocument(doc, tradeCode, bidFolder))
    .sort((a, b) => b.score - a.score);
}

/**
 * Find all documents in a bid folder and score them
 *
 * @param bidFolder - Path to the bid folder
 * @param tradeCode - Trade code (e.g., 'division_10')
 * @param useAIFallback - Whether to use Haiku for edge cases (default: true)
 */
export async function scoreAllDocuments(
  bidFolder: string,
  tradeCode: string,
  useAIFallback: boolean = true
): Promise<DocumentScore[]> {
  const documents = await findAllPdfs(bidFolder);
  const scores = scoreDocuments(documents, tradeCode, bidFolder);

  // Check if we have high-confidence matches
  const hasHighConfidence = scores.some((s) => s.score >= 80);

  // If no high-confidence matches and AI fallback enabled, use Haiku
  if (!hasHighConfidence && useAIFallback && scores.length > 0) {
    console.log('[scorer] No high-confidence matches, trying AI classification...');

    const { boostedScores, aiClassification } = await boostScoresWithAI(
      scores.map((s) => ({ path: s.path, score: s.score, filename: s.filename })),
      tradeCode
    );

    // Merge boosted scores back into full DocumentScore objects
    const scoreMap = new Map(scores.map((s) => [s.path, s]));
    const mergedScores = boostedScores.map((bs) => {
      const original = scoreMap.get(bs.path)!;
      if (bs.aiBoosted) {
        return {
          ...original,
          score: bs.score,
          signals: [
            ...original.signals,
            {
              type: 'ai_classification' as const,
              pattern: 'haiku',
              points: bs.score - original.score,
              description: 'AI-boosted relevance',
            },
          ],
          priority: bs.score >= 80 ? 'high' as const : bs.score >= 50 ? 'medium' as const : 'low' as const,
        };
      }
      return original;
    });

    // Log AI usage if it found something
    if (aiClassification && aiClassification.highRelevance.length > 0) {
      console.log(
        `[scorer] AI found ${aiClassification.highRelevance.length} high-relevance files (cost: $${aiClassification.tokenUsage.estimatedCostUsd.toFixed(4)})`
      );
    }

    return mergedScores;
  }

  return scores;
}

/**
 * Get the top-scoring document (if any meet threshold)
 */
export function getTopDocument(
  scores: DocumentScore[],
  minScore: number = 80
): DocumentScore | null {
  if (scores.length === 0) return null;
  const top = scores[0];
  return top.score >= minScore ? top : null;
}

/**
 * Get all high-priority documents
 */
export function getHighPriorityDocuments(scores: DocumentScore[]): DocumentScore[] {
  return scores.filter((s) => s.priority === 'high');
}

/**
 * Recursively find all PDF files in a directory
 */
async function findAllPdfs(dir: string, baseDir?: string): Promise<DocumentInfo[]> {
  const pdfs: DocumentInfo[] = [];
  const base = baseDir || dir;

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subPdfs = await findAllPdfs(fullPath, base);
        pdfs.push(...subPdfs);
      } else if (extname(entry.name).toLowerCase() === '.pdf') {
        // Get file stats for potential page count estimation
        const stats = await stat(fullPath);
        const sizeMB = stats.size / (1024 * 1024);

        pdfs.push({
          id: relative(base, fullPath),
          name: basename(fullPath),
          path: fullPath,
          // Rough estimate: ~100KB per page for construction PDFs
          pageCount: Math.max(1, Math.round(sizeMB * 10)),
        });
      }
    }
  } catch (error) {
    // Directory might not exist or be inaccessible
    console.warn(`[scorer] Could not read directory: ${dir}`);
  }

  return pdfs;
}

/**
 * Extract the matching folder name from a path
 */
function extractFolderMatch(path: string, tradeCode: string): string {
  // Look for known folder patterns in the path
  const patterns = ['signage', 'signs', 'division 10', '10d', 'graphics'];

  for (const pattern of patterns) {
    const regex = new RegExp(`[/\\\\](${pattern})[/\\\\]`, 'i');
    const match = path.match(regex);
    if (match) {
      return match[1];
    }
  }

  return path.split(/[/\\]/).slice(-2, -1)[0] || '';
}

/**
 * Format scores for logging
 */
export function formatScoresForLog(scores: DocumentScore[], limit: number = 10): string {
  const lines = scores.slice(0, limit).map((s) => {
    const signalStr = s.signals.map((sig) => `${sig.type}:${sig.points}`).join(', ');
    return `  [${s.score.toString().padStart(3)}] ${s.filename} (${signalStr})`;
  });

  if (scores.length > limit) {
    lines.push(`  ... and ${scores.length - limit} more`);
  }

  return lines.join('\n');
}
