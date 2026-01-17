"""
PDF vector extraction using PyMuPDF.

Extracts vector geometry from PDF pages, cleans them, and generates
snap points for precision drawing in the takeoff tool.
"""

import fitz  # PyMuPDF
from typing import Callable, Optional
from .geometry import (
    Point,
    Line,
    distance,
    midpoint,
    lines_collinear,
    line_intersection,
    dedupe_points,
)

# Constants
MIN_LINE_LENGTH = 5.0  # Minimum line length in pixels to keep
MERGE_TOLERANCE = 3.0  # Distance tolerance for merging collinear lines
DEFAULT_DPI = 150  # Default DPI for rendering


def extract_page_vectors(
    pdf_path: str,
    page_number: int,
    dpi: float = DEFAULT_DPI,
    on_progress: Optional[Callable[[float], None]] = None,
) -> dict:
    """
    Extract vector geometry from a PDF page.

    Args:
        pdf_path: Path to the PDF file
        page_number: Page number (0-indexed)
        dpi: Target DPI for scaling (default: 150)
        on_progress: Optional progress callback (0.0 to 1.0)

    Returns:
        Dictionary containing:
        - lines: List of cleaned line segments
        - snap_points: List of snap points (endpoints, midpoints, intersections)
        - quality: Quality assessment ("good", "medium", "poor", "none")
        - stats: Extraction statistics
    """
    if on_progress:
        on_progress(0.1)

    # Open PDF and get page
    doc = fitz.open(pdf_path)
    if page_number >= len(doc):
        raise ValueError(f"Page {page_number} does not exist in PDF")

    page = doc[page_number]

    # Calculate scale factor (PDF uses 72 DPI by default)
    scale = dpi / 72.0

    if on_progress:
        on_progress(0.2)

    # Extract raw lines from page drawings
    raw_lines = extract_raw_lines(page, scale)

    if on_progress:
        on_progress(0.5)

    # Clean lines (filter short, merge collinear)
    cleaned_lines = clean_lines(raw_lines)

    if on_progress:
        on_progress(0.7)

    # Generate snap points
    snap_points = generate_snap_points(cleaned_lines)

    if on_progress:
        on_progress(0.9)

    # Assess quality
    raw_count = len(raw_lines)
    cleaned_count = len(cleaned_lines)
    snap_count = len(snap_points)
    quality = assess_quality(raw_count, cleaned_count, snap_count)

    doc.close()

    if on_progress:
        on_progress(1.0)

    return {
        "lines": [
            {
                "start": list(line[0]),
                "end": list(line[1]),
                "width": line[2] if len(line) > 2 else 1.0,
            }
            for line in cleaned_lines
        ],
        "snap_points": [
            {"type": point["type"], "coords": list(point["coords"])}
            for point in snap_points
        ],
        "quality": quality,
        "stats": {
            "raw_count": raw_count,
            "cleaned_count": cleaned_count,
            "snap_count": snap_count,
        },
    }


def extract_raw_lines(page: fitz.Page, scale: float) -> list[tuple[Point, Point, float]]:
    """
    Extract raw line segments from PDF page drawings.

    Args:
        page: PyMuPDF page object
        scale: Scale factor for converting from PDF points to target DPI

    Returns:
        List of line segments as ((x1, y1), (x2, y2), width) tuples
    """
    lines = []

    # Get page drawings (vector graphics)
    drawings = page.get_drawings()

    for drawing in drawings:
        items = drawing.get("items", [])
        raw_width = drawing.get("width")
        width = (raw_width if raw_width is not None else 1.0) * scale

        for item in items:
            item_type = item[0]

            if item_type == "l":  # Line
                # Format: ("l", Point(x1, y1), Point(x2, y2))
                p1 = item[1]
                p2 = item[2]
                # Scale coordinates
                start = (p1.x * scale, p1.y * scale)
                end = (p2.x * scale, p2.y * scale)
                lines.append((start, end, width))

            elif item_type == "re":  # Rectangle
                # Format: ("re", Rect(x0, y0, x1, y1))
                rect = item[1]
                # Convert rectangle to 4 line segments
                x0, y0, x1, y1 = rect.x0 * scale, rect.y0 * scale, rect.x1 * scale, rect.y1 * scale
                # Top, right, bottom, left
                lines.extend([
                    ((x0, y0), (x1, y0), width),  # Top
                    ((x1, y0), (x1, y1), width),  # Right
                    ((x1, y1), (x0, y1), width),  # Bottom
                    ((x0, y1), (x0, y0), width),  # Left
                ])

            elif item_type == "c":  # Curve (Bezier)
                # Format: ("c", Point(x1, y1), Point(x2, y2), Point(x3, y3), Point(x4, y4))
                # Approximate curve with line segments
                # For MVP, just connect start to end
                # TODO: Better curve approximation
                p1 = item[1]
                p4 = item[4]
                start = (p1.x * scale, p1.y * scale)
                end = (p4.x * scale, p4.y * scale)
                lines.append((start, end, width))

    return lines


