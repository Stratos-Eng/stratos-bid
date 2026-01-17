/**
 * Room Counting for Signage Quantity Estimation
 *
 * Extracts and counts room types from floor plan text to estimate
 * tactile sign quantities (e.g., 5 restrooms → 5 restroom signs).
 */

import { ParsedPage } from '../pdf-parser';

export interface RoomCount {
  type: string;           // e.g., "RESTROOM", "OFFICE", "GNRR"
  category: string;       // Normalized category for signage
  count: number;          // Number of unique rooms
  roomNumbers: string[];  // List of room numbers found
  pages: number[];        // Pages where found
}

export interface RoomCountResult {
  totalRooms: number;
  counts: RoomCount[];
  signageEstimates: SignageEstimate[];
}

export interface SignageEstimate {
  signType: string;       // e.g., "Restroom Signs", "Room ID Signs"
  estimatedQty: number;
  basedOn: string;        // e.g., "5 GNRR rooms found"
  confidence: number;     // 0-1
}

// Room type patterns with their signage implications
const ROOM_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  category: string;
  signTypes: string[];
}> = [
  {
    // Gender-neutral restroom: "GNRR 105" or "GNRR"
    pattern: /\bGNRR\s*(\d{2,4})?/gi,
    type: 'GNRR',
    category: 'Restroom',
    signTypes: ['Restroom Signs', 'ADA/Tactile Signs'],
  },
  {
    // Restroom with number: "116 RESTROOM" or "RESTROOM 116"
    pattern: /(?:(\d{2,4})\s+RESTROOM|RESTROOM\s+(\d{2,4}))/gi,
    type: 'RESTROOM',
    category: 'Restroom',
    signTypes: ['Restroom Signs', 'ADA/Tactile Signs'],
  },
  {
    // Men's/Women's restroom
    pattern: /(?:MEN'?S?|WOMEN'?S?)\s*(?:RESTROOM|TOILET|LAVATORY)\s*(\d{2,4})?/gi,
    type: 'RESTROOM',
    category: 'Restroom',
    signTypes: ['Restroom Signs', 'ADA/Tactile Signs'],
  },
  {
    // Office with number: "201 OFFICE" or "OFFICE 201"
    pattern: /(?:(\d{2,4})\s+OFFICE|OFFICE\s+(\d{2,4}))/gi,
    type: 'OFFICE',
    category: 'Office',
    signTypes: ['Room/Door Identification', 'ADA/Tactile Signs'],
  },
  {
    // Conference room
    pattern: /(?:(\d{2,4})\s+)?CONFERENCE\s*(?:ROOM)?\s*(\d{2,4})?/gi,
    type: 'CONFERENCE',
    category: 'Conference',
    signTypes: ['Room/Door Identification', 'ADA/Tactile Signs'],
  },
  {
    // Storage room
    pattern: /(?:(\d{2,4})\s+STORAGE|STORAGE\s+(\d{2,4}))/gi,
    type: 'STORAGE',
    category: 'Storage',
    signTypes: ['Room/Door Identification'],
  },
  {
    // Electrical room
    pattern: /(?:(\d{2,4})\s+)?(?:ELEC(?:TRICAL)?\.?\s*(?:RM|ROOM)?)\s*(\d{2,4})?/gi,
    type: 'ELECTRICAL',
    category: 'Utility',
    signTypes: ['Room/Door Identification'],
  },
  {
    // Mechanical room
    pattern: /(?:(\d{2,4})\s+)?(?:MECH(?:ANICAL)?\.?\s*(?:RM|ROOM)?)\s*(\d{2,4})?/gi,
    type: 'MECHANICAL',
    category: 'Utility',
    signTypes: ['Room/Door Identification'],
  },
  {
    // Shop
    pattern: /(?:(\d{2,4})\s+SHOP|SHOP\s+(\d{2,4}))/gi,
    type: 'SHOP',
    category: 'Work Area',
    signTypes: ['Room/Door Identification'],
  },
  {
    // Maintenance
    pattern: /(?:(\d{2,4})\s+MAINTENANCE|MAINTENANCE\s+(\d{2,4}))/gi,
    type: 'MAINTENANCE',
    category: 'Work Area',
    signTypes: ['Room/Door Identification'],
  },
  {
    // Break room / Lunch room
    pattern: /(?:(\d{2,4})\s+)?(?:BREAK|LUNCH)\s*ROOM\s*(\d{2,4})?/gi,
    type: 'BREAK ROOM',
    category: 'Common Area',
    signTypes: ['Room/Door Identification', 'ADA/Tactile Signs'],
  },
  {
    // Lobby
    pattern: /(?:(\d{2,4})\s+)?LOBBY\s*(\d{2,4})?/gi,
    type: 'LOBBY',
    category: 'Common Area',
    signTypes: ['Room/Door Identification', 'Wayfinding/Directional'],
  },
  {
    // Stairwell
    pattern: /(?:STAIR(?:WELL)?|STAIR\s*\d+)\s*(\d{2,4})?/gi,
    type: 'STAIR',
    category: 'Egress',
    signTypes: ['Exit Signs', 'ADA/Tactile Signs'],
  },
  {
    // Elevator
    pattern: /(?:ELEVATOR|ELEV\.?)\s*(\d{1,2})?/gi,
    type: 'ELEVATOR',
    category: 'Egress',
    signTypes: ['ADA/Tactile Signs', 'Evacuation Signs'],
  },
];

/**
 * Extract room number from regex match groups
 */
function extractRoomNumber(match: RegExpMatchArray): string | null {
  // Check all capture groups for a number
  for (let i = 1; i < match.length; i++) {
    if (match[i] && /^\d{2,4}$/.test(match[i])) {
      return match[i];
    }
  }
  return null;
}

