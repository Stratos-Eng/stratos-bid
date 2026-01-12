"""
Vector extraction from PDF using PyMuPDF (fitz).
Deployed as a Vercel Python serverless function.

Extracts line segments, endpoints, midpoints, and intersections
from construction drawings for snapping functionality.
"""

from http.server import BaseHTTPRequestHandler
import json
import base64
import tempfile
import os
from typing import List, Tuple, Dict, Any
import math

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None


def distance(p1: Tuple[float, float], p2: Tuple[float, float]) -> float:
    """Calculate distance between two points."""
    return math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2)


def midpoint(p1: Tuple[float, float], p2: Tuple[float, float]) -> Tuple[float, float]:
    """Calculate midpoint of two points."""
    return ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)


def line_intersection(
    l1_start: Tuple[float, float],
    l1_end: Tuple[float, float],
    l2_start: Tuple[float, float],
    l2_end: Tuple[float, float],
) -> Tuple[float, float] | None:
    """Find intersection point of two line segments."""
    x1, y1 = l1_start
    x2, y2 = l1_end
    x3, y3 = l2_start
    x4, y4 = l2_end

    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 0.0001:
        return None  # Parallel or coincident

    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom

    # Check if intersection is within both line segments
    if 0 <= t <= 1 and 0 <= u <= 1:
        ix = x1 + t * (x2 - x1)
        iy = y1 + t * (y2 - y1)
        return (ix, iy)

    return None


def dedupe_points(
    points: List[Dict[str, Any]], tolerance: float = 2.0
) -> List[Dict[str, Any]]:
    """Remove duplicate points within tolerance."""
    result = []
    for point in points:
        is_dupe = False
        for existing in result:
            if distance(tuple(existing["coords"]), tuple(point["coords"])) < tolerance:
                is_dupe = True
                break
        if not is_dupe:
            result.append(point)
    return result


def clean_lines(
    lines: List[Dict[str, Any]], min_length: float = 10.0
) -> List[Dict[str, Any]]:
    """
    Clean extracted lines:
    - Remove very short lines (noise/hatching)
    - Remove duplicates
    """
    result = []

    for line in lines:
        start = tuple(line["start"])
        end = tuple(line["end"])
        length = distance(start, end)

        # Skip very short lines
        if length < min_length:
            continue

        # Check for duplicates
        is_dupe = False
        for existing in result:
            ex_start = tuple(existing["start"])
            ex_end = tuple(existing["end"])
            # Check both orientations
            d1 = distance(ex_start, start) + distance(ex_end, end)
            d2 = distance(ex_start, end) + distance(ex_end, start)
            if d1 < 4 or d2 < 4:
                is_dupe = True
                break

        if not is_dupe:
            result.append(line)

    return result


