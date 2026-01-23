'use client';

import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Configure worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
}

interface PdfPageRendererProps {
  pdfUrl: string;
  pageNumber: number;
  scale?: number;
  className?: string;
  onLoad?: () => void;
  onError?: (error: string) => void;
}

/**
 * Client-side PDF page renderer using PDF.js
 * Renders a single page to a canvas element
 */
export function PdfPageRenderer({
  pdfUrl,
  pageNumber,
  scale = 1.5,
  className = '',
  onLoad,
  onError,
}: PdfPageRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;

    async function renderPage() {
      if (!canvasRef.current) return;

      try {
        setLoading(true);
        setError(null);

        // Cancel any previous render
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }

        // Load PDF document
        pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;

        if (cancelled) return;

        // Get the page
        const page = await pdfDoc.getPage(pageNumber);

        if (cancelled) return;

        // Calculate viewport
        const viewport = page.getViewport({ scale });

        // Set canvas dimensions
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        if (!context) {
          throw new Error('Could not get canvas context');
        }

        // Handle high-DPI displays
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const transform = outputScale !== 1
          ? [outputScale, 0, 0, outputScale, 0, 0] as [number, number, number, number, number, number]
          : undefined;

        // Render page
        const renderTask = page.render({
          canvasContext: context,
          viewport,
          transform,
          canvas,
        });

        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (!cancelled) {
          setLoading(false);
          onLoad?.();
        }
      } catch (err) {
        if (cancelled) return;

        // Ignore cancel errors
        if (err instanceof Error && err.message.includes('cancel')) {
          return;
        }

        const errorMessage = err instanceof Error ? err.message : 'Failed to render page';
        setError(errorMessage);
        setLoading(false);
        onError?.(errorMessage);
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
      if (pdfDoc) {
        pdfDoc.destroy();
      }
    };
  }, [pdfUrl, pageNumber, scale, onLoad, onError]);

  if (error) {
    return (
      <div className={`flex items-center justify-center bg-red-50 text-red-600 p-4 ${className}`}>
        <div className="text-center">
          <p className="font-medium">Failed to load page</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`bg-white shadow-lg ${loading ? 'invisible' : 'visible'}`}
      />
    </div>
  );
}
