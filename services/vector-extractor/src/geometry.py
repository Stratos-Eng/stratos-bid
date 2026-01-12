"""
Geometry utility functions for vector extraction.

Provides functions for distance calculations, line operations,
collinearity checks, and point deduplication.
"""

import math
from typing import Optional

# Type aliases
Point = tuple[float, float]
Line = tuple[Point, Point]


def distance(p1: Point, p2: Point) -> float:
    """
    Calculate Euclidean distance between two points.

    Args:
        p1: First point (x, y)
        p2: Second point (x, y)

    Returns:
        Distance between the points
    """
    return math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2)


def midpoint(p1: Point, p2: Point) -> Point:
    """
    Calculate the midpoint of a line segment.

    Args:
        p1: First endpoint (x, y)
        p2: Second endpoint (x, y)

    Returns:
        Midpoint coordinates (x, y)
    """
    return ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)


def line_angle(line: Line) -> float:
    """
    Calculate the normalized angle of a line in radians.

    Normalizes the angle to [0, π) to treat lines as non-directional.

    Args:
        line: Line segment ((x1, y1), (x2, y2))

    Returns:
        Angle in radians, normalized to [0, π)
    """
    p1, p2 = line
    angle = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    # Normalize to [0, π) - treat line as non-directional
    if angle < 0:
        angle += math.pi
    return angle


def lines_collinear(line1: Line, line2: Line, angle_tolerance: float = 0.05) -> bool:
    """
    Check if two lines are collinear (parallel and overlapping or adjacent).

    Args:
        line1: First line segment
        line2: Second line segment
        angle_tolerance: Maximum angle difference in radians (default: ~2.86 degrees)

    Returns:
        True if lines are collinear, False otherwise
    """
    # Check if angles are similar (parallel)
    angle1 = line_angle(line1)
    angle2 = line_angle(line2)
    angle_diff = abs(angle1 - angle2)

    # Handle wrap-around at π
    if angle_diff > math.pi / 2:
        angle_diff = math.pi - angle_diff

    if angle_diff > angle_tolerance:
        return False

    # Check if one line's endpoints lie on the other line's extension
    # Use point-to-line distance check
    p1_1, p1_2 = line1
    p2_1, p2_2 = line2

    # Calculate point-to-line distances
    def point_to_line_distance(point: Point, line: Line) -> float:
        """Calculate perpendicular distance from point to line."""
        (x1, y1), (x2, y2) = line
        px, py = point

        # Line length
        line_len = distance((x1, y1), (x2, y2))
        if line_len == 0:
            return distance(point, (x1, y1))

        # Cross product to get perpendicular distance
        numerator = abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1)
        return numerator / line_len

    # Check if endpoints of line2 are close to line1's extension
    dist1 = point_to_line_distance(p2_1, line1)
    dist2 = point_to_line_distance(p2_2, line1)

    # If both endpoints are close to the line, they're collinear
    tolerance = 3.0  # pixels
    return dist1 < tolerance and dist2 < tolerance


def point_on_line(point: Point, line: Line, tolerance: float = 1.0) -> bool:
    """
    Check if a point lies on a line segment (within tolerance).

    Args:
        point: Point to check (x, y)
        line: Line segment ((x1, y1), (x2, y2))
        tolerance: Distance tolerance in pixels

    Returns:
        True if point is on the line segment, False otherwise
    """
    (x1, y1), (x2, y2) = line
    px, py = point

    # Check if point is within bounding box (with tolerance)
    min_x = min(x1, x2) - tolerance
    max_x = max(x1, x2) + tolerance
    min_y = min(y1, y2) - tolerance
    max_y = max(y1, y2) + tolerance

    if not (min_x <= px <= max_x and min_y <= py <= max_y):
        return False

    # Calculate distance from point to line
    line_len = distance((x1, y1), (x2, y2))
    if line_len == 0:
        return distance(point, (x1, y1)) <= tolerance

    # Cross product to get perpendicular distance
    numerator = abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1)
    dist = numerator / line_len

    return dist <= tolerance


def line_intersection(line1: Line, line2: Line) -> Optional[Point]:
    """
    Find the intersection point of two line segments.

    Args:
        line1: First line segment ((x1, y1), (x2, y2))
        line2: Second line segment ((x3, y3), (x4, y4))

    Returns:
        Intersection point (x, y) if segments intersect, None otherwise
    """
    (x1, y1), (x2, y2) = line1
    (x3, y3), (x4, y4) = line2

    # Calculate denominators and numerators for parametric equations
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)

    # Lines are parallel or coincident
    if abs(denom) < 1e-10:
        return None

    # Calculate intersection parameters
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom

    # Check if intersection is within both segments
    if 0 <= t <= 1 and 0 <= u <= 1:
        # Calculate intersection point
        ix = x1 + t * (x2 - x1)
        iy = y1 + t * (y2 - y1)
        return (ix, iy)

    return None


def dedupe_points(points: list[Point], tolerance: float = 2.0) -> list[Point]:
    """
    Remove duplicate points within a given tolerance.

    Args:
        points: List of points to deduplicate
        tolerance: Maximum distance to consider points as duplicates

    Returns:
        List of unique points
    """
    if not points:
        return []

    unique = [points[0]]

    for point in points[1:]:
        # Check if point is close to any existing unique point
        is_duplicate = False
        for existing in unique:
            if distance(point, existing) < tolerance:
                is_duplicate = True
                break

        if not is_duplicate:
            unique.append(point)

    return unique
