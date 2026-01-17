'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTakeoffStore } from '@/lib/stores/takeoff-store';

interface SheetThumbnailStripProps {
  maxVisible?: number;  // Max thumbnails to show before scrolling
}

export function SheetThumbnailStrip({ maxVisible = 8 }: SheetThumbnailStripProps) {
  const { project, currentSheetId, setCurrentSheet, isDrawing } = useTakeoffStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [loadedThumbnails, setLoadedThumbnails] = useState<Set<string>>(new Set());

  const sheets = project?.sheets || [];

  // Scroll current sheet into view
  useEffect(() => {
    if (currentSheetId) {
      const thumbnailEl = thumbnailRefs.current.get(currentSheetId);
      if (thumbnailEl && containerRef.current) {
        thumbnailEl.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest',
        });
      }
    }
  }, [currentSheetId]);

  // Lazy load thumbnails
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const sheetId = entry.target.getAttribute('data-sheet-id');
            if (sheetId && !loadedThumbnails.has(sheetId)) {
              setLoadedThumbnails((prev) => new Set(prev).add(sheetId));
            }
          }
        });
      },
      {
        root: containerRef.current,
        rootMargin: '50px',
        threshold: 0,
      }
    );

    thumbnailRefs.current.forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, [sheets.length, loadedThumbnails]);

  const setThumbnailRef = useCallback((sheetId: string, el: HTMLDivElement | null) => {
    if (el) {
      thumbnailRefs.current.set(sheetId, el);
    } else {
      thumbnailRefs.current.delete(sheetId);
    }
  }, []);

  const handleSheetClick = useCallback((sheetId: string) => {
    if (!isDrawing) {
      setCurrentSheet(sheetId);
    }
  }, [isDrawing, setCurrentSheet]);

  // Don't show if only one sheet
  if (sheets.length <= 1) return null;

  return (
    <div className="bg-gray-900/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-700 p-2">
      <div
        ref={containerRef}
        className="flex gap-2 overflow-x-auto max-w-[600px] scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-transparent"
        style={{ scrollbarWidth: 'thin' }}
      >
        {sheets.map((sheet, index) => {
          const isSelected = sheet.id === currentSheetId;
          const isLoaded = loadedThumbnails.has(sheet.id);
          // Extract page number from sheet data or use index
          const pageNum = sheet.pageNumber || index + 1;

          return (
            <div
              key={sheet.id}
              ref={(el) => setThumbnailRef(sheet.id, el)}
              data-sheet-id={sheet.id}
              onClick={() => handleSheetClick(sheet.id)}
              className={`
                relative cursor-pointer flex-shrink-0
                w-16 h-20 rounded overflow-hidden
                transition-all duration-150
                ${isDrawing ? 'opacity-50 cursor-not-allowed' : ''}
                ${isSelected
                  ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-900 scale-105'
                  : 'hover:ring-1 hover:ring-gray-500 opacity-70 hover:opacity-100'
                }
              `}
              title={sheet.name || `Page ${pageNum}`}
            >
              {/* Thumbnail content */}
              {isLoaded && sheet.tileUrlTemplate ? (
                // Use lowest zoom tile as thumbnail
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sheet.tileUrlTemplate.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')}
                  alt={sheet.name || `Page ${pageNum}`}
                  className="w-full h-full object-cover bg-white"
                  loading="lazy"
                  onError={(e) => {
                    // Hide broken image
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                // Placeholder with page number
                <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                  <span className="text-gray-400 text-xs font-mono">{pageNum}</span>
                </div>
              )}

              {/* Page number badge */}
              <div
                className={`
                  absolute bottom-0.5 right-0.5
                  px-1 py-0.5 text-[10px] rounded
                  ${isSelected
                    ? 'bg-blue-600 text-white'
                    : 'bg-black/70 text-gray-300'
                  }
                `}
              >
                {pageNum}
              </div>

              {/* Calibration indicator */}
              {sheet.calibration && (
                <div
                  className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-green-500"
                  title="Scale calibrated"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Sheet count indicator if many sheets */}
      {sheets.length > maxVisible && (
        <div className="text-center mt-1">
          <span className="text-[10px] text-gray-500">
            {sheets.findIndex(s => s.id === currentSheetId) + 1} of {sheets.length} sheets
          </span>
        </div>
      )}
    </div>
  );
}
