"""
Vector Extraction Service

Extracts vector geometry from PDF pages for snapping in the takeoff tool.
"""
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from contextlib import contextmanager
import uuid
import base64
import tempfile
import os
import gc
import psutil
import time
import fitz  # PyMuPDF

# Memory limits - conservative for 512MB Render free tier
MAX_PDF_SIZE_MB = 100  # Max PDF size in MB (reduced)
MAX_PDF_SIZE_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024
MEMORY_THRESHOLD_MB = 200  # Trigger cleanup earlier
MEMORY_CRITICAL_MB = 350  # Reject new requests above this

# Concurrency limit - only process one PDF at a time to prevent memory spikes
import asyncio
_processing_semaphore = asyncio.Semaphore(1)  # Single concurrent PDF processing

app = FastAPI(
    title="Vector Extractor",
    description="PDF vector extraction for takeoff snapping",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for API access
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job status with TTL
jobs: dict[str, dict] = {}
JOB_TTL_SECONDS = 3600  # Clean up jobs older than 1 hour


def get_memory_usage_mb() -> float:
    """Get current process memory usage in MB."""
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / 1024 / 1024


def check_memory_critical() -> tuple[bool, float]:
    """Check if memory is at critical level. Returns (is_critical, current_mb)."""
    current = get_memory_usage_mb()
    return current > MEMORY_CRITICAL_MB, current


def cleanup_memory():
    """Force garbage collection and cleanup."""
    gc.collect()


def unload_heavy_models():
    """Unload heavy models to free memory."""
    global _ocr_reader, _clip_model
    if _ocr_reader is not None:
        _ocr_reader = None
        gc.collect()
    if _clip_model is not None:
        _clip_model = None
        gc.collect()


def cleanup_old_jobs():
    """Remove jobs older than TTL."""
    now = time.time()
    expired = [k for k, v in jobs.items() if now - v.get("created_at", 0) > JOB_TTL_SECONDS]
    for k in expired:
        del jobs[k]


@contextmanager
def open_pdf_safely(pdf_bytes: bytes):
    """Context manager to safely open and close PDF documents."""
    doc = None
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        yield doc
    finally:
        if doc:
            doc.close()
        # Force cleanup after processing
        cleanup_memory()


# === Synchronous extraction (matches Next.js API contract) ===

class SyncExtractionRequest(BaseModel):
    """Request format expected by Next.js /api/takeoff/vectors endpoint."""
    pdfData: str  # Base64 encoded PDF
    pageNum: int  # 1-indexed page number
    scale: float = 1.5


class SnapPointResponse(BaseModel):
    type: str  # 'endpoint' | 'midpoint' | 'intersection'
    coords: tuple[float, float]


class LineSegmentResponse(BaseModel):
    start: tuple[float, float]
    end: tuple[float, float]


class SyncExtractionResponse(BaseModel):
    """Response format expected by Next.js."""
    success: bool
    lines: list[dict] = []
    snapPoints: list[dict] = []
    rawPathCount: int = 0
    cleanedPathCount: int = 0
    quality: str = "none"
    error: Optional[str] = None


@app.post("/", response_model=SyncExtractionResponse)
async def extract_sync(request: SyncExtractionRequest):
    """
    Synchronous vector extraction - matches Next.js API contract.

    This is the primary endpoint called by /api/takeoff/vectors.
    Accepts base64 PDF data and returns vectors immediately.
    """
    from .extractor import extract_page_vectors

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        # Re-check after cleanup
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return SyncExtractionResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        tmp_path = None
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Decode base64 PDF data
            try:
                pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return SyncExtractionResponse(
                    success=False,
                    error=f"Invalid base64 PDF data: {str(e)}"
                )

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return SyncExtractionResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Write to temp file (extractor needs a file path)
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(pdf_bytes)
                tmp_path = tmp.name

            # Extract vectors
            result = extract_page_vectors(
                pdf_path=tmp_path,
                page_number=request.pageNum - 1,  # Convert to 0-indexed
                dpi=request.scale * 72,  # Convert scale to DPI
            )

            return SyncExtractionResponse(
                success=True,
                lines=result["lines"],
                snapPoints=result["snap_points"],
                rawPathCount=result["stats"]["raw_count"],
                cleanedPathCount=result["stats"]["cleaned_count"],
                quality=result["quality"],
            )

        except Exception as e:
            return SyncExtractionResponse(
                success=False,
                error=str(e)
            )
        finally:
            # Always clean up temp file
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
            cleanup_memory()


# === Async extraction (for future use) ===

class ExtractionRequest(BaseModel):
    document_id: str
    page_number: int
    pdf_path: str
    callback_url: str  # Next.js API to receive results


class ExtractionStatus(BaseModel):
    job_id: str
    status: str  # pending, processing, completed, failed
    progress: Optional[float] = None
    error: Optional[str] = None


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vector-extractor"}


@app.get("/memory")
async def memory_stats():
    """Get memory usage statistics for debugging."""
    process = psutil.Process(os.getpid())
    mem_info = process.memory_info()
    rss_mb = mem_info.rss / 1024 / 1024

    # Clean up old jobs
    cleanup_old_jobs()

    return {
        "rss_mb": round(rss_mb, 2),
        "vms_mb": round(mem_info.vms / 1024 / 1024, 2),
        "active_jobs": len(jobs),
        "threshold_mb": MEMORY_THRESHOLD_MB,
        "critical_mb": MEMORY_CRITICAL_MB,
        "max_pdf_size_mb": MAX_PDF_SIZE_MB,
        "is_critical": rss_mb > MEMORY_CRITICAL_MB,
        "ocr_loaded": _ocr_reader is not None,
        "clip_loaded": _clip_model is not None,
    }


@app.post("/gc")
async def force_gc():
    """Force garbage collection - useful for debugging memory issues."""
    before_mb = get_memory_usage_mb()
    cleanup_memory()
    cleanup_old_jobs()
    after_mb = get_memory_usage_mb()

    return {
        "before_mb": round(before_mb, 2),
        "after_mb": round(after_mb, 2),
        "freed_mb": round(before_mb - after_mb, 2),
    }


# === Page Rendering Endpoint ===

class RenderRequest(BaseModel):
    """Request format expected by Next.js /api/takeoff/render endpoint."""
    pdfData: Optional[str] = None  # Base64 encoded PDF (legacy)
    pdfUrl: Optional[str] = None  # URL to fetch PDF from (preferred)
    pageNum: int  # 1-indexed page number
    scale: float = 1.5
    returnBase64: bool = True


class RenderResponse(BaseModel):
    """Response format expected by Next.js."""
    success: bool
    image: Optional[str] = None  # Base64 encoded PNG
    width: Optional[int] = None
    height: Optional[int] = None
    error: Optional[str] = None


@app.post("/render", response_model=RenderResponse)
async def render_page(request: RenderRequest):
    """
    Render a PDF page to a PNG image using PyMuPDF.

    Accepts either pdfUrl (preferred, streams from Blob) or pdfData (legacy base64).
    Returns a base64-encoded PNG image.
    """
    # Validate input - need either pdfUrl or pdfData
    if not request.pdfUrl and not request.pdfData:
        return RenderResponse(success=False, error="Either pdfUrl or pdfData is required")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return RenderResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Get PDF bytes - prefer URL (lower memory) over base64
            try:
                if request.pdfUrl:
                    pdf_bytes = await fetch_pdf_from_url(request.pdfUrl)
                else:
                    pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return RenderResponse(
                    success=False,
                    error=f"Failed to load PDF: {str(e)}"
                )

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return RenderResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Use context manager for safe cleanup
            with open_pdf_safely(pdf_bytes) as doc:
                # Validate page number (1-indexed from API, 0-indexed internally)
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return RenderResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]

                # Calculate matrix for scaling (PDF default is 72 DPI)
                # scale=1.5 means 1.5x the default, so 108 DPI
                mat = fitz.Matrix(request.scale, request.scale)

                # Render page to pixmap (PNG)
                pix = page.get_pixmap(matrix=mat, alpha=False)

                # Convert to PNG bytes
                png_bytes = pix.tobytes("png")

                # Encode as base64
                image_b64 = base64.b64encode(png_bytes).decode("utf-8")

                result = RenderResponse(
                    success=True,
                    image=image_b64,
                    width=pix.width,
                    height=pix.height,
                )

                # Explicitly clear pixmap
                del pix
                del png_bytes

                return result

        except Exception as e:
            cleanup_memory()
            return RenderResponse(
                success=False,
                error=str(e)
            )


