"""
Unit tests for vector extraction geometry utilities.

Tests core geometry functions used in PDF vector extraction.
"""

import pytest
import math
from src.geometry import (
    Point,
    Line,
    distance,
    midpoint,
    line_angle,
    lines_collinear,
    point_on_line,
    line_intersection,
    dedupe_points,
)


class TestDistance:
    """Tests for distance calculation."""

    def test_distance_simple(self):
        """Test basic distance calculation."""
        p1 = (0.0, 0.0)
        p2 = (3.0, 4.0)
        assert distance(p1, p2) == 5.0

    def test_distance_same_point(self):
        """Test distance between identical points."""
        p1 = (5.0, 5.0)
        p2 = (5.0, 5.0)
        assert distance(p1, p2) == 0.0

    def test_distance_negative_coords(self):
        """Test distance with negative coordinates."""
        p1 = (-3.0, -4.0)
        p2 = (0.0, 0.0)
        assert distance(p1, p2) == 5.0


class TestMidpoint:
    """Tests for midpoint calculation."""

    def test_midpoint_horizontal(self):
        """Test midpoint of horizontal line."""
        p1 = (0.0, 5.0)
        p2 = (10.0, 5.0)
        mid = midpoint(p1, p2)
        assert mid == (5.0, 5.0)

    def test_midpoint_vertical(self):
        """Test midpoint of vertical line."""
        p1 = (5.0, 0.0)
        p2 = (5.0, 10.0)
        mid = midpoint(p1, p2)
        assert mid == (5.0, 5.0)

    def test_midpoint_diagonal(self):
        """Test midpoint of diagonal line."""
        p1 = (0.0, 0.0)
        p2 = (10.0, 10.0)
        mid = midpoint(p1, p2)
        assert mid == (5.0, 5.0)


class TestLineAngle:
    """Tests for line angle calculation."""

    def test_line_angle_horizontal(self):
        """Test angle of horizontal line."""
        line = ((0.0, 0.0), (10.0, 0.0))
        angle = line_angle(line)
        assert abs(angle - 0.0) < 0.001

    def test_line_angle_vertical(self):
        """Test angle of vertical line."""
        line = ((0.0, 0.0), (0.0, 10.0))
        angle = line_angle(line)
        assert abs(angle - math.pi / 2) < 0.001

    def test_line_angle_diagonal(self):
        """Test angle of 45-degree line."""
        line = ((0.0, 0.0), (10.0, 10.0))
        angle = line_angle(line)
        assert abs(angle - math.pi / 4) < 0.001


class TestLinesCollinear:
    """Tests for collinearity check."""

    def test_lines_collinear_parallel_adjacent(self):
        """Test collinear lines that are adjacent."""
        line1 = ((0.0, 0.0), (5.0, 0.0))
        line2 = ((5.0, 0.0), (10.0, 0.0))
        assert lines_collinear(line1, line2)

    def test_lines_not_collinear_perpendicular(self):
        """Test perpendicular lines are not collinear."""
        line1 = ((0.0, 0.0), (5.0, 0.0))
        line2 = ((5.0, 0.0), (5.0, 5.0))
        assert not lines_collinear(line1, line2)

    def test_lines_collinear_separated(self):
        """Test collinear lines with gap."""
        line1 = ((0.0, 0.0), (5.0, 0.0))
        line2 = ((10.0, 0.0), (15.0, 0.0))
        # Should be collinear (same angle, on same line)
        assert lines_collinear(line1, line2)


class TestPointOnLine:
    """Tests for point-on-line check."""

    def test_point_on_line_midpoint(self):
        """Test point at midpoint of line."""
        line = ((0.0, 0.0), (10.0, 0.0))
        point = (5.0, 0.0)
        assert point_on_line(point, line)

    def test_point_not_on_line(self):
        """Test point not on line."""
        line = ((0.0, 0.0), (10.0, 0.0))
        point = (5.0, 5.0)
        assert not point_on_line(point, line)

    def test_point_on_line_endpoint(self):
        """Test point at line endpoint."""
        line = ((0.0, 0.0), (10.0, 0.0))
        point = (10.0, 0.0)
        assert point_on_line(point, line)


class TestLineIntersection:
    """Tests for line intersection."""

    def test_line_intersection_crossing(self):
        """Test two lines that intersect."""
        line1 = ((0.0, 0.0), (10.0, 10.0))
        line2 = ((0.0, 10.0), (10.0, 0.0))
        intersection = line_intersection(line1, line2)
        assert intersection is not None
        assert abs(intersection[0] - 5.0) < 0.001
        assert abs(intersection[1] - 5.0) < 0.001

    def test_line_intersection_parallel(self):
        """Test parallel lines that don't intersect."""
        line1 = ((0.0, 0.0), (10.0, 0.0))
        line2 = ((0.0, 5.0), (10.0, 5.0))
        intersection = line_intersection(line1, line2)
        assert intersection is None

    def test_line_intersection_no_overlap(self):
        """Test lines that would intersect if extended, but don't overlap."""
        line1 = ((0.0, 0.0), (5.0, 0.0))
        line2 = ((10.0, -5.0), (10.0, 5.0))
        intersection = line_intersection(line1, line2)
        assert intersection is None

    def test_line_intersection_t_junction(self):
        """Test T-junction intersection."""
        line1 = ((0.0, 5.0), (10.0, 5.0))  # Horizontal
        line2 = ((5.0, 0.0), (5.0, 5.0))   # Vertical ending at horizontal
        intersection = line_intersection(line1, line2)
        assert intersection is not None
        assert abs(intersection[0] - 5.0) < 0.001
        assert abs(intersection[1] - 5.0) < 0.001


class TestDedupePoints:
    """Tests for point deduplication."""

    def test_dedupe_points_no_duplicates(self):
        """Test deduplication with no duplicates."""
        points = [(0.0, 0.0), (5.0, 5.0), (10.0, 10.0)]
        result = dedupe_points(points, tolerance=2.0)
        assert len(result) == 3

    def test_dedupe_points_exact_duplicates(self):
        """Test deduplication with exact duplicates."""
        points = [(0.0, 0.0), (0.0, 0.0), (5.0, 5.0), (5.0, 5.0)]
        result = dedupe_points(points, tolerance=2.0)
        assert len(result) == 2

    def test_dedupe_points_near_duplicates(self):
        """Test deduplication with near-duplicates within tolerance."""
        points = [(0.0, 0.0), (0.5, 0.5), (5.0, 5.0), (5.3, 5.3)]
        result = dedupe_points(points, tolerance=2.0)
        # Should dedupe to 2 points (0,0) and (5,5) clusters
        assert len(result) == 2

    def test_dedupe_points_empty_list(self):
        """Test deduplication with empty list."""
        points = []
        result = dedupe_points(points)
        assert result == []

    def test_dedupe_points_single_point(self):
        """Test deduplication with single point."""
        points = [(5.0, 5.0)]
        result = dedupe_points(points)
        assert len(result) == 1
        assert result[0] == (5.0, 5.0)
