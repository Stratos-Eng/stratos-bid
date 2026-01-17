/**
 * Extraction Plugin Registry
 *
 * Central registration point for all extraction plugins.
 * Plugins register here and can be queried by trade code.
 */

import type { ExtractionPlugin, PluginMetadata } from './types';
import type { TradeCode } from '@/lib/trade-definitions';

class PluginRegistry {
  private plugins: Map<string, ExtractionPlugin> = new Map();

  /**
   * Register a plugin
   */
  register(plugin: ExtractionPlugin): void {
    if (this.plugins.has(plugin.id)) {
      console.warn(`Plugin ${plugin.id} is already registered, overwriting`);
    }
    this.plugins.set(plugin.id, plugin);
    console.log(`[PluginRegistry] Registered plugin: ${plugin.id} (${plugin.name})`);
  }

  /**
   * Get a plugin by ID
   */
  get(id: string): ExtractionPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get all plugins for a specific trade, sorted by priority
   */
  getByTrade(tradeCode: TradeCode): ExtractionPlugin[] {
    const matches: ExtractionPlugin[] = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.tradeCode === tradeCode) {
        matches.push(plugin);
      }
    }

    // Sort by priority (higher first)
    return matches.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all registered plugins
   */
  getAll(): ExtractionPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get metadata for all plugins (without loading full implementations)
   */
  getMetadata(): PluginMetadata[] {
    return Array.from(this.plugins.values()).map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      tradeCode: plugin.tradeCode,
      priority: plugin.priority,
      hasPreProcess: !!plugin.preProcess,
    }));
  }

  /**
   * Check if a plugin is registered
   */
  has(id: string): boolean {
    return this.plugins.has(id);
  }

  /**
   * Get count of registered plugins
   */
  get count(): number {
    return this.plugins.size;
  }
}

// Singleton instance
export const pluginRegistry = new PluginRegistry();

/**
 * Decorator-style function to register a plugin
 */
export function registerPlugin(plugin: ExtractionPlugin): ExtractionPlugin {
  pluginRegistry.register(plugin);
  return plugin;
}