# === Tile Rendering Endpoint ===

class TileRequest(BaseModel):
    """Request for rendering a single tile from a PDF page."""
    pdfUrl: str  # URL to fetch PDF from (Vercel Blob)
    pageNum: int  # 1-indexed page number
    z: int  # Zoom level (0-4)
    x: int  # Tile X coordinate
    y: int  # Tile Y coordinate
    tileSize: int = 256  # Output tile size in pixels


class TileResponse(BaseModel):
    """Response with rendered tile."""
    success: bool
    image: Optional[str] = None  # Base64 encoded WebP
    error: Optional[str] = None


# Cache for fetched PDFs (simple LRU with max size)
_pdf_cache: dict[str, bytes] = {}
_pdf_cache_order: list[str] = []
PDF_CACHE_MAX_SIZE = 3  # Keep last 3 PDFs in memory


def get_cached_pdf(url: str) -> bytes | None:
    """Get PDF from cache if available."""
    return _pdf_cache.get(url)


def cache_pdf(url: str, data: bytes):
    """Cache PDF data with LRU eviction."""
    global _pdf_cache, _pdf_cache_order

    # Don't cache very large PDFs (>20MB)
    if len(data) > 20 * 1024 * 1024:
        return

    # Remove from order if already exists
    if url in _pdf_cache_order:
        _pdf_cache_order.remove(url)

    # Evict oldest if at capacity
    while len(_pdf_cache_order) >= PDF_CACHE_MAX_SIZE:
        oldest = _pdf_cache_order.pop(0)
        del _pdf_cache[oldest]

    _pdf_cache[url] = data
    _pdf_cache_order.append(url)