def extract_vectors_from_page(
    page: "fitz.Page", scale: float = 1.5
) -> Dict[str, Any]:
    """
    Extract vector geometry from a PDF page using PyMuPDF.

    Args:
        page: PyMuPDF page object
        scale: Scale factor for coordinate transformation

    Returns:
        Dictionary with lines, snapPoints, and metadata
    """
    # Get page dimensions
    rect = page.rect
    page_height = rect.height * scale

    # Transform function: PDF coords (origin bottom-left) to display coords (origin top-left, Y-inverted for OpenLayers)
    def transform(x: float, y: float) -> Tuple[float, float]:
        tx = x * scale
        # Invert Y and make negative for OpenLayers coordinate system
        ty = -(page_height - y * scale)
        return (tx, ty)

    # Extract all drawings (paths) from the page
    drawings = page.get_drawings()

    raw_lines: List[Dict[str, Any]] = []

    for path in drawings:
        items = path.get("items", [])

        for item in items:
            kind = item[0]

            if kind == "l":  # Line
                p1 = item[1]  # fitz.Point
                p2 = item[2]  # fitz.Point
                start = transform(p1.x, p1.y)
                end = transform(p2.x, p2.y)

                if distance(start, end) >= 5:
                    raw_lines.append({"start": list(start), "end": list(end)})

            elif kind == "re":  # Rectangle
                rect = item[1]  # fitz.Rect
                corners = [
                    transform(rect.x0, rect.y0),
                    transform(rect.x1, rect.y0),
                    transform(rect.x1, rect.y1),
                    transform(rect.x0, rect.y1),
                ]
                for i in range(4):
                    start = corners[i]
                    end = corners[(i + 1) % 4]
                    if distance(start, end) >= 5:
                        raw_lines.append({"start": list(start), "end": list(end)})

            elif kind == "qu":  # Quad (4 points)
                quad = item[1]  # fitz.Quad
                points = [
                    transform(quad.ul.x, quad.ul.y),
                    transform(quad.ur.x, quad.ur.y),
                    transform(quad.lr.x, quad.lr.y),
                    transform(quad.ll.x, quad.ll.y),
                ]
                for i in range(4):
                    start = points[i]
                    end = points[(i + 1) % 4]
                    if distance(start, end) >= 5:
                        raw_lines.append({"start": list(start), "end": list(end)})

            elif kind == "c":  # Bezier curve - approximate with line
                p1 = item[1]  # Start point
                p4 = item[4]  # End point
                start = transform(p1.x, p1.y)
                end = transform(p4.x, p4.y)
                if distance(start, end) >= 5:
                    raw_lines.append({"start": list(start), "end": list(end)})

    # Clean lines
    cleaned_lines = clean_lines(raw_lines)

    # Generate snap points
    snap_points: List[Dict[str, Any]] = []

    # Endpoints and midpoints
    for line in cleaned_lines:
        start = tuple(line["start"])
        end = tuple(line["end"])

        snap_points.append({"type": "endpoint", "coords": list(start)})
        snap_points.append({"type": "endpoint", "coords": list(end)})
        snap_points.append({"type": "midpoint", "coords": list(midpoint(start, end))})

    # Intersections (limit to first N lines to avoid O(n^2) explosion)
    max_intersection_check = min(len(cleaned_lines), 500)
    for i in range(max_intersection_check):
        for j in range(i + 1, max_intersection_check):
            l1 = cleaned_lines[i]
            l2 = cleaned_lines[j]
            intersection = line_intersection(
                tuple(l1["start"]),
                tuple(l1["end"]),
                tuple(l2["start"]),
                tuple(l2["end"]),
            )
            if intersection:
                snap_points.append({"type": "intersection", "coords": list(intersection)})

    # Dedupe nearby points
    deduped_points = dedupe_points(snap_points, tolerance=2.0)

    return {
        "lines": cleaned_lines,
        "snapPoints": deduped_points,
        "rawPathCount": len(raw_lines),
        "cleanedPathCount": len(cleaned_lines),
    }


def assess_quality(raw_count: int, cleaned_count: int) -> str:
    """Assess quality of extracted vectors."""
    if cleaned_count == 0:
        return "none"
    survival_rate = cleaned_count / raw_count if raw_count > 0 else 0
    if survival_rate > 0.7 and cleaned_count > 50:
        return "good"
    if survival_rate > 0.3 and cleaned_count > 20:
        return "medium"
    return "poor"


class handler(BaseHTTPRequestHandler):
    """Vercel serverless function handler."""

    def do_POST(self):
        """Handle POST request with PDF data."""
        if fitz is None:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "PyMuPDF not installed"}).encode()
            )
            return

        try:
            # Read request body
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            # Get parameters
            pdf_base64 = data.get("pdfData")
            page_num = data.get("pageNum", 1)
            scale = data.get("scale", 1.5)

            if not pdf_base64:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"error": "pdfData is required"}).encode()
                )
                return

            # Decode PDF data
            pdf_bytes = base64.b64decode(pdf_base64)

            # Write to temp file (PyMuPDF works better with files)
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(pdf_bytes)
                temp_path = f.name

            try:
                # Open PDF
                doc = fitz.open(temp_path)

                if page_num < 1 or page_num > len(doc):
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps(
                            {"error": f"Invalid page number. Document has {len(doc)} pages."}
                        ).encode()
                    )
                    return

                # Get page (0-indexed)
                page = doc[page_num - 1]

                # Extract vectors
                result = extract_vectors_from_page(page, scale)

                # Assess quality
                quality = assess_quality(
                    result["rawPathCount"], result["cleanedPathCount"]
                )

                # Build response
                response = {
                    "success": True,
                    "quality": quality,
                    "snapPoints": result["snapPoints"],
                    "lines": result["lines"],
                    "rawPathCount": result["rawPathCount"],
                    "cleanedPathCount": result["cleanedPathCount"],
                    "snapPointCount": len(result["snapPoints"]),
                    "lineCount": len(result["lines"]),
                }

                doc.close()

            finally:
                # Clean up temp file
                os.unlink(temp_path)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": str(e)}).encode()
            )

    def do_GET(self):
        """Health check endpoint."""
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({
                "status": "ok",
                "pymupdf_available": fitz is not None,
                "version": fitz.version if fitz else None,
            }).encode()
        )
