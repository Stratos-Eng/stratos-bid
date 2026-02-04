/**
 * Signage Trade Patterns (Division 10)
 *
 * Pattern library for signage extraction covering:
 * - Generic healthcare/commercial codes (TS, RR, RS, EX, WS, etc.)
 * - Metro/Transit codes (D7-D12, P1-P15)
 */

import type { TradePatterns } from './types';

export const SIGNAGE_PATTERNS: TradePatterns = {
  tradeCode: 'division_10',
  displayName: 'Division 10 - Signage',

  // Folder keywords for document scoring (100 = perfect match)
  folderKeywords: [
    'signage',
    'signs',
    'division 10',
    '10d',
    '10d1',
    'graphics',
    'wayfinding',
    'ada signage',
  ],

  // File keywords for document scoring
  // Higher in list = higher priority when scores are equal
  fileKeywords: [
    // Highest priority - actual sign data (schedules, series docs)
    'd series',
    'p series',
    'd-series',
    'p-series',
    'sign schedule',
    'signage schedule',
    'sign legend',
    'signage legend',
    // High priority - exhibit documents with signage data
    'exhibit a',
    'signage',
    // Medium priority - related schedules
    'door schedule',
    'room schedule',
    'finish schedule',
    'site plan',
    'floor plan',
  ],

  // Content patterns for detecting signage documents
  // Ordered by confidence (highest first)
  contentPatterns: [
    // Highest confidence (0.95) - Dedicated signage documents
    {
      pattern: /sign\s*(?:age)?\s*legend/i,
      confidence: 0.95,
      description: 'Sign legend found',
    },
    {
      pattern: /signage\s*schedule/i,
      confidence: 0.95,
      description: 'Signage schedule found',
    },
    {
      pattern: /sign\s*type\s*(?:code)?\s*description/i,
      confidence: 0.95,
      description: 'Sign type table found',
    },
    {
      pattern: /sign\s*(?:age)?\s*symbols/i,
      confidence: 0.95,
      description: 'Signage symbols found',
    },

    // High confidence (0.85) - Specific sign terminology
    {
      pattern: /room\s*identification\s*sign/i,
      confidence: 0.85,
      description: 'Room ID signs mentioned',
    },
    {
      pattern: /tactile\s*sign/i,
      confidence: 0.85,
      description: 'Tactile signs mentioned',
    },
    {
      pattern: /ada\s*sign(?:age)?/i,
      confidence: 0.85,
      description: 'ADA signage mentioned',
    },
    {
      pattern: /braille\s*sign/i,
      confidence: 0.85,
      description: 'Braille signs mentioned',
    },
    {
      pattern: /wayfinding\s*sign/i,
      confidence: 0.85,
      description: 'Wayfinding signs mentioned',
    },

    // High confidence (0.90) - Metro/Transit D-Series patterns
    {
      pattern: /\d+\.D\d{1,2}\.\d+/,
      confidence: 0.90,
      description: 'Metro D-series callouts found',
    },
    {
      pattern: /\d+\.P\d{1,2}\.\d+/,
      confidence: 0.90,
      description: 'Metro P-series callouts found',
    },
    {
      pattern: /monument\s*identification\s*sign/i,
      confidence: 0.85,
      description: 'Monument sign mentioned',
    },
    {
      pattern: /vehicular\s*directional/i,
      confidence: 0.85,
      description: 'Vehicular directional sign mentioned',
    },
    {
      pattern: /pedestrian\s*directional/i,
      confidence: 0.85,
      description: 'Pedestrian directional sign mentioned',
    },
    {
      pattern: /hazmat\s*storage/i,
      confidence: 0.85,
      description: 'Hazmat storage sign mentioned',
    },
    {
      pattern: /ev\s*(?:charging|parking)/i,
      confidence: 0.80,
      description: 'EV charging/parking sign mentioned',
    },

    // Medium confidence (0.70) - Related schedules
    {
      pattern: /door\s*schedule/i,
      confidence: 0.7,
      description: 'Door schedule (may have room names)',
    },
    {
      pattern: /symbol\s*legend/i,
      confidence: 0.7,
      description: 'Symbol legend found',
    },
    {
      pattern: /room\s*(?:finish\s*)?schedule/i,
      confidence: 0.7,
      description: 'Room schedule found',
    },

    // Lower confidence (0.50) - Floor plans may have room tags
    {
      pattern: /floor\s*plan/i,
      confidence: 0.5,
      description: 'Floor plan (may have room tags)',
    },
    {
      pattern: /site\s*plan/i,
      confidence: 0.5,
      description: 'Site plan (may have exterior signs)',
    },
  ],

  // Sign type codes for extraction
  // Includes BOTH generic (healthcare/commercial) AND Metro patterns
  signTypeCodes: [
    // Generic healthcare/commercial codes
    { prefix: 'TS', examples: ['TS-01', 'TS-02', 'TS-03'], description: 'Tactile Sign' },
    { prefix: 'RR', examples: ['RR-01', 'RR-02'], description: 'Restroom Sign' },
    { prefix: 'RS', examples: ['RS-01', 'RS-02'], description: 'Room Sign' },
    { prefix: 'EX', examples: ['EX-01', 'EX-02'], description: 'Exit Sign' },
    { prefix: 'WS', examples: ['WS-01', 'WS-02'], description: 'Wayfinding Sign' },
    { prefix: 'DS', examples: ['DS-01', 'DS-02'], description: 'Directory Sign' },
    { prefix: 'IS', examples: ['IS-01', 'IS-02'], description: 'ISA/Accessible Sign' },
    { prefix: 'PS', examples: ['PS-01', 'PS-02'], description: 'Parking Sign' },
    { prefix: 'FA', examples: ['FA-01', 'FA-02'], description: 'Fire Alarm Sign' },
    { prefix: 'FE', examples: ['FE-01', 'FE-02'], description: 'Fire Extinguisher Sign' },
    { prefix: 'SP', examples: ['SP-01', 'SP-02'], description: 'Signage Panel' },

    // Metro/Transit D-Series (Display & Environmental Graphics)
    { prefix: 'D7', examples: ['D7', 'D7.1'], description: 'Monument Identification Signage' },
    { prefix: 'D8', examples: ['D8', 'D8.1'], description: 'Wall Mounted Entrance Signage' },
    { prefix: 'D9', examples: ['D9', 'D9.1', 'D9.4'], description: 'Vehicular Directional Signage' },
    { prefix: 'D10', examples: ['D10', 'D10.1'], description: 'Pedestrian Directional Signage' },
    { prefix: 'D11', examples: ['D11', 'D11.1'], description: 'Hazmat Storage Signage' },
    { prefix: 'D12', examples: ['D12', 'D12.1'], description: 'Delivery Entrance Only Signage' },

    // Metro/Transit P-Series (Parking & Site Signage)
    { prefix: 'P1', examples: ['P1', 'P1.1'], description: 'Accessible Identification' },
    { prefix: 'P2', examples: ['P2', 'P2.1'], description: 'ADA Van Accessible' },
    { prefix: 'P3', examples: ['P3', 'P3.1'], description: 'EV Parking Identification' },
    { prefix: 'P4', examples: ['P4', 'P4.1'], description: 'Accessible EV Identification' },
    { prefix: 'P6', examples: ['P6', 'P6.1'], description: 'Visitor Parking' },
    { prefix: 'P7', examples: ['P7', 'P7.1'], description: 'Loading Dock Identification' },
    { prefix: 'P8', examples: ['P8', 'P8.1', 'P8.7'], description: 'Metro Reserved Parking' },
    { prefix: 'P12', examples: ['P12', 'P12.1'], description: 'Tow Away Sign' },
    { prefix: 'P13', examples: ['P13', 'P13.1'], description: 'EV Charging Hours' },
    { prefix: 'P14', examples: ['P14', 'P14.1'], description: 'No Parking Except EV Charging' },
    { prefix: 'P15', examples: ['P15', 'P15.1'], description: 'EV Charging Station Tow-away' },

    // Metro C-Series (Code & Regulatory) - quantity TBD per AHJ
    { prefix: 'C', examples: ['C1', 'C2'], description: 'Code & Regulatory Signage' },
  ],

  // Exclusion patterns - skip these items
  exclusions: [
    'NIC',
    'N.I.C.',
    'NOT IN CONTRACT',
    'BY OTHERS',
    'BY OWNER',
    'BY LANDLORD',
    'DEMO',
    'DEMOLITION',
    'EXISTING',
    'EX.',
    'FUTURE',
    'PHASE 2',
    'PHASE 3',
    'PHASE II',
    'PHASE III',
    'FURNISHED BY OWNER',
    'FBO',
    'OWNER FURNISHED',
    'AS BUILT',
    'REMOVE',
    'RELOCATE',
  ],
};