async def fetch_pdf_from_url(url: str) -> bytes:
    """Fetch PDF from URL with caching."""
    import httpx

    # Check cache first
    cached = get_cached_pdf(url)
    if cached:
        return cached

    # Fetch from URL
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        data = response.content

    # Cache for future requests
    cache_pdf(url, data)

    return data


@app.post("/tile", response_model=TileResponse)
async def render_tile(request: TileRequest):
    """
    Render a single tile from a PDF page.

    Tiles are 256x256 WebP images. The tile coordinate system:
    - z=0: 1x1 grid (1 tile covers whole page)
    - z=1: 2x2 grid (4 tiles)
    - z=2: 4x4 grid (16 tiles)
    - etc.

    Fetches PDF from URL (Vercel Blob) instead of receiving base64 data.
    This keeps memory usage low regardless of PDF size.
    """
    # Validate zoom level
    if request.z < 0 or request.z > 4:
        return TileResponse(success=False, error="Zoom level must be 0-4")

    # Validate URL
    if not request.pdfUrl.startswith('https://'):
        return TileResponse(success=False, error="Invalid PDF URL - must be HTTPS")

    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return TileResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry."
            )

    # Use semaphore to limit concurrent processing
    async with _processing_semaphore:
        try:
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Fetch PDF from URL
            try:
                pdf_bytes = await fetch_pdf_from_url(request.pdfUrl)
            except Exception as e:
                return TileResponse(success=False, error=f"Failed to fetch PDF: {str(e)}")

            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return TileResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB)"
                )

            with open_pdf_safely(pdf_bytes) as doc:
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return TileResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]
                page_rect = page.rect
                page_width = page_rect.width
                page_height = page_rect.height

                # Calculate tile bounds
                scale = 2 ** request.z  # Number of tiles per dimension
                tile_width = page_width / scale
                tile_height = page_height / scale

                # Validate tile coordinates
                if request.x < 0 or request.x >= scale or request.y < 0 or request.y >= scale:
                    return TileResponse(
                        success=False,
                        error=f"Invalid tile coordinates ({request.x}, {request.y}) for zoom {request.z}"
                    )

                # Calculate clip rectangle for this tile
                clip_x = request.x * tile_width
                clip_y = request.y * tile_height
                clip_rect = fitz.Rect(
                    clip_x,
                    clip_y,
                    min(clip_x + tile_width, page_width),
                    min(clip_y + tile_height, page_height)
                )

                # Calculate matrix to render tile at target size
                # We want the clip region to fill a tileSize x tileSize output
                scale_x = request.tileSize / tile_width
                scale_y = request.tileSize / tile_height
                mat = fitz.Matrix(scale_x, scale_y)

                # Render the tile
                pix = page.get_pixmap(matrix=mat, clip=clip_rect, alpha=False)

                # Convert to WebP for better compression
                import io
                from PIL import Image

                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                buffer = io.BytesIO()
                img.save(buffer, format="WEBP", quality=85)
                webp_bytes = buffer.getvalue()

                image_b64 = base64.b64encode(webp_bytes).decode("utf-8")

                result = TileResponse(success=True, image=image_b64)

                # Cleanup
                del pix
                del img
                del buffer

                return result

        except Exception as e:
            cleanup_memory()
            return TileResponse(success=False, error=str(e))


