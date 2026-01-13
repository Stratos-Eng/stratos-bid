import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sheetVectors, takeoffSheets } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string; pageNumber: string }> }
) {
  const { documentId, pageNumber } = await params;
  const pageNum = parseInt(pageNumber, 10);

  if (isNaN(pageNum) || pageNum < 0) {
    return NextResponse.json(
      { error: "Invalid page number" },
      { status: 400 }
    );
  }

  try {
    // Find sheet and vectors via join
    const result = await db
      .select({
        sheetId: takeoffSheets.id,
        documentId: takeoffSheets.documentId,
        pageNumber: takeoffSheets.pageNumber,
        lines: sheetVectors.lines,
        snapPoints: sheetVectors.snapPoints,
        rawPathCount: sheetVectors.rawPathCount,
        cleanedPathCount: sheetVectors.cleanedPathCount,
        extractedAt: sheetVectors.extractedAt,
      })
      .from(takeoffSheets)
      .leftJoin(sheetVectors, eq(sheetVectors.sheetId, takeoffSheets.id))
      .where(and(
        eq(takeoffSheets.documentId, documentId),
        eq(takeoffSheets.pageNumber, pageNum)
      ))
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Sheet not found", status: "not_found" },
        { status: 404 }
      );
    }

    const data = result[0];

    if (!data.extractedAt) {
      return NextResponse.json(
        { error: "Vectors not extracted", status: "not_extracted" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      documentId: data.documentId,
      pageNumber: data.pageNumber,
      lines: data.lines,
      snapPoints: data.snapPoints,
      stats: {
        rawCount: data.rawPathCount,
        cleanedCount: data.cleanedPathCount,
      },
      extractedAt: data.extractedAt,
    });
  } catch (error) {
    console.error("Error fetching vectors:", error);
    return NextResponse.json(
      { error: "Failed to fetch vectors" },
      { status: 500 }
    );
  }
}
