// src/hooks/use-takeoff-keyboard.ts
import { useEffect, useCallback } from 'react';
import { useTakeoffStore } from '@/lib/stores/takeoff-store';

interface UseTakeoffKeyboardOptions {
  enabled?: boolean;
}

export function useTakeoffKeyboard({ enabled = true }: UseTakeoffKeyboardOptions = {}) {
  const {
    activeTool,
    setActiveTool,
    nextSheet,
    prevSheet,
    toggleSnap,
    isDrawing,
    isCalibrating,
    cancelCalibration,
  } = useTakeoffStore();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if typing in input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Ignore if disabled or currently drawing
      if (!enabled || isDrawing) return;

      const key = e.key.toLowerCase();
      const hasModifier = e.metaKey || e.ctrlKey;

      // === SHEET NAVIGATION ===

      // PageDown or ] = next sheet
      if (e.key === 'PageDown' || key === ']') {
        e.preventDefault();
        nextSheet();
        return;
      }

      // PageUp or [ = previous sheet
      if (e.key === 'PageUp' || key === '[') {
        e.preventDefault();
        prevSheet();
        return;
      }

      // === TOOL SELECTION ===

      // V = select tool
      if (key === 'v' && !hasModifier) {
        e.preventDefault();
        setActiveTool('select');
        return;
      }

      // C = count tool
      if (key === 'c' && !hasModifier) {
        e.preventDefault();
        setActiveTool('count');
        return;
      }

      // L = line tool
      if (key === 'l' && !hasModifier) {
        e.preventDefault();
        setActiveTool('line');
        return;
      }

      // P = polyline (linear) tool
      if (key === 'p' && !hasModifier) {
        e.preventDefault();
        setActiveTool('linear');
        return;
      }

      // A = area tool
      if (key === 'a' && !hasModifier) {
        e.preventDefault();
        setActiveTool('area');
        return;
      }

      // R = rectangle tool
      if (key === 'r' && !hasModifier) {
        e.preventDefault();
        setActiveTool('rectangle');
        return;
      }

      // K = calibrate (scale)
      if (key === 'k' && !hasModifier) {
        e.preventDefault();
        setActiveTool('calibrate');
        return;
      }

      // === TOGGLES ===

      // S = toggle snap
      if (key === 's' && !hasModifier) {
        e.preventDefault();
        toggleSnap();
        return;
      }

      // Escape = cancel current operation
      if (key === 'escape') {
        e.preventDefault();
        if (isCalibrating) {
          cancelCalibration();
        }
        setActiveTool('select');
        return;
      }
    },
    [
      enabled,
      isDrawing,
      isCalibrating,
      nextSheet,
      prevSheet,
      setActiveTool,
      toggleSnap,
      cancelCalibration,
    ]
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
}