# === Text Extraction Endpoint ===

class TextExtractionRequest(BaseModel):
    """Request for extracting text from PDF pages."""
    pdfData: str  # Base64 encoded PDF


class PageTextResult(BaseModel):
    """Text extracted from a single page."""
    page: int  # 1-indexed
    text: str
    needsOcr: bool  # True if page has <50 chars (likely scanned)


class TextExtractionResponse(BaseModel):
    """Response with text from all pages."""
    success: bool
    pages: list[PageTextResult] = []
    totalPages: int = 0
    error: Optional[str] = None


@app.post("/text", response_model=TextExtractionResponse)
async def extract_text(request: TextExtractionRequest):
    """
    Extract text from all pages of a PDF.

    Uses PyMuPDF's text extraction which works well for PDFs with
    embedded text (CAD exports, digital documents). Pages with very
    little text (<50 chars) are flagged as needing OCR.
    """
    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return TextExtractionResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Decode base64 PDF data
            try:
                pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return TextExtractionResponse(
                    success=False,
                    error=f"Invalid base64 PDF data: {str(e)}"
                )

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return TextExtractionResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Use context manager for safe cleanup
            with open_pdf_safely(pdf_bytes) as doc:
                pages = []
                for i in range(len(doc)):
                    page = doc[i]
                    text = page.get_text()

                    # Flag pages with very little text as needing OCR
                    needs_ocr = len(text.strip()) < 50

                    pages.append(PageTextResult(
                        page=i + 1,  # 1-indexed
                        text=text,
                        needsOcr=needs_ocr,
                    ))

                return TextExtractionResponse(
                    success=True,
                    pages=pages,
                    totalPages=len(pages),
                )

        except Exception as e:
            cleanup_memory()
            return TextExtractionResponse(
                success=False,
                error=str(e)
            )


# === Region Crop Endpoint ===

class CropRequest(BaseModel):
    """Request for cropping a region from a PDF page."""
    pdfData: str  # Base64 encoded PDF
    pageNum: int  # 1-indexed page number
    x: float      # Center X coordinate (normalized 0-1)
    y: float      # Center Y coordinate (normalized 0-1)
    width: float = 100   # Width in pixels at 150 DPI
    height: float = 100  # Height in pixels at 150 DPI


class CropResponse(BaseModel):
    """Response with cropped region as base64 PNG."""
    success: bool
    image: Optional[str] = None  # Base64 encoded PNG
    width: Optional[int] = None
    height: Optional[int] = None
    error: Optional[str] = None


