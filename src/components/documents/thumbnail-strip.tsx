'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface ThumbnailStripProps {
  documentId: string;
  pageCount: number;
  currentPage: number;
  onPageSelect: (page: number) => void;
  orientation?: 'vertical' | 'horizontal';
  thumbnailUrls?: (string | null)[]; // Pre-fetched Blob URLs from batch endpoint
}

export function ThumbnailStrip({
  documentId,
  pageCount,
  currentPage,
  onPageSelect,
  orientation = 'vertical',
  thumbnailUrls: initialUrls,
}: ThumbnailStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [loadedThumbnails, setLoadedThumbnails] = useState<Set<number>>(new Set());
  const [errorThumbnails, setErrorThumbnails] = useState<Set<number>>(new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<(string | null)[]>(initialUrls || []);

  // Fetch thumbnail URLs if not provided
  useEffect(() => {
    if (initialUrls && initialUrls.length > 0) return;

    async function fetchThumbnailUrls() {
      try {
        const response = await fetch(`/api/documents/${documentId}/thumbnails`);
        if (response.ok) {
          const data = await response.json();
          setThumbnailUrls(data.urls || []);
        }
      } catch (error) {
        console.error('Failed to fetch thumbnail URLs:', error);
      }
    }

    fetchThumbnailUrls();
  }, [documentId, initialUrls]);

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

  // Lazy load thumbnails that are visible
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = parseInt(entry.target.getAttribute('data-page') || '0', 10);
            if (pageNum > 0 && !loadedThumbnails.has(pageNum)) {
              setLoadedThumbnails((prev) => new Set(prev).add(pageNum));
            }
          }
        });
      },
      {
        root: containerRef.current,
        rootMargin: '100px', // Preload nearby thumbnails
        threshold: 0,
      }
    );

    thumbnailRefs.current.forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, [pageCount, loadedThumbnails]);

  const handleThumbnailError = useCallback((pageNum: number) => {
    setErrorThumbnails((prev) => new Set(prev).add(pageNum));
  }, []);

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
          const isLoaded = loadedThumbnails.has(pageNum);
          const hasError = errorThumbnails.has(pageNum);

          return (
            <div
              key={pageNum}
              ref={(el) => setThumbnailRef(pageNum, el)}
              data-page={pageNum}
              onClick={() => onPageSelect(pageNum)}
              className={`
                relative cursor-pointer flex-shrink-0
                transition-all duration-150
                ${isVertical ? 'w-full aspect-[3/4]' : 'h-full aspect-[3/4]'}
                ${isSelected
                  ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-900'
                  : 'hover:ring-1 hover:ring-gray-500 hover:ring-offset-1 hover:ring-offset-gray-900'
                }
                rounded overflow-hidden bg-gray-800
              `}
            >
              {isLoaded && !hasError ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbnailUrls[pageNum - 1] || `/api/documents/${documentId}/thumbnail/${pageNum}`}
                  alt={`Page ${pageNum}`}
                  className="w-full h-full object-contain bg-white"
                  loading="lazy"
                  onError={() => handleThumbnailError(pageNum)}
                />
              ) : hasError ? (
                <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">
                  Error
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-400 rounded-full animate-spin" />
                </div>
              )}

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
