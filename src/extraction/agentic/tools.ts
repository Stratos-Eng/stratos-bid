/**
 * Tool definitions and executors for Agentic Extraction
 *
 * These tools allow Claude to investigate documents iteratively.
 */

import { execSync } from 'child_process';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, extname, resolve, relative } from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ToolExecutionResult,
  ListFilesInput,
  ReadPdfPagesInput,
  SearchTextInput,
  SubmitEntriesInput,
  ViewPdfPageInput,
} from './types';

/**
 * Check if pdftotext is available and provide helpful error if not
 */
function checkPdftotext(): string | null {
  try {
    execSync('which pdftotext', { encoding: 'utf-8' });
    return null; // Available
  } catch {
    return 'Error: pdftotext command not found. Install Poppler: brew install poppler (macOS) or apt-get install poppler-utils (Linux)';
  }
}

/**
 * Tool definitions for Claude API
 */
export const EXTRACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_files',
    description:
      'List files and directories in the bid folder. Use to understand what documents are available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path within bid folder (optional, defaults to root)',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_pdf_pages',
    description:
      'Read text content from specific pages of a PDF document. Use to examine schedules, floor plans, or other documents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Relative path to the PDF file within bid folder',
        },
        pages: {
          type: 'array',
          items: { type: 'number' },
          description: 'Specific page numbers to read (1-indexed)',
        },
        startPage: {
          type: 'number',
          description: 'Start page for range (1-indexed)',
        },
        endPage: {
          type: 'number',
          description: 'End page for range (1-indexed)',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'search_text',
    description:
      'Search for text patterns across PDF documents. Returns matching lines with context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Text pattern to search for (case-insensitive)',
        },
        file: {
          type: 'string',
          description:
            'Optional: specific file to search in. If omitted, searches all PDFs.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum results to return (default 50)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'view_pdf_page',
    description:
      'View a PDF page as an image. Use this when text extraction fails to capture table layouts, legends, or schedules correctly. This tool renders the page visually so you can read tables, legends, and structured data that text extraction misses.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file: {
          type: 'string',
          description: 'Relative path to the PDF file within bid folder',
        },
        page: {
          type: 'number',
          description: 'Page number to view (1-indexed)',
        },
        scale: {
          type: 'number',
          description: 'Render scale (default 1.5, max 2.0). Higher = more detail but slower.',
        },
      },
      required: ['file', 'page'],
    },
  },
  {
    name: 'submit_entries',
    description:
      'Submit the final extracted signage entries. Call this when you have completed extraction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entries: {
          type: 'array',
          description: 'Array of signage entries',
          items: {
            type: 'object',
            properties: {
              roomName: {
                type: 'string',
                description: 'Room name in UPPERCASE',
              },
              roomNumber: {
                type: 'string',
                description: 'Room number if available',
              },
              quantity: {
                type: 'number',
                description: 'Quantity (default 1)',
              },
              signType: {
                type: 'string',
                description: 'Sign type code if known',
              },
              isGrouped: {
                type: 'boolean',
                description: 'Whether this is a grouped entry',
              },
              groupRange: {
                type: 'array',
                items: { type: 'number' },
                description: 'Range for grouped entries [start, end]',
              },
              sheetRef: {
                type: 'string',
                description: 'Sheet reference where found',
              },
              pageNumber: {
                type: 'number',
                description: 'Page number where found',
              },
              confidence: {
                type: 'number',
                description: 'Confidence 0-1',
              },
              notes: {
                type: 'string',
                description: 'Additional notes',
              },
            },
            required: ['roomName'],
          },
        },
        confidence: {
          type: 'number',
          description: 'Overall extraction confidence 0-1',
        },
        notes: {
          type: 'string',
          description: 'Notes about the extraction process or ambiguities',
        },
      },
      required: ['entries', 'confidence'],
    },
  },
];

/**
 * Execute a tool call
 */