def clean_lines(lines: list[tuple[Point, Point, float]]) -> list[tuple[Point, Point, float]]:
    """
    Clean line segments by filtering short lines and merging collinear segments.

    Args:
        lines: List of raw line segments

    Returns:
        List of cleaned line segments
    """
    if not lines:
        return []

    # Step 1: Filter out very short lines
    filtered = []
    for line in lines:
        start, end, width = line
        if distance(start, end) >= MIN_LINE_LENGTH:
            filtered.append(line)

    # Step 2: Merge collinear segments
    merged = merge_collinear_segments(filtered)

    return merged


def merge_collinear_segments(lines: list[tuple[Point, Point, float]]) -> list[tuple[Point, Point, float]]:
    """
    Merge adjacent collinear line segments.

    Args:
        lines: List of line segments to merge

    Returns:
        List of merged line segments
    """
    if len(lines) <= 1:
        return lines

    # Convert to list of [start, end, width, merged_flag]
    segments = [[line[0], line[1], line[2], False] for line in lines]
    merged = []

    for i, seg1 in enumerate(segments):
        if seg1[3]:  # Already merged
            continue

        start1, end1, width1 = seg1[0], seg1[1], seg1[2]
        current_start = start1
        current_end = end1

        # Try to merge with other segments
        changed = True
        while changed:
            changed = False
            for j, seg2 in enumerate(segments):
                if i == j or seg2[3]:
                    continue

                start2, end2, width2 = seg2[0], seg2[1], seg2[2]

                # Check if collinear
                line1 = (current_start, current_end)
                line2 = (start2, end2)

                if not lines_collinear(line1, line2):
                    continue

                # Check if segments are adjacent (share endpoint or very close)
                endpoints = [current_start, current_end, start2, end2]

                # Check if any endpoint pairs are close
                merge_possible = False
                for p1 in [current_start, current_end]:
                    for p2 in [start2, end2]:
                        if distance(p1, p2) < MERGE_TOLERANCE:
                            merge_possible = True
                            break
                    if merge_possible:
                        break

                if merge_possible:
                    # Merge: find the two farthest points
                    all_points = [current_start, current_end, start2, end2]
                    max_dist = 0
                    new_start = current_start
                    new_end = current_end

                    for p1 in all_points:
                        for p2 in all_points:
                            d = distance(p1, p2)
                            if d > max_dist:
                                max_dist = d
                                new_start = p1
                                new_end = p2

                    current_start = new_start
                    current_end = new_end
                    seg2[3] = True  # Mark as merged
                    changed = True

        seg1[3] = True
        merged.append((current_start, current_end, width1))

    return merged


def generate_snap_points(lines: list[tuple[Point, Point, float]]) -> list[dict]:
    """
    Generate snap points from line segments.

    Creates endpoints, midpoints, and intersection points for snapping.

    Args:
        lines: List of cleaned line segments

    Returns:
        List of snap point dictionaries with 'type' and 'coords'
    """
    snap_points = []

    # Extract endpoints and midpoints
    for line in lines:
        start, end, _ = line

        snap_points.append({"type": "endpoint", "coords": start})
        snap_points.append({"type": "endpoint", "coords": end})

        mid = midpoint(start, end)
        snap_points.append({"type": "midpoint", "coords": mid})

    # Find intersections
    for i, line1 in enumerate(lines):
        for j, line2 in enumerate(lines):
            if i >= j:  # Avoid duplicate checks
                continue

            start1, end1, _ = line1
            start2, end2, _ = line2

            intersection = line_intersection((start1, end1), (start2, end2))
            if intersection:
                snap_points.append({"type": "intersection", "coords": intersection})

    # Deduplicate points
    all_coords = [p["coords"] for p in snap_points]
    unique_coords = dedupe_points(all_coords, tolerance=2.0)

    # Rebuild snap points list with unique coordinates
    # Keep track of types for each unique point
    unique_points = []
    for coord in unique_coords:
        # Find the best type for this coordinate (prefer intersection > endpoint > midpoint)
        types = [p["type"] for p in snap_points if distance(p["coords"], coord) < 2.0]

        if "intersection" in types:
            point_type = "intersection"
        elif "endpoint" in types:
            point_type = "endpoint"
        else:
            point_type = "midpoint"

        unique_points.append({"type": point_type, "coords": coord})

    return unique_points


def assess_quality(raw_count: int, cleaned_count: int, snap_count: int) -> str:
    """
    Assess the quality of extracted vectors.

    Args:
        raw_count: Number of raw line segments
        cleaned_count: Number of cleaned line segments
        snap_count: Number of snap points

    Returns:
        Quality rating: "good", "medium", "poor", or "none"
    """
    if cleaned_count == 0:
        return "none"
    elif cleaned_count >= 50 and snap_count >= 100:
        return "good"
    elif cleaned_count >= 20 and snap_count >= 40:
        return "medium"
    else:
        return "poor"
