/**
 * Review Issue Types
 *
 * Structured issue types for human review.
 * Instead of auto-resolving discrepancies, we surface them clearly.
 */

/**
 * Types of issues that require human review
 */
export type IssueType =
  | 'quantity_verification' // "Schedule says 45, plans show 42"
  | 'grouped_entry' // "BAY 1-5 - is this 1 sign or 5?"
  | 'scope_unclear' // "NIC mentioned but not consistent"
  | 'missing_from_schedule' // "Room 205 on plan, not in schedule"
  | 'duplicate_possible' // "RESTROOM A and RESTROOM A-1"
  | 'specification_needed' // "Sign type code not in legend"
  | 'source_conflict'; // "Door schedule and signage schedule disagree"

/**
 * Priority levels for review issues
 */
export type IssuePriority = 'high' | 'medium' | 'low';

/**
 * A review issue that needs human attention
 */
export interface ReviewIssue {
  id: string;
  type: IssueType;
  priority: IssuePriority;
  summary: string;
  details: string;
  affectedEntries: string[]; // Sign type codes or room numbers
  suggestedAction: string;
  suggestedRFI?: string;
  source?: string; // Which document triggered this
}

/**
 * Templates for common issue types
 */
export const ISSUE_TEMPLATES: Record<
  IssueType,
  {
    priority: IssuePriority;
    summaryTemplate: string;
    actionTemplate: string;
  }
> = {
  quantity_verification: {
    priority: 'high',
    summaryTemplate: 'Quantity discrepancy: {source1} shows {count1}, {source2} shows {count2}',
    actionTemplate: 'Verify count from authoritative source (usually schedule)',
  },
  grouped_entry: {
    priority: 'high',
    summaryTemplate: 'Grouped entry needs clarification: {entry}',
    actionTemplate: 'Confirm if this is one sign for the range or individual signs',
  },
  scope_unclear: {
    priority: 'medium',
    summaryTemplate: 'Scope unclear for: {entries}',
    actionTemplate: 'Verify if these items are in contract scope',
  },
  missing_from_schedule: {
    priority: 'medium',
    summaryTemplate: '{count} items on plans not found in schedule',
    actionTemplate: 'Confirm if these rooms/areas require signage',
  },
  duplicate_possible: {
    priority: 'low',
    summaryTemplate: 'Possible duplicates detected: {entries}',
    actionTemplate: 'Verify if these are the same or different signs',
  },
  specification_needed: {
    priority: 'low',
    summaryTemplate: 'Sign type {code} not defined in legend',
    actionTemplate: 'Request sign specification from architect',
  },
  source_conflict: {
    priority: 'high',
    summaryTemplate: 'Sources disagree: {source1} vs {source2}',
    actionTemplate: 'Determine authoritative source per scope of work',
  },
};

/**
 * Create a review issue from a template
 */
export function createIssue(
  type: IssueType,
  params: Record<string, string | number | string[]>,
  overrides?: Partial<ReviewIssue>
): ReviewIssue {
  const template = ISSUE_TEMPLATES[type];

  // Replace placeholders in templates
  let summary = template.summaryTemplate;
  let action = template.actionTemplate;

  for (const [key, value] of Object.entries(params)) {
    const placeholder = `{${key}}`;
    const valueStr = Array.isArray(value) ? value.join(', ') : String(value);
    summary = summary.replace(placeholder, valueStr);
    action = action.replace(placeholder, valueStr);
  }

  return {
    id: `issue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    priority: template.priority,
    summary,
    details: '',
    affectedEntries: Array.isArray(params.entries)
      ? params.entries
      : params.entry
        ? [String(params.entry)]
        : [],
    suggestedAction: action,
    ...overrides,
  };
}

/**
 * Create a quantity verification issue
 */
export function createQuantityIssue(
  source1: string,
  count1: number,
  source2: string,
  count2: number,
  affectedEntries: string[]
): ReviewIssue {
  return createIssue(
    'quantity_verification',
    { source1, count1, source2, count2, entries: affectedEntries },
    {
      details: `${source1} shows ${count1} total, but ${source2} shows ${count2}. Difference: ${Math.abs(count1 - count2)}`,
      suggestedRFI: `Please clarify the correct quantity for signage. ${source1} indicates ${count1} signs while ${source2} shows ${count2}.`,
    }
  );
}

/**
 * Create a grouped entry issue
 */
export function createGroupedEntryIssue(
  entry: string,
  rangeStart: number,
  rangeEnd: number
): ReviewIssue {
  const rangeSize = rangeEnd - rangeStart + 1;
  return createIssue(
    'grouped_entry',
    { entry, entries: [entry] },
    {
      details: `"${entry}" could mean 1 sign for rooms ${rangeStart}-${rangeEnd}, or ${rangeSize} individual signs.`,
      suggestedRFI: `Please clarify signage for "${entry}": Is this one sign covering the range, or ${rangeSize} individual room signs?`,
    }
  );
}

/**
 * Create a scope unclear issue
 */
export function createScopeIssue(entries: string[], reason: string): ReviewIssue {
  return createIssue(
    'scope_unclear',
    { entries },
    {
      details: reason,
      suggestedRFI: `Please clarify if the following items are included in the signage scope: ${entries.join(', ')}`,
    }
  );
}

/**
 * Sort issues by priority (high first)
 */
export function sortIssuesByPriority(issues: ReviewIssue[]): ReviewIssue[] {
  const priorityOrder: Record<IssuePriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return [...issues].sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
  );
}
