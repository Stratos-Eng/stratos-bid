/**
 * Trade definitions for specialty subcontractors
 * Based on CSI MasterFormat divisions
 */

export const TRADE_DEFINITIONS = {
  division_08: {
    code: 'division_08',
    name: 'Glazing',
    displayName: 'Division 08 - Openings (Glazing)',
    csiSections: ['08 40 00', '08 44 00', '08 80 00', '08 88 00', '08 41 00', '08 43 00', '08 45 00'],
    keywords: [
      'glazing', 'glass', 'window', 'curtain wall', 'storefront',
      'skylight', 'aluminum frame', 'vision glass', 'spandrel',
      'insulated glass', 'laminated glass', 'tempered glass',
      'entrance door', 'automatic door', 'revolving door',
      'glass partition', 'glass railing', 'mirror',
      'low-e', 'low e', 'double pane', 'triple pane',
    ],
    categories: [
      'Storefront Systems',
      'Curtain Wall Systems',
      'Windows - Fixed',
      'Windows - Operable',
      'Windows - Specialty',
      'Glass Doors & Entrances',
      'Automatic Entrances',
      'Skylights',
      'Glass Railings',
      'Architectural Mirrors',
      'Glass Partitions',
      'Glazing Accessories',
    ],
  },
  division_10: {
    code: 'division_10',
    name: 'Signage',
    displayName: 'Division 10 - Specialties (Signage)',
    csiSections: ['10 14 00', '10 14 19', '10 14 23', '10 14 26', '10 14 53'],
    keywords: [
      'signage', 'sign', 'signs', 'wayfinding', 'monument sign',
      'channel letter', 'channel letters', 'ada sign', 'ada signage',
      'directory', 'pylon', 'illuminated sign', 'tactile',
      'braille', 'room identification', 'door sign',
      'exit sign', 'emergency sign', 'regulatory sign',
      'parking sign', 'traffic sign', 'building sign',
      'dimensional letter', 'marquee', 'canopy sign',
      'blade sign', 'projecting sign', 'wall sign',
    ],
    categories: [
      'Room/Door Identification',
      'Exit Signs',
      'ADA/Tactile Signs',
      'Wayfinding/Directional',
      'Compliance/Safety Signs',
      'Monument Signs',
      'Channel Letters',
      'Directory Signs',
      'Pylon Signs',
      'Illuminated Signs',
      'Parking/Traffic Signs',
      'Building Identification',
    ],
  },
} as const;

export type TradeCode = keyof typeof TRADE_DEFINITIONS;

export function getTradeDefinition(code: TradeCode) {
  return TRADE_DEFINITIONS[code];
}

export function getAllTrades() {
  return Object.values(TRADE_DEFINITIONS);
}

export function getTradeByKeyword(text: string): TradeCode | null {
  const lowerText = text.toLowerCase();

  for (const [code, trade] of Object.entries(TRADE_DEFINITIONS)) {
    if (trade.keywords.some(kw => lowerText.includes(kw))) {
      return code as TradeCode;
    }
  }

  return null;
}

export function filterBidsByTrade(
  bids: Array<{ title: string; description?: string | null }>,
  trades: TradeCode[]
): typeof bids {
  return bids.filter(bid => {
    const searchText = `${bid.title} ${bid.description || ''}`.toLowerCase();

    for (const trade of trades) {
      const def = TRADE_DEFINITIONS[trade];
      if (def.keywords.some(kw => searchText.includes(kw))) {
        return true;
      }
    }

    return false;
  });
}
