/**
 * Clarification Generator for Signage Extraction
 *
 * Generates actionable questions (RFI-style) for unresolved issues.
 * These help the estimator know what to verify with the architect/client.
 */

import type {
  SignageEntry,
  Discrepancy,
  Clarification,
  ClarificationPriority,
  ClarificationCategory,
} from './types';

// ============================================================================
// Clarification Templates
// ============================================================================

interface ClarificationTemplate {
  category: ClarificationCategory;
  priority: ClarificationPriority;
  questionTemplate: string;
  contextTemplate: string;
  suggestedRFITemplate?: string;
}

const DISCREPANCY_TEMPLATES: Record<string, ClarificationTemplate> = {
  count_mismatch: {
    category: 'quantity',
    priority: 'high',
    questionTemplate: 'Please verify the total sign count. {source1} indicates {count1} signs while {source2} shows {count2}.',
    contextTemplate: 'The door schedule and floor plans show different room counts. This may affect the total signage quantity.',
    suggestedRFITemplate: 'Request clarification on total room count for signage takeoff. Reference sheets {sheets}.',
  },
  missing_entry: {
    category: 'scope',
    priority: 'medium',
    questionTemplate: 'Are the following rooms in scope for signage? Found in {source2} but not {source1}: {entries}',
    contextTemplate: 'Some rooms appear in secondary sources but not in the primary source. Verify if they require signage.',
    suggestedRFITemplate: 'Confirm whether rooms {entries} require room identification signage per project scope.',
  },
  extra_entry: {
    category: 'scope',
    priority: 'medium',
    questionTemplate: 'Please confirm if {entries} require signage. Found in {source1} but not in {source2}.',
    contextTemplate: 'Some rooms in the primary source are not referenced elsewhere. May be out of scope or recently added.',
  },
  grouped_interpretation: {
    category: 'grouped_entry',
    priority: 'high',
    questionTemplate: 'Is "{groupedEntry}" a single sign or multiple individual signs?',
    contextTemplate: 'The door schedule shows "{groupedEntry}" as one entry. Confirm if this is one grouped sign or if each unit needs individual signage.',
    suggestedRFITemplate: 'Clarify signage requirements for grouped areas: Does "{groupedEntry}" receive one sign or individual signs per unit?',
  },
  duplicate_suspected: {
    category: 'quantity',
    priority: 'low',
    questionTemplate: 'Are "{entry1}" and "{entry2}" the same room? They appear similar.',
    contextTemplate: 'Two entries have very similar names and may be duplicates.',
  },
};

// ============================================================================
// Entry-Based Clarifications
// ============================================================================

/**
 * Generate clarifications for grouped entries.
 */
function clarifyGroupedEntries(entries: SignageEntry[]): Clarification[] {
  const clarifications: Clarification[] = [];
  const groupedEntries = entries.filter(e => e.isGrouped);

  for (const entry of groupedEntries) {
    if (entry.groupRange) {
      const [start, end] = entry.groupRange;
      const rangeSize = end - start + 1;

      if (rangeSize >= 3) {
        clarifications.push({
          priority: 'medium',
          category: 'grouped_entry',
          question: `"${entry.name}" spans units ${start}-${end}. Is this one shared sign or ${rangeSize} individual signs?`,
          context: `Door schedule shows this as a grouped entry. Industry standard is one sign for grouped bays/rooms, but verify client expectations.`,
          suggestedRFI: `Signage Clarification: Does "${entry.name}" require one (1) room identification sign or ${rangeSize} individual signs?`,
        });
      }
    }
  }

  return clarifications;
}

/**
 * Generate clarifications for entries missing room numbers.
 */
function clarifyMissingRoomNumbers(entries: SignageEntry[]): Clarification[] {
  const clarifications: Clarification[] = [];
  const missingNumbers = entries.filter(e => !e.roomNumber && e.confidence < 0.7);

  if (missingNumbers.length > 5) {
    const examples = missingNumbers.slice(0, 5).map(e => e.name).join(', ');
    clarifications.push({
      priority: 'low',
      category: 'specification',
      question: `Several rooms lack room numbers (e.g., ${examples}). Should room numbers be shown on signs?`,
      context: `${missingNumbers.length} entries don't have identifiable room numbers. This may affect sign text content.`,
    });
  }

  return clarifications;
}

/**
 * Generate clarifications for low-confidence entries.
 */
function clarifyLowConfidenceEntries(entries: SignageEntry[]): Clarification[] {
  const clarifications: Clarification[] = [];
  const lowConfidence = entries.filter(e => e.confidence < 0.5);

  if (lowConfidence.length > 0) {
    const names = lowConfidence.slice(0, 5).map(e => e.name).join(', ');
    clarifications.push({
      priority: 'medium',
      category: 'scope',
      question: `Please verify if the following require signage: ${names}${lowConfidence.length > 5 ? ` (and ${lowConfidence.length - 5} others)` : ''}`,
      context: 'These entries were extracted with lower confidence. Manual verification recommended.',
      suggestedRFI: 'Request room list from architect for signage scope verification.',
    });
  }

  return clarifications;
}