@app.post("/crop", response_model=CropResponse)
async def crop_region(request: CropRequest):
    """
    Crop a region from a PDF page around the specified coordinates.

    Input coordinates are normalized (0-1), output is a base64 PNG.
    """
    # Check if memory is critical - reject early
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        unload_heavy_models()
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return CropResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent PDF processing
    async with _processing_semaphore:
        try:
            # Check memory before processing
            if get_memory_usage_mb() > MEMORY_THRESHOLD_MB:
                cleanup_memory()

            # Decode base64 PDF data
            try:
                pdf_bytes = base64.b64decode(request.pdfData)
            except Exception as e:
                return CropResponse(success=False, error=f"Invalid base64 PDF data: {str(e)}")

            # Check PDF size
            if len(pdf_bytes) > MAX_PDF_SIZE_BYTES:
                return CropResponse(
                    success=False,
                    error=f"PDF too large ({len(pdf_bytes) / 1024 / 1024:.1f}MB). Max size is {MAX_PDF_SIZE_MB}MB."
                )

            # Use context manager for safe cleanup
            with open_pdf_safely(pdf_bytes) as doc:
                # Validate page number
                page_index = request.pageNum - 1
                if page_index < 0 or page_index >= len(doc):
                    return CropResponse(
                        success=False,
                        error=f"Invalid page number. Document has {len(doc)} pages."
                    )

                page = doc[page_index]

                # Get page dimensions
                page_rect = page.rect
                page_width = page_rect.width
                page_height = page_rect.height

                # Convert normalized coordinates to page coordinates
                center_x = request.x * page_width
                center_y = request.y * page_height

                # Calculate crop rectangle (in PDF points)
                dpi_scale = 72 / 150
                half_width = (request.width / 2) * dpi_scale
                half_height = (request.height / 2) * dpi_scale

                # Create clip rectangle
                clip_rect = fitz.Rect(
                    max(0, center_x - half_width),
                    max(0, center_y - half_height),
                    min(page_width, center_x + half_width),
                    min(page_height, center_y + half_height)
                )

                # Render the cropped region at 150 DPI
                mat = fitz.Matrix(150 / 72, 150 / 72)
                pix = page.get_pixmap(matrix=mat, clip=clip_rect, alpha=False)

                # Convert to PNG bytes
                png_bytes = pix.tobytes("png")
                image_b64 = base64.b64encode(png_bytes).decode("utf-8")

                result = CropResponse(
                    success=True,
                    image=image_b64,
                    width=pix.width,
                    height=pix.height,
                )

                del pix
                del png_bytes

                return result

        except Exception as e:
            cleanup_memory()
            return CropResponse(success=False, error=str(e))


# === OCR Endpoint ===

# Lazy-load OCR reader to avoid startup delay
_ocr_reader = None

def get_ocr_reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(['en'], gpu=False)
    return _ocr_reader


class OcrRequest(BaseModel):
    """Request for OCR on an image."""
    image: str  # Base64 encoded PNG


class OcrResponse(BaseModel):
    """Response with OCR results."""
    success: bool
    text: Optional[str] = None
    confidence: Optional[float] = None
    boxes: list = []  # List of detected text boxes
    error: Optional[str] = None


@app.post("/ocr", response_model=OcrResponse)
async def ocr_image(request: OcrRequest):
    """
    Perform OCR on a base64-encoded image.

    Returns detected text and confidence score.
    """
    # Check if memory is critical - reject early (OCR loads ~200MB model)
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        # Don't unload OCR model here since we're about to use it
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return OcrResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent processing
    async with _processing_semaphore:
        try:
            import io
            from PIL import Image
            import numpy as np

            # Decode base64 image
            try:
                image_bytes = base64.b64decode(request.image)
                image = Image.open(io.BytesIO(image_bytes))
                image_array = np.array(image)
            except Exception as e:
                return OcrResponse(success=False, error=f"Invalid image data: {str(e)}")

            # Get OCR reader
            reader = get_ocr_reader()

            # Perform OCR
            results = reader.readtext(image_array)

            if not results:
                return OcrResponse(
                    success=True,
                    text="",
                    confidence=0.0,
                    boxes=[],
                )

            # Combine all text and calculate average confidence
            texts = []
            confidences = []
            boxes = []

            for (bbox, text, conf) in results:
                texts.append(text)
                confidences.append(conf)
                boxes.append({
                    "text": text,
                    "confidence": conf,
                    "bbox": bbox,
                })

            combined_text = " ".join(texts)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

            return OcrResponse(
                success=True,
                text=combined_text,
                confidence=avg_confidence,
                boxes=boxes,
            )

        except Exception as e:
            return OcrResponse(success=False, error=str(e))


