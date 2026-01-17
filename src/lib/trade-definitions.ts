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
      // General signage
      'signage', 'sign', 'signs', 'sign schedule', 'sign legend',
      // Exterior/architectural
      'wayfinding', 'monument sign', 'channel letter', 'channel letters',
      'directory', 'pylon', 'illuminated sign', 'dimensional letter',
      'marquee', 'canopy sign', 'blade sign', 'projecting sign', 'wall sign',
      // ADA/accessibility
      'ada sign', 'ada signage', 'tactile', 'braille',
      'raised character', 'raised letter', 'accessible sign',
      'wheelchair sign', 'isa sign', 'accessibility sign',
      // Room/door identification
      'room identification', 'door sign', 'room sign', 'room number sign',
      // Restroom-specific
      'restroom sign', 'toilet sign', 'lavatory sign', 'gender neutral',
      // Exit/egress
      'exit sign', 'emergency exit', 'egress sign', 'evacuation',
      'exit route', 'exit stair',
      // Fire safety
      'fire extinguisher', 'extinguisher cabinet', 'fire alarm',
      'pull station', 'facp', 'alarm panel', 'sprinkler riser',
      // Regulatory/compliance
      'no smoking', 'smoke free', 'occupancy sign', 'capacity sign',
      'max occupant', 'regulatory sign', 'emergency sign',
      // Warning/safety
      'warning sign', 'caution sign', 'danger sign', 'hazard sign',
      // Parking/traffic
      'parking sign', 'traffic sign', 'no parking', 'fire lane',
      'reserved parking', 'van accessible', 'tow away',
      // Building identification
      'building sign', 'building identification',
    ],
    categories: [
      // Interior signage
      'Room/Door Identification',
      'Restroom Signs',
      'ADA/Tactile Signs',
      'Exit Signs',
      'Wayfinding/Directional',
      'Directory Signs',
      // Safety/compliance
      'Fire Safety Signs',
      'Evacuation Signs',
      'Warning/Safety Signs',
      'No Smoking Signs',
      'Occupancy Signs',
      'Compliance/Regulatory Signs',
      // Exterior signage
      'Monument Signs',
      'Channel Letters',
      'Pylon Signs',
      'Illuminated Signs',
      'Building Identification',
      // Parking/site
      'Parking/Traffic Signs',
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
