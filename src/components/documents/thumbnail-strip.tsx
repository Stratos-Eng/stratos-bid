'use client';

import { useEffect, useRef, useCallback } from 'react';
import { LazyPdfThumbnail } from './lazy-pdf-thumbnail';

interface ThumbnailStripProps {
  documentId: string;
  pdfUrl: string;
  pageCount: number;
  currentPage: number;
  onPageSelect: (page: number) => void;
  orientation?: 'vertical' | 'horizontal';
}

export function ThumbnailStrip({
  documentId,
  pdfUrl,
  pageCount,
  currentPage,
  onPageSelect,
  orientation = 'vertical',
}: ThumbnailStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Scroll current page thumbnail into view
  useEffect(() => {
    const thumbnailEl = thumbnailRefs.current.get(currentPage);
    if (thumbnailEl && containerRef.current) {
      thumbnailEl.scrollIntoView({
        behavior: 'smooth',
        block: orientation === 'vertical' ? 'nearest' : 'center',
        inline: orientation === 'horizontal' ? 'nearest' : 'center',
      });
    }
  }, [currentPage, orientation]);

  const setThumbnailRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) {
      thumbnailRefs.current.set(pageNum, el);
    } else {
      thumbnailRefs.current.delete(pageNum);
    }
  }, []);

  const isVertical = orientation === 'vertical';

  return (
    <div
      ref={containerRef}
      className={`
        bg-gray-900 overflow-auto
        ${isVertical ? 'w-[120px] h-full' : 'h-[100px] w-full'}
      `}
    >
      <div
        className={`
          flex gap-2 p-2
          ${isVertical ? 'flex-col' : 'flex-row'}
        `}
      >
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNum) => {
          const isSelected = pageNum === currentPage;

          return (
            <div
              key={pageNum}
              ref={(el) => setThumbnailRef(pageNum, el)}
              data-page={pageNum}
              className={`
                relative flex-shrink-0
                ${isVertical ? 'w-full' : 'h-full aspect-[3/4]'}
              `}
            >
              <LazyPdfThumbnail
                pdfUrl={pdfUrl}
                pageNumber={pageNum}
                width={isVertical ? 100 : 75}
                isSelected={isSelected}
                onClick={() => onPageSelect(pageNum)}
              />

              {/* Page number badge */}
              <div
                className={`
                  absolute bottom-1 right-1
                  px-1.5 py-0.5 text-xs rounded
                  ${isSelected
                    ? 'bg-blue-600 text-white'
                    : 'bg-black/60 text-gray-300'
                  }
                `}
              >
                {pageNum}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