export async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  bidFolder: string
): Promise<ToolExecutionResult> {
  try {
    switch (toolName) {
      case 'list_files':
        return await executeListFiles(toolInput as ListFilesInput, bidFolder);

      case 'read_pdf_pages':
        return await executeReadPdfPages(
          toolInput as unknown as ReadPdfPagesInput,
          bidFolder
        );

      case 'search_text':
        return await executeSearchText(
          toolInput as unknown as SearchTextInput,
          bidFolder
        );

      case 'view_pdf_page':
        return await executeViewPdfPage(
          toolInput as unknown as ViewPdfPageInput,
          bidFolder
        );

      case 'submit_entries':
        // This is handled specially in the loop - just acknowledge
        return {
          content: 'Entries submitted successfully',
        };

      default:
        return {
          content: `Unknown tool: ${toolName}`,
          is_error: true,
        };
    }
  } catch (error) {
    return {
      content: `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}

/**
 * List files in bid folder
 */
async function executeListFiles(
  input: ListFilesInput,
  bidFolder: string
): Promise<ToolExecutionResult> {
  const targetPath = input.path
    ? resolve(bidFolder, input.path)
    : bidFolder;

  // Security: ensure we stay within bid folder
  if (!targetPath.startsWith(resolve(bidFolder))) {
    return {
      content: 'Error: Cannot access paths outside bid folder',
      is_error: true,
    };
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = join(targetPath, entry.name);
    const relPath = relative(bidFolder, fullPath);

    if (entry.isDirectory()) {
      results.push(`[DIR] ${relPath}/`);
    } else {
      const stats = await stat(fullPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
      const ext = extname(entry.name).toLowerCase();
      results.push(`${relPath} (${sizeMB} MB)${ext === '.pdf' ? ' [PDF]' : ''}`);
    }
  }

  return {
    content: results.length > 0 ? results.join('\n') : '(empty directory)',
  };
}

/**
 * Read pages from a PDF
 */
async function executeReadPdfPages(
  input: ReadPdfPagesInput,
  bidFolder: string
): Promise<ToolExecutionResult> {
  // Check pdftotext is available
  const pdftotextError = checkPdftotext();
  if (pdftotextError) {
    return { content: pdftotextError, is_error: true };
  }

  const pdfPath = resolve(bidFolder, input.file);

  // Security: ensure we stay within bid folder
  if (!pdfPath.startsWith(resolve(bidFolder))) {
    return {
      content: 'Error: Cannot access paths outside bid folder',
      is_error: true,
    };
  }

  // Build pdftotext command
  let pageArg = '';
  if (input.pages && input.pages.length > 0) {
    // Read specific pages one at a time and combine
    const results: string[] = [];
    for (const page of input.pages.slice(0, 20)) {
      // Limit to 20 pages
      try {
        const text = execSync(
          `pdftotext -f ${page} -l ${page} "${pdfPath}" -`,
          {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          }
        );
        results.push(`--- Page ${page} ---\n${text.trim()}`);
      } catch {
        results.push(`--- Page ${page} ---\n(could not extract)`);
      }
    }
    return {
            content: results.join('\n\n'),
    };
  } else if (input.startPage && input.endPage) {
    pageArg = `-f ${input.startPage} -l ${input.endPage}`;
  } else {
    // Default: first 10 pages
    pageArg = '-f 1 -l 10';
  }

  try {
    const text = execSync(`pdftotext ${pageArg} "${pdfPath}" -`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    // Truncate if too long
    const maxLength = 50000;
    if (text.length > maxLength) {
      return {
                content:
          text.substring(0, maxLength) +
          `\n\n... (truncated, ${text.length - maxLength} more characters)`,
      };
    }

    return {
            content: text || '(no text extracted)',
    };
  } catch (error) {
    return {
            content: `Error reading PDF: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}

/**
 * Search for text in PDFs
 */
async function executeSearchText(
  input: SearchTextInput,
  bidFolder: string
): Promise<ToolExecutionResult> {
  // Check pdftotext is available
  const pdftotextError = checkPdftotext();
  if (pdftotextError) {
    return { content: pdftotextError, is_error: true };
  }

  const maxResults = input.maxResults || 50;
  const pattern = input.pattern;

  // Find PDFs to search
  let pdfFiles: string[] = [];

  if (input.file) {
    const pdfPath = resolve(bidFolder, input.file);
    if (!pdfPath.startsWith(resolve(bidFolder))) {
      return {
                content: 'Error: Cannot access paths outside bid folder',
        is_error: true,
      };
    }
    pdfFiles = [pdfPath];
  } else {
    // Find all PDFs recursively
    pdfFiles = await findPdfsRecursively(bidFolder);
  }

  const results: string[] = [];
  let totalMatches = 0;

  for (const pdfPath of pdfFiles) {
    if (totalMatches >= maxResults) break;

    try {
      const text = execSync(`pdftotext "${pdfPath}" -`, {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      });

      const lines = text.split('\n');
      const relPath = relative(bidFolder, pdfPath);

      for (let i = 0; i < lines.length && totalMatches < maxResults; i++) {
        if (lines[i].toLowerCase().includes(pattern.toLowerCase())) {
          // Get context (line before and after)
          const contextBefore = i > 0 ? lines[i - 1] : '';
          const contextAfter = i < lines.length - 1 ? lines[i + 1] : '';

          results.push(
            `[${relPath}]\n  ${contextBefore}\n> ${lines[i]}\n  ${contextAfter}`
          );
          totalMatches++;
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  if (results.length === 0) {
    return {
            content: `No matches found for "${pattern}"`,
    };
  }

  return {
        content: `Found ${totalMatches} matches:\n\n${results.join('\n\n')}`,
  };
}

/**
 * Recursively find all PDF files
 */
async function findPdfsRecursively(dir: string): Promise<string[]> {
  const pdfs: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      pdfs.push(...(await findPdfsRecursively(fullPath)));
    } else if (extname(entry.name).toLowerCase() === '.pdf') {
      pdfs.push(fullPath);
    }
  }

  return pdfs;
}

/**
 * Check if pdftoppm is available
 */
function checkPdftoppm(): string | null {
  try {
    execSync('which pdftoppm', { encoding: 'utf-8' });
    return null; // Available
  } catch {
    return 'Error: pdftoppm command not found. Install Poppler: brew install poppler (macOS) or apt-get install poppler-utils (Linux)';
  }
}

/**
 * View a PDF page as an image (for vision-based extraction)
 *
 * This renders the page using pdftoppm and returns it as base64
 * for Claude's vision capabilities to read tables and legends.
 */
async function executeViewPdfPage(
  input: ViewPdfPageInput,
  bidFolder: string
): Promise<ToolExecutionResult> {
  // Check pdftoppm is available
  const pdftoppmError = checkPdftoppm();
  if (pdftoppmError) {
    return { content: pdftoppmError, is_error: true };
  }

  const pdfPath = resolve(bidFolder, input.file);

  // Security: ensure we stay within bid folder
  if (!pdfPath.startsWith(resolve(bidFolder))) {
    return {
      content: 'Error: Cannot access paths outside bid folder',
      is_error: true,
    };
  }

  if (!existsSync(pdfPath)) {
    return {
      content: `Error: File not found: ${input.file}`,
      is_error: true,
    };
  }

  const page = input.page;
  const scale = Math.min(input.scale || 1.5, 2.0); // Cap at 2.0 for reasonable size
  const dpi = Math.round(72 * scale); // 72 DPI base * scale

  try {
    // Use pdftoppm to render the page as PNG
    // -f and -l specify first and last page (same value = single page)
    // -png outputs PNG format
    // -r specifies DPI
    const pngBuffer = execSync(
      `pdftoppm -f ${page} -l ${page} -png -r ${dpi} -singlefile "${pdfPath}"`,
      {
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024, // 50MB max
      }
    );

    // Convert to base64
    const base64 = pngBuffer.toString('base64');

    // Return as image content for vision
    return {
      content: `[Image of page ${page} rendered at ${dpi} DPI]`,
      imageData: {
        type: 'base64',
        media_type: 'image/png',
        data: base64,
      },
    };
  } catch (error) {
    return {
      content: `Error rendering page: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }
}
