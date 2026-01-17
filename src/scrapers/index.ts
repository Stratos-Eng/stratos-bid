export { BaseScraper, type ScraperConfig, type ScrapedBid, type ScrapedDocument } from './base';
export { BuildingConnectedScraper } from './buildingconnected';
export { GmailScanner } from './gmail';
export { PlanetBidsScraper, KNOWN_CA_PORTALS, DISCOVERY_RANGES } from './planetbids';

import { BaseScraper, ScraperConfig } from './base';
import { BuildingConnectedScraper } from './buildingconnected';
import { GmailScanner } from './gmail';
import { PlanetBidsScraper } from './planetbids';

export type Platform = 'buildingconnected' | 'gmail' | 'planetbids';

export type ScraperInstance = BuildingConnectedScraper | PlanetBidsScraper;
export type ScannerInstance = GmailScanner;

/**
 * Factory function to create the appropriate scraper for a platform
 * Note: Gmail uses GmailScanner (not a scraper)
 * Note: PlanetBids requires a portalId, use createPlanetBidsScraper instead
 */
export function createScraper(
  platform: Exclude<Platform, 'gmail' | 'planetbids'>,
  config: Omit<ScraperConfig, 'platform'>
): BuildingConnectedScraper {
  switch (platform) {
    case 'buildingconnected':
      return new BuildingConnectedScraper(config);
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

/**
 * Create a PlanetBids scraper for a specific portal
 */
export function createPlanetBidsScraper(
  portalId: string,
  config: Omit<ScraperConfig, 'platform'>
): PlanetBidsScraper {
  return new PlanetBidsScraper({ ...config, portalId });
}

/**
 * Create a Gmail scanner instance
 */
export function createGmailScanner(config: { connectionId: string; userId: string }): GmailScanner {
  return new GmailScanner(config);
}

/**
 * Check if a platform uses browser-based scraping
 */
export function usesBrowserScraping(platform: Platform): boolean {
  return platform === 'buildingconnected' || platform === 'planetbids';
}

/**
 * Get all supported platforms
 */
export function getSupportedPlatforms(): Platform[] {
  return ['buildingconnected', 'gmail', 'planetbids'];
}

/**
 * Get platforms that require password authentication
 */
export function getPasswordPlatforms(): Platform[] {
  return ['buildingconnected'];
}

/**
 * Get platforms that use OAuth authentication
 */
export function getOAuthPlatforms(): Platform[] {
  return ['gmail'];
}

/**
 * Get platforms that use vendor registration (no login required)
 */
export function getRegistrationPlatforms(): Platform[] {
  return ['planetbids'];
}
