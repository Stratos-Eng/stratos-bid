import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sheetVectors, takeoffSheets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

const VectorResultSchema = z.object({
  document_id: z.string().uuid(),
  page_number: z.number().int().min(0),
  vectors: z.object({
    lines: z.array(z.object({
      start: z.tuple([z.number(), z.number()]),
      end: z.tuple([z.number(), z.number()]),
      width: z.number().optional(),
    })),
    snap_points: z.array(z.object({
      type: z.enum(["endpoint", "midpoint", "intersection"]),
      coords: z.tuple([z.number(), z.number()]),
    })),
    quality: z.enum(["good", "medium", "poor", "none"]),
    stats: z.object({
      raw_count: z.number(),
      cleaned_count: z.number(),
      snap_count: z.number(),
    }),
  }),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = VectorResultSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const { document_id, page_number, vectors } = parsed.data;

    // Find the sheet for this document+page
    const [sheet] = await db
      .select()
      .from(takeoffSheets)
      .where(and(
        eq(takeoffSheets.documentId, document_id),
        eq(takeoffSheets.pageNumber, page_number)
      ))
      .limit(1);

    if (!sheet) {
      return NextResponse.json(
        { error: "Sheet not found for document/page" },
        { status: 404 }
      );
    }

    // Upsert vector data
    await db
      .insert(sheetVectors)
      .values({
        sheetId: sheet.id,
        lines: vectors.lines as unknown as null,
        snapPoints: vectors.snap_points as unknown as null,
        rawPathCount: vectors.stats.raw_count,
        cleanedPathCount: vectors.stats.cleaned_count,
        extractedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sheetVectors.sheetId,
        set: {
          lines: vectors.lines as unknown as null,
          snapPoints: vectors.snap_points as unknown as null,
          rawPathCount: vectors.stats.raw_count,
          cleanedPathCount: vectors.stats.cleaned_count,
          extractedAt: new Date(),
        },
      });

    // Update sheet status
    await db
      .update(takeoffSheets)
      .set({
        vectorsReady: true,
        vectorQuality: vectors.quality,
      })
      .where(eq(takeoffSheets.id, sheet.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error storing vectors:", error);
    return NextResponse.json(
      { error: "Failed to store vectors" },
      { status: 500 }
    );
  }
}