/**
 * Count rooms of each type from page text
 */
export function countRoomsOnPage(
  pageText: string,
  pageNumber: number
): Map<string, { roomNumbers: Set<string>; pages: Set<number> }> {
  const results = new Map<string, { roomNumbers: Set<string>; pages: Set<number> }>();

  for (const { pattern, type } of ROOM_PATTERNS) {
    const matches = pageText.matchAll(new RegExp(pattern.source, pattern.flags));

    for (const match of matches) {
      if (!results.has(type)) {
        results.set(type, { roomNumbers: new Set(), pages: new Set() });
      }

      const data = results.get(type)!;
      data.pages.add(pageNumber);

      const roomNum = extractRoomNumber(match);
      if (roomNum) {
        data.roomNumbers.add(roomNum);
      } else {
        // If no room number, count the occurrence with a generated ID
        data.roomNumbers.add(`_${type}_${match.index}`);
      }
    }
  }

  return results;
}

/**
 * Main function: Count all room types across pages
 */
export function countRooms(pages: ParsedPage[]): RoomCountResult {
  // Aggregate across all pages
  const aggregated = new Map<string, { roomNumbers: Set<string>; pages: Set<number> }>();

  for (const page of pages) {
    const pageCounts = countRoomsOnPage(page.text, page.pageNumber);

    for (const [type, data] of pageCounts) {
      if (!aggregated.has(type)) {
        aggregated.set(type, { roomNumbers: new Set(), pages: new Set() });
      }

      const agg = aggregated.get(type)!;
      for (const roomNum of data.roomNumbers) {
        // Only add real room numbers (not generated IDs) to avoid over-counting
        if (!roomNum.startsWith('_')) {
          agg.roomNumbers.add(roomNum);
        }
      }
      for (const pageNum of data.pages) {
        agg.pages.add(pageNum);
      }
    }
  }

  // Build result
  const counts: RoomCount[] = [];
  let totalRooms = 0;

  for (const [type, data] of aggregated) {
    const patternDef = ROOM_PATTERNS.find(p => p.type === type);
    const count = data.roomNumbers.size;

    if (count > 0) {
      counts.push({
        type,
        category: patternDef?.category || 'Other',
        count,
        roomNumbers: Array.from(data.roomNumbers).sort(),
        pages: Array.from(data.pages).sort((a, b) => a - b),
      });
      totalRooms += count;
    }
  }

  // Sort by count descending
  counts.sort((a, b) => b.count - a.count);

  // Generate signage estimates
  const signageEstimates = generateSignageEstimates(counts);

  return {
    totalRooms,
    counts,
    signageEstimates,
  };
}

/**
 * Generate signage quantity estimates based on room counts
 */
function generateSignageEstimates(counts: RoomCount[]): SignageEstimate[] {
  const estimates: SignageEstimate[] = [];

  // Restroom signs: count of restroom-type rooms
  const restroomCounts = counts.filter(c => c.category === 'Restroom');
  if (restroomCounts.length > 0) {
    const total = restroomCounts.reduce((sum, c) => sum + c.count, 0);
    estimates.push({
      signType: 'Restroom Signs',
      estimatedQty: total,
      basedOn: `${total} restroom(s) found: ${restroomCounts.map(c => `${c.count} ${c.type}`).join(', ')}`,
      confidence: 0.8,
    });
  }

  // Room ID / Tactile signs: all rooms except utility
  const roomIdCounts = counts.filter(c => c.category !== 'Utility' && c.category !== 'Egress');
  if (roomIdCounts.length > 0) {
    const total = roomIdCounts.reduce((sum, c) => sum + c.count, 0);
    estimates.push({
      signType: 'Room/Door Identification',
      estimatedQty: total,
      basedOn: `${total} rooms requiring ID signs`,
      confidence: 0.6, // Lower confidence - may not all need signs
    });
  }

  // ADA/Tactile: restrooms + public spaces
  const adaRooms = counts.filter(c =>
    c.category === 'Restroom' ||
    c.category === 'Common Area' ||
    c.category === 'Conference'
  );
  if (adaRooms.length > 0) {
    const total = adaRooms.reduce((sum, c) => sum + c.count, 0);
    estimates.push({
      signType: 'ADA/Tactile Signs',
      estimatedQty: total,
      basedOn: `${total} ADA-accessible spaces identified`,
      confidence: 0.7,
    });
  }

  // Exit signs: stairs + elevators (rough estimate)
  const egressCounts = counts.filter(c => c.category === 'Egress');
  if (egressCounts.length > 0) {
    const stairCount = counts.find(c => c.type === 'STAIR')?.count || 0;
    // Estimate: ~2-3 exit signs per stair
    const exitEstimate = stairCount * 2;
    if (exitEstimate > 0) {
      estimates.push({
        signType: 'Exit Signs',
        estimatedQty: exitEstimate,
        basedOn: `${stairCount} stairwell(s) × ~2 signs each`,
        confidence: 0.5, // Low confidence - needs floor plan review
      });
    }
  }

  return estimates;
}

/**
 * Get room count for a specific category
 */
export function getRoomCountByCategory(
  result: RoomCountResult,
  category: string
): number {
  return result.counts
    .filter(c => c.category === category)
    .reduce((sum, c) => sum + c.count, 0);
}

/**
 * Quick estimate of tactile sign quantity
 */
export function estimateTactileSigns(result: RoomCountResult): number {
  // Tactile signs typically needed for:
  // - All restrooms
  // - Offices and conference rooms
  // - Common areas
  // - Stairs and elevators

  const categories = ['Restroom', 'Office', 'Conference', 'Common Area', 'Egress'];
  return result.counts
    .filter(c => categories.includes(c.category))
    .reduce((sum, c) => sum + c.count, 0);
}
