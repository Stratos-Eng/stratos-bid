/**
 * Review Issue Formatting
 *
 * Utilities for formatting review issues for display.
 */

import type { ReviewIssue, IssuePriority } from './issue-types';

/**
 * Format a single issue for display
 */
export function formatIssue(issue: ReviewIssue): string {
  const priorityEmoji = getPriorityEmoji(issue.priority);
  const lines = [
    `${priorityEmoji} [${issue.priority.toUpperCase()}] ${issue.summary}`,
  ];

  if (issue.details) {
    lines.push(`   ${issue.details}`);
  }

  if (issue.affectedEntries.length > 0) {
    lines.push(`   Affected: ${issue.affectedEntries.join(', ')}`);
  }

  lines.push(`   Action: ${issue.suggestedAction}`);

  if (issue.suggestedRFI) {
    lines.push(`   RFI: "${issue.suggestedRFI}"`);
  }

  return lines.join('\n');
}

/**
 * Format multiple issues for display
 */
export function formatIssues(issues: ReviewIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found.';
  }

  const header = `Found ${issues.length} issue(s) requiring review:\n`;
  const formatted = issues.map((issue, i) => `${i + 1}. ${formatIssue(issue)}`);
  return header + formatted.join('\n\n');
}

/**
 * Format issues as markdown
 */
export function formatIssuesAsMarkdown(issues: ReviewIssue[]): string {
  if (issues.length === 0) {
    return '**No issues found.**';
  }

  const lines = [`## Review Issues (${issues.length})`, ''];

  // Group by priority
  const byPriority = groupByPriority(issues);

  for (const priority of ['high', 'medium', 'low'] as IssuePriority[]) {
    const priorityIssues = byPriority[priority];
    if (priorityIssues.length === 0) continue;

    lines.push(`### ${getPriorityLabel(priority)} Priority`);
    lines.push('');

    for (const issue of priorityIssues) {
      lines.push(`- **${issue.summary}**`);
      if (issue.details) {
        lines.push(`  - ${issue.details}`);
      }
      if (issue.affectedEntries.length > 0) {
        lines.push(`  - Affected: \`${issue.affectedEntries.join('`, `')}\``);
      }
      lines.push(`  - Action: ${issue.suggestedAction}`);
      if (issue.suggestedRFI) {
        lines.push(`  - Suggested RFI: *"${issue.suggestedRFI}"*`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format issues as JSON for API response
 */
export function formatIssuesAsJson(issues: ReviewIssue[]): object {
  return {
    totalIssues: issues.length,
    byPriority: {
      high: issues.filter((i) => i.priority === 'high').length,
      medium: issues.filter((i) => i.priority === 'medium').length,
      low: issues.filter((i) => i.priority === 'low').length,
    },
    issues: issues.map((issue) => ({
      id: issue.id,
      type: issue.type,
      priority: issue.priority,
      summary: issue.summary,
      details: issue.details,
      affectedEntries: issue.affectedEntries,
      suggestedAction: issue.suggestedAction,
      suggestedRFI: issue.suggestedRFI,
    })),
  };
}

/**
 * Generate a summary line for issues
 */
export function generateIssueSummary(issues: ReviewIssue[]): string {
  if (issues.length === 0) {
    return 'No issues - ready for review';
  }

  const high = issues.filter((i) => i.priority === 'high').length;
  const medium = issues.filter((i) => i.priority === 'medium').length;
  const low = issues.filter((i) => i.priority === 'low').length;

  const parts: string[] = [];
  if (high > 0) parts.push(`${high} high`);
  if (medium > 0) parts.push(`${medium} medium`);
  if (low > 0) parts.push(`${low} low`);

  return `${issues.length} issues: ${parts.join(', ')}`;
}

/**
 * Group issues by priority
 */
function groupByPriority(
  issues: ReviewIssue[]
): Record<IssuePriority, ReviewIssue[]> {
  return {
    high: issues.filter((i) => i.priority === 'high'),
    medium: issues.filter((i) => i.priority === 'medium'),
    low: issues.filter((i) => i.priority === 'low'),
  };
}

/**
 * Get emoji for priority level
 */
function getPriorityEmoji(priority: IssuePriority): string {
  switch (priority) {
    case 'high':
      return '!';
    case 'medium':
      return '?';
    case 'low':
      return '-';
  }
}

/**
 * Get human-readable label for priority
 */
function getPriorityLabel(priority: IssuePriority): string {
  switch (priority) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
  }
}