// ============================================================================
// Discrepancy-Based Clarifications
// ============================================================================

/**
 * Generate clarification from a discrepancy.
 */
function clarifyDiscrepancy(discrepancy: Discrepancy): Clarification | null {
  const template = DISCREPANCY_TEMPLATES[discrepancy.type];
  if (!template) {
    return null;
  }

  // Skip if already resolved
  if (discrepancy.resolution && discrepancy.autoResolvable) {
    return null;
  }

  // Build question from template
  let question = template.questionTemplate;
  let context = template.contextTemplate;
  let suggestedRFI = template.suggestedRFITemplate;

  // Replace placeholders
  const replacements: Record<string, string> = {
    source1: discrepancy.source1,
    source2: discrepancy.source2,
    count1: String(discrepancy.affectedEntries.length),
    count2: String(discrepancy.affectedEntries.length),
    entries: discrepancy.affectedEntries.slice(0, 3).map(e => e.name).join(', '),
    sheets: discrepancy.affectedEntries[0]?.sheetRefs.join(', ') || 'N/A',
    groupedEntry: discrepancy.affectedEntries[0]?.name || 'N/A',
    entry1: discrepancy.affectedEntries[0]?.name || 'N/A',
    entry2: discrepancy.affectedEntries[1]?.name || 'N/A',
  };

  for (const [key, value] of Object.entries(replacements)) {
    question = question.replace(`{${key}}`, value);
    context = context.replace(`{${key}}`, value);
    if (suggestedRFI) {
      suggestedRFI = suggestedRFI.replace(`{${key}}`, value);
    }
  }

  return {
    priority: template.priority,
    category: template.category,
    question,
    context,
    suggestedRFI,
  };
}

// ============================================================================
// Main Generator Function
// ============================================================================

/**
 * Generate clarifications for unresolved issues.
 *
 * @param entries - Final signage entries
 * @param discrepancies - Unresolved discrepancies
 * @returns Array of clarification questions
 */
export function generateClarifications(
  entries: SignageEntry[],
  discrepancies: Discrepancy[]
): Clarification[] {
  const clarifications: Clarification[] = [];

  // 1. Generate from discrepancies
  for (const d of discrepancies) {
    const clarification = clarifyDiscrepancy(d);
    if (clarification) {
      clarifications.push(clarification);
    }
  }

  // 2. Generate from entries
  clarifications.push(...clarifyGroupedEntries(entries));
  clarifications.push(...clarifyMissingRoomNumbers(entries));
  clarifications.push(...clarifyLowConfidenceEntries(entries));

  // 3. Sort by priority
  const priorityOrder: Record<ClarificationPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  clarifications.sort((a, b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority]
  );

  // 4. Deduplicate similar questions
  return deduplicateClarifications(clarifications);
}

/**
 * Remove duplicate or very similar clarifications.
 */
function deduplicateClarifications(
  clarifications: Clarification[]
): Clarification[] {
  const seen = new Set<string>();
  const unique: Clarification[] = [];

  for (const c of clarifications) {
    // Create a simplified key for comparison
    const key = `${c.category}-${c.question.slice(0, 50)}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  return unique;
}

// ============================================================================
// Formatting Functions
// ============================================================================

/**
 * Format clarifications for display.
 */
export function formatClarifications(clarifications: Clarification[]): string {
  if (clarifications.length === 0) {
    return 'No clarifications needed.';
  }

  const lines: string[] = [];
  lines.push(`=== Clarifications Needed (${clarifications.length}) ===\n`);

  let currentPriority: ClarificationPriority | null = null;

  for (const c of clarifications) {
    if (c.priority !== currentPriority) {
      currentPriority = c.priority;
      lines.push(`\n[${c.priority.toUpperCase()} PRIORITY]`);
    }

    lines.push(`\nQ: ${c.question}`);
    lines.push(`   Context: ${c.context}`);
    if (c.suggestedRFI) {
      lines.push(`   Suggested RFI: ${c.suggestedRFI}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get clarifications by priority.
 */
export function getClarificationsByPriority(
  clarifications: Clarification[],
  priority: ClarificationPriority
): Clarification[] {
  return clarifications.filter(c => c.priority === priority);
}

/**
 * Get clarifications by category.
 */
export function getClarificationsByCategory(
  clarifications: Clarification[],
  category: ClarificationCategory
): Clarification[] {
  return clarifications.filter(c => c.category === category);
}

/**
 * Generate RFI list from clarifications.
 */
export function generateRFIList(clarifications: Clarification[]): string[] {
  return clarifications
    .filter(c => c.suggestedRFI)
    .map(c => c.suggestedRFI!);
}

/**
 * Count clarifications by priority.
 */
export function countByPriority(
  clarifications: Clarification[]
): Record<ClarificationPriority, number> {
  return {
    high: clarifications.filter(c => c.priority === 'high').length,
    medium: clarifications.filter(c => c.priority === 'medium').length,
    low: clarifications.filter(c => c.priority === 'low').length,
  };
}
