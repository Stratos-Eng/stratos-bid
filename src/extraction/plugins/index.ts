/**
 * Extraction Plugin System - Main Entry Point
 *
 * This module provides a plugin-based architecture for document extraction.
 * Trade-specific plugins (signage, glazing, etc.) can be added without
 * modifying core extraction logic.
 */

// Core types
export type {
  ExtractionPlugin,
  ExtractionContext,
  ExtractionOptions,
  ExtractionResult,
  PreProcessResult,
  ExtractedItem,
  PluginResult,
  PluginMetadata,
} from './types';

// Registry
export { pluginRegistry, registerPlugin } from './registry';

// Base plugin
export { BaseExtractionPlugin, type BasePluginConfig } from './base';

// Load all plugins (side effect: registers them)
import './signage';

// Re-export signage types for convenience
export type {
  LegendDetectionResult,
  SymbolDefinition,
  RoomCountResult,
} from './signage';
