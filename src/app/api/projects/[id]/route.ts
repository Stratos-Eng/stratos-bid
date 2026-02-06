import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/db"
import { bids, documents, lineItems } from "@/db/schema"
import { eq, and } from "drizzle-orm"

// GET /api/projects/[id] - Get project with documents and items
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    // Get project/bid
    const [project] = await db
      .select()
      .from(bids)
      .where(and(eq(bids.id, id), eq(bids.userId, session.user.id)))
      .limit(1)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    // Get documents
    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.bidId, id))

    // Get line items
    const items = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.bidId, id))

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.title,
        status: project.status,
        createdAt: project.createdAt,
      },
      documents: docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        // pageCount may be null at upload time (we defer metadata for huge folders)
        pageCount: d.pageCount ?? 1,
        extractionStatus: d.extractionStatus,
      })),
      items: items.map((i) => ({
        id: i.id,
        description: i.description,
        symbolCode: i.pageReference,
        quantity: i.estimatedQty,
        unit: i.unit,
        pageNumber: i.pageNumber,
        pageX: i.pageX,
        pageY: i.pageY,
        confidence: i.extractionConfidence || 0.5,
        status: i.reviewStatus || "pending",
        notes: i.notes,
        documentId: i.documentId,
      })),
    })
  } catch (error) {
    console.error("Get project error:", error instanceof Error ? error.stack : error)
    return NextResponse.json({
      error: "Failed to get project",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 })
  }
}
