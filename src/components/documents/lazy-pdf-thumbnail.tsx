'use client';

import { useEffect, useRef, useState } from 'react';
import { PdfThumbnail } from './pdf-thumbnail';

interface LazyPdfThumbnailProps {
  pdfUrl: string;
  pageNumber: number;
  width?: number;
  isSelected?: boolean;
  onClick?: () => void;
}

/**
 * Lazy-loading wrapper for PdfThumbnail
 * Only renders the actual thumbnail when it becomes visible in the viewport
 */
export function LazyPdfThumbnail({
  pdfUrl,
  pageNumber,
  width = 100,
  isSelected = false,
  onClick,
}: LazyPdfThumbnailProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            setHasBeenVisible(true);
          } else {
            setIsVisible(false);
          }
        });
      },
      {
        rootMargin: '100px', // Preload nearby thumbnails
        threshold: 0,
      }
    );

    observer.observe(ref.current);

    return () => observer.disconnect();
  }, []);

  // Keep rendering once visible to preserve the rendered thumbnail
  const shouldRender = hasBeenVisible;

  return (
    <div
      ref={ref}
      className="w-full aspect-[3/4]"
      style={{ minHeight: `${Math.round(width * 4 / 3)}px` }}
    >
      {shouldRender ? (
        <PdfThumbnail
          pdfUrl={pdfUrl}
          pageNumber={pageNumber}
          width={width}
          isSelected={isSelected}
          onClick={onClick}
        />
      ) : (
        // Placeholder while not visible
        <div
          onClick={onClick}
          className={`
            w-full h-full cursor-pointer
            transition-all duration-150
            ${isSelected
              ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-900'
              : 'hover:ring-1 hover:ring-gray-500 hover:ring-offset-1 hover:ring-offset-gray-900'
            }
            rounded overflow-hidden bg-gray-700
            flex items-center justify-center
          `}
        >
          <span className="text-gray-400 text-sm">{pageNumber}</span>
        </div>
      )}
    </div>
  );
}
