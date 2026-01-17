// src/components/takeoff/sheet-navigator.tsx
'use client';

import { useEffect, useState } from 'react';
import { useTakeoffStore } from '@/lib/stores/takeoff-store';

export function SheetNavigator() {
  const { project, currentSheetId, nextSheet, prevSheet, getSheetIndex, isDrawing } = useTakeoffStore();
  const [flash, setFlash] = useState(false);

  const index = getSheetIndex();
  const currentSheet = project?.sheets.find(s => s.id === currentSheetId);

  // Flash effect when sheet changes
  useEffect(() => {
    if (currentSheetId) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 200);
      return () => clearTimeout(timer);
    }
  }, [currentSheetId]);

  // Hide when no valid index, no sheet, or only one sheet
  if (!index || !currentSheet || index.total === 1) return null;

  const canGoPrev = index.current > 1 && !isDrawing;
  const canGoNext = index.current < index.total && !isDrawing;

  return (
    <div className={`flex items-center gap-2 bg-white rounded-lg shadow border px-3 py-2 transition-all duration-200 ${flash ? 'ring-2 ring-blue-400 scale-105' : ''}`}>
      {/* Previous button */}
      <button
        onClick={prevSheet}
        disabled={!canGoPrev}
        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous sheet ([ or PageUp)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Sheet info */}
      <div className="flex flex-col items-center min-w-[80px]">
        <span className="text-xs text-gray-500 tabular-nums">
          {index.current} / {index.total}
        </span>
        <span className="text-xs font-medium text-gray-700 truncate max-w-[120px]" title={currentSheet.name}>
          {currentSheet.name}
        </span>
      </div>

      {/* Next button */}
      <button
        onClick={nextSheet}
        disabled={!canGoNext}
        className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next sheet (] or PageDown)"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