/**
 * Check if text matches any exclusion pattern
 */
export function isExcluded(text: string): boolean {
  const upper = text.toUpperCase();
  return SIGNAGE_PATTERNS.exclusions.some((ex) => upper.includes(ex));
}

/**
 * Extract sign type code from text
 * Returns the matched prefix and full code, or null if no match
 */
export function extractSignTypeCode(
  text: string
): { prefix: string; code: string; description: string } | null {
  const upper = text.toUpperCase().trim();

  for (const pattern of SIGNAGE_PATTERNS.signTypeCodes) {
    // Try exact prefix match with optional dash/space and number
    const regex = new RegExp(`^(${pattern.prefix})[-\\s]?(\\d{1,2})?(\\.\\d+)?$`, 'i');
    const match = upper.match(regex);

    if (match) {
      return {
        prefix: pattern.prefix,
        code: match[0].replace(/\s/g, '-'),
        description: pattern.description,
      };
    }
  }

  return null;
}

/**
 * Get content detection confidence for text
 * Returns highest matching confidence, or 0 if no match
 */
export function getContentConfidence(text: string): number {
  let maxConfidence = 0;

  for (const pattern of SIGNAGE_PATTERNS.contentPatterns) {
    if (pattern.pattern.test(text)) {
      maxConfidence = Math.max(maxConfidence, pattern.confidence);
    }
  }

  return maxConfidence;
}
