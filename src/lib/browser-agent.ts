import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Page } from 'playwright';

// Store the current page reference for tools to access
let currentPage: Page | null = null;

/**
 * Browser action that Claude can return
 */
export interface BrowserAction {
  type: 'click' | 'type' | 'navigate' | 'scroll' | 'wait' | 'done' | 'fail';
  selector?: string;
  text?: string;
  url?: string;
  x?: number;
  y?: number;
  reason?: string;
  learnedSelector?: string; // New selector to add to knowledge base
}

/**
 * Create MCP server with browser automation tools
 */
export function createBrowserTools(page: Page) {
  currentPage = page;

  return createSdkMcpServer({
    name: 'browser-automation',
    version: '1.0.0',
    tools: [
      tool(
        'screenshot',
        'Take a screenshot of the current page. Returns base64 encoded image.',
        {},
        async () => {
          if (!currentPage) throw new Error('No page available');

          const buffer = await currentPage.screenshot({ fullPage: false });
          return {
            content: [
              {
                type: 'image' as const,
                data: buffer.toString('base64'),
                mimeType: 'image/png',
              },
            ],
          };
        }
      ),

      tool(
        'get_page_info',
        'Get current page URL, title, and visible text content',
        {},
        async () => {
          if (!currentPage) throw new Error('No page available');

          const url = currentPage.url();
          const title = await currentPage.title();

          // Get visible text (limited to avoid huge responses)
          const text = await currentPage.evaluate(() => {
            const body = document.body;
            if (!body) return '';
            return body.innerText.substring(0, 5000);
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ url, title, visibleText: text }, null, 2),
              },
            ],
          };
        }
      ),

      tool(
        'click_element',
        'Click on an element using a CSS selector',
        {
          selector: z.string().describe('CSS selector for the element to click'),
        },
        async ({ selector }) => {
          if (!currentPage) throw new Error('No page available');

          try {
            await currentPage.click(selector, { timeout: 5000 });
            return {
              content: [{ type: 'text' as const, text: `Clicked: ${selector}` }],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to click ${selector}: ${error}`,
                },
              ],
            };
          }
        }
      ),

      tool(
        'click_coordinates',
        'Click at specific x,y coordinates on the page',
        {
          x: z.number().describe('X coordinate'),
          y: z.number().describe('Y coordinate'),
        },
        async ({ x, y }) => {
          if (!currentPage) throw new Error('No page available');

          await currentPage.mouse.click(x, y);
          return {
            content: [{ type: 'text' as const, text: `Clicked at (${x}, ${y})` }],
          };
        }
      ),

      tool(
        'type_text',
        'Type text into the currently focused element or a specified selector',
        {
          text: z.string().describe('Text to type'),
          selector: z
            .string()
            .optional()
            .describe('Optional CSS selector to focus first'),
        },
        async ({ text, selector }) => {
          if (!currentPage) throw new Error('No page available');

          if (selector) {
            await currentPage.click(selector);
          }
          await currentPage.keyboard.type(text);
          return {
            content: [{ type: 'text' as const, text: `Typed: ${text}` }],
          };
        }
      ),

      tool(
        'press_key',
        'Press a keyboard key (Enter, Tab, Escape, etc.)',
        {
          key: z.string().describe('Key to press (e.g., Enter, Tab, Escape)'),
        },
        async ({ key }) => {
          if (!currentPage) throw new Error('No page available');

          await currentPage.keyboard.press(key);
          return {
            content: [{ type: 'text' as const, text: `Pressed: ${key}` }],
          };
        }
      ),

      tool(
        'scroll',
        'Scroll the page',
        {
          direction: z.enum(['up', 'down']).describe('Scroll direction'),
          amount: z.number().optional().describe('Pixels to scroll (default 500)'),
        },
        async ({ direction, amount = 500 }) => {
          if (!currentPage) throw new Error('No page available');

          const delta = direction === 'down' ? amount : -amount;
          await currentPage.mouse.wheel(0, delta);
          return {
            content: [
              { type: 'text' as const, text: `Scrolled ${direction} ${amount}px` },
            ],
          };
        }
      ),

      tool(
        'wait',
        'Wait for a specified time or for an element to appear',
        {
          milliseconds: z.number().optional().describe('Time to wait in ms'),
          selector: z.string().optional().describe('CSS selector to wait for'),
        },
        async ({ milliseconds, selector }) => {
          if (!currentPage) throw new Error('No page available');

          if (selector) {
            await currentPage.waitForSelector(selector, { timeout: 10000 });
            return {
              content: [
                { type: 'text' as const, text: `Element appeared: ${selector}` },
              ],
            };
          } else if (milliseconds) {
            await new Promise((r) => setTimeout(r, milliseconds));
            return {
              content: [{ type: 'text' as const, text: `Waited ${milliseconds}ms` }],
            };
          }
          return { content: [{ type: 'text' as const, text: 'No action taken' }] };
        }
      ),

      tool(
        'find_elements',
        'Find elements matching a selector and return their text/attributes',
        {
          selector: z.string().describe('CSS selector to find elements'),
        },
        async ({ selector }) => {
          if (!currentPage) throw new Error('No page available');

          const elements = await currentPage.$$(selector);
          const results = await Promise.all(
            elements.slice(0, 10).map(async (el, i) => {
              const text = await el.textContent();
              const tag = await el.evaluate((e) => e.tagName.toLowerCase());
              const id = await el.getAttribute('id');
              const className = await el.getAttribute('class');
              return { index: i, tag, id, className, text: text?.substring(0, 100) };
            })
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }
      ),
    ],
  });
}

/**
 * Ask Claude to analyze the page and decide what action to take
 */
export async function askClaudeForHelp(
  page: Page,
  task: string,
  context: string
): Promise<BrowserAction> {
  const browserTools = createBrowserTools(page);

  const prompt = `You are a browser automation agent helping to scrape bid information from construction platforms.

CURRENT TASK: ${task}

CONTEXT: ${context}

Use the available tools to:
1. First take a screenshot to see the current page state
2. Analyze what you see
3. Decide the best action to accomplish the task

When you determine the action needed, respond with a JSON object in this exact format:
{
  "type": "click" | "type" | "navigate" | "scroll" | "wait" | "done" | "fail",
  "selector": "CSS selector if applicable",
  "text": "text to type if applicable",
  "reason": "why you chose this action",
  "learnedSelector": "if you found a working selector, include it here so we can save it"
}

If the task is complete, use type "done".
If you cannot proceed, use type "fail" with a reason.

IMPORTANT: After analyzing the page, you MUST output a JSON action object as your final response.`;

  let action: BrowserAction = { type: 'fail', reason: 'No response from agent' };

  try {
    const result = query({
      prompt,
      options: {
        permissionMode: 'acceptEdits' as const,
        mcpServers: {
          'browser-automation': browserTools,
        },
        maxTurns: 5,
      },
    });

    for await (const message of result) {
      // Look for the final JSON response
      if (message.type === 'assistant' && message.message) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              // Try to parse JSON from the response
              const jsonMatch = block.text.match(/\{[\s\S]*"type"[\s\S]*\}/);
              if (jsonMatch) {
                try {
                  action = JSON.parse(jsonMatch[0]) as BrowserAction;
                } catch {
                  // Continue looking for valid JSON
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Claude agent error:', error);
    action = { type: 'fail', reason: `Agent error: ${error}` };
  }

  return action;
}

/**
 * Execute a browser action returned by Claude
 */
export async function executeBrowserAction(
  page: Page,
  action: BrowserAction
): Promise<boolean> {
  console.log(`Executing action: ${action.type}`, action);

  try {
    switch (action.type) {
      case 'click':
        if (action.selector) {
          await page.click(action.selector, { timeout: 10000 });
        } else if (action.x !== undefined && action.y !== undefined) {
          await page.mouse.click(action.x, action.y);
        }
        break;

      case 'type':
        if (action.selector) {
          await page.fill(action.selector, action.text || '');
        } else {
          await page.keyboard.type(action.text || '');
        }
        break;

      case 'navigate':
        if (action.url) {
          await page.goto(action.url, { waitUntil: 'networkidle' });
        }
        break;

      case 'scroll':
        await page.mouse.wheel(0, 500);
        break;

      case 'wait':
        if (action.selector) {
          await page.waitForSelector(action.selector, { timeout: 10000 });
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
        break;

      case 'done':
        console.log('Task completed:', action.reason);
        return true;

      case 'fail':
        console.error('Task failed:', action.reason);
        return false;
    }

    return true;
  } catch (error) {
    console.error('Action execution failed:', error);
    return false;
  }
}

/**
 * Knowledge base for learned selectors
 * In production, this would be stored in a database
 */
const selectorKnowledge: Record<string, Record<string, string>> = {
  planhub: {
    loginEmail: 'input[type="email"]',
    loginPassword: 'input[type="password"]',
    loginSubmit: 'button[type="submit"]',
  },
  buildingconnected: {
    loginEmail: 'input[type="email"]',
    loginPassword: 'input[type="password"]',
    loginSubmit: 'button[type="submit"]',
  },
};

/**
 * Get known selector for a platform/action, or undefined if not known
 */
export function getKnownSelector(
  platform: string,
  action: string
): string | undefined {
  return selectorKnowledge[platform]?.[action];
}

/**
 * Save a learned selector to the knowledge base
 */
export function saveLearnedSelector(
  platform: string,
  action: string,
  selector: string
): void {
  if (!selectorKnowledge[platform]) {
    selectorKnowledge[platform] = {};
  }
  selectorKnowledge[platform][action] = selector;
  console.log(`Learned selector: ${platform}.${action} = ${selector}`);
}
