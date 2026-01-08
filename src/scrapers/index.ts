export { BaseScraper, type ScraperConfig, type ScrapedBid, type ScrapedDocument } from './base';
export { PlanHubScraper } from './planhub';
export { BuildingConnectedScraper } from './buildingconnected';
export { GmailScanner } from './gmail';

import { BaseScraper, ScraperConfig } from './base';
import { PlanHubScraper } from './planhub';
import { BuildingConnectedScraper } from './buildingconnected';
import { GmailScanner } from './gmail';

export type Platform = 'planhub' | 'buildingconnected' | 'gmail' | 'planetbids';

export type ScraperInstance = PlanHubScraper | BuildingConnectedScraper;
export type ScannerInstance = GmailScanner;

/**
 * Factory function to create the appropriate scraper for a platform
 * Note: Gmail uses GmailScanner (not a scraper) and PlanetBids is not yet implemented
 */
export function createScraper(
  platform: Exclude<Platform, 'gmail' | 'planetbids'>,
  config: Omit<ScraperConfig, 'platform'>
): ScraperInstance {
  switch (platform) {
    case 'planhub':
      return new PlanHubScraper(config);
    case 'buildingconnected':
      return new BuildingConnectedScraper(config);
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
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
  return platform === 'planhub' || platform === 'buildingconnected' || platform === 'planetbids';
}

/**
 * Get all supported platforms
 */
export function getSupportedPlatforms(): Platform[] {
  return ['planhub', 'buildingconnected', 'gmail'];
}

/**
 * Get platforms that require password authentication
 */
export function getPasswordPlatforms(): Platform[] {
  return ['planhub', 'buildingconnected'];
}

/**
 * Get platforms that use OAuth authentication
 */
export function getOAuthPlatforms(): Platform[] {
  return ['gmail'];
}