# === CLIP Embedding Endpoint ===

# Lazy-load CLIP model to avoid startup delay
_clip_model = None

def get_clip_model():
    global _clip_model
    if _clip_model is None:
        from sentence_transformers import SentenceTransformer
        # Use a small, fast CLIP model
        _clip_model = SentenceTransformer('clip-ViT-B-32')
    return _clip_model


class EmbedRequest(BaseModel):
    """Request for generating image embedding."""
    image: str  # Base64 encoded PNG


class EmbedResponse(BaseModel):
    """Response with image embedding."""
    success: bool
    embedding: Optional[list] = None  # 512-dim float array
    error: Optional[str] = None


@app.post("/embed", response_model=EmbedResponse)
async def generate_embedding(request: EmbedRequest):
    """
    Generate a CLIP embedding for a base64-encoded image.

    Returns a 512-dimensional float vector for similarity search.
    """
    # Check if memory is critical - reject early (CLIP loads ~400MB model)
    is_critical, mem_mb = check_memory_critical()
    if is_critical:
        cleanup_memory()
        # Don't unload CLIP model here since we're about to use it
        is_critical, mem_mb = check_memory_critical()
        if is_critical:
            return EmbedResponse(
                success=False,
                error=f"Server under high memory pressure ({mem_mb:.0f}MB). Please retry in a moment."
            )

    # Use semaphore to limit concurrent processing
    async with _processing_semaphore:
        try:
            import io
            from PIL import Image

            # Decode base64 image
            try:
                image_bytes = base64.b64decode(request.image)
                image = Image.open(io.BytesIO(image_bytes))
                # Convert to RGB if necessary
                if image.mode != 'RGB':
                    image = image.convert('RGB')
            except Exception as e:
                return EmbedResponse(success=False, error=f"Invalid image data: {str(e)}")

            # Get CLIP model
            model = get_clip_model()

            # Generate embedding
            embedding = model.encode(image)

            # Convert to list of floats
            embedding_list = embedding.tolist()

            return EmbedResponse(
                success=True,
                embedding=embedding_list,
            )

        except Exception as e:
            return EmbedResponse(success=False, error=str(e))


@app.post("/extract", response_model=ExtractionStatus)
async def extract_vectors(request: ExtractionRequest, background_tasks: BackgroundTasks):
    """
    Queue vector extraction for a PDF page.
    Returns immediately with job_id for status polling.
    """
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "request": request.model_dump(),
    }

    # Queue background extraction
    background_tasks.add_task(run_extraction, job_id, request)

    return ExtractionStatus(job_id=job_id, status="pending", progress=0)


@app.get("/status/{job_id}", response_model=ExtractionStatus)
async def get_status(job_id: str):
    """Get extraction job status."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    return ExtractionStatus(
        job_id=job_id,
        status=job["status"],
        progress=job.get("progress"),
        error=job.get("error"),
    )


async def run_extraction(job_id: str, request: ExtractionRequest):
    """Background task to extract vectors."""
    # Import here to avoid startup delay
    from .extractor import extract_page_vectors
    import httpx

    jobs[job_id]["status"] = "processing"
    jobs[job_id]["progress"] = 0.1

    try:
        # Extract vectors
        result = extract_page_vectors(
            pdf_path=request.pdf_path,
            page_number=request.page_number,
            on_progress=lambda p: jobs[job_id].update({"progress": p}),
        )

        jobs[job_id]["progress"] = 0.9

        # Send results to callback URL
        async with httpx.AsyncClient() as client:
            await client.post(
                request.callback_url,
                json={
                    "document_id": request.document_id,
                    "page_number": request.page_number,
                    "vectors": result,
                },
                timeout=30.0,
            )

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 1.0

    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
