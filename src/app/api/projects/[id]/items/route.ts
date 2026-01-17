import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/db"
import { bids, lineItems } from "@/db/schema"
import { eq, and } from "drizzle-orm"

// GET /api/projects/[id]/items - Get line items
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
    const items = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.bidId, id))

    return NextResponse.json({
      items: items.map((i) => ({
        id: i.id,
        description: i.description,
        symbolCode: i.pageReference,
        quantity: i.estimatedQty,
        unit: i.unit,
        pageNumber: i.pageNumber,
        confidence: i.extractionConfidence || 0.5,
        status: i.reviewStatus || "pending",
        notes: i.notes,
        documentId: i.documentId,
      })),
    })
  } catch (error) {
    console.error("Get items error:", error)
    return NextResponse.json({ error: "Failed to get items" }, { status: 500 })
  }
}

// POST /api/projects/[id]/items - Add new item (quick add)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const { documentId, description, quantity, unit, pageNumber, pageX, pageY, notes } = await req.json()

    if (!documentId || !description) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const [item] = await db
      .insert(lineItems)
      .values({
        bidId: id,
        documentId,
        userId: session.user.id,
        tradeCode: "division_10",
        category: "Manual Entry",
        description,
        estimatedQty: quantity || null,
        unit: unit || "EA",
        pageNumber: pageNumber || null,
        pageX: pageX ?? null,
        pageY: pageY ?? null,
        notes: notes || null,
        reviewStatus: "approved", // Manual entries are auto-approved
        extractionConfidence: 1.0,
        extractedAt: new Date(),
      })
      .returning()

    return NextResponse.json({
      item: {
        id: item.id,
        description: item.description,
        quantity: item.estimatedQty,
        unit: item.unit,
        pageNumber: item.pageNumber,
        status: item.reviewStatus,
        notes: item.notes,
        documentId: item.documentId,
      },
    })
  } catch (error) {
    console.error("Add item error:", error)
    return NextResponse.json({ error: "Failed to add item" }, { status: 500 })
  }
}

// PATCH /api/projects/[id]/items - Update item status or details
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const { itemId, updates } = await req.json()

    if (!itemId) {
      return NextResponse.json({ error: "Item ID required" }, { status: 400 })
    }

    // Build update object
    const updateData: Record<string, any> = {}
    if (updates.status) updateData.reviewStatus = updates.status
    if (updates.description) updateData.description = updates.description
    if (updates.quantity !== undefined) updateData.estimatedQty = updates.quantity
    if (updates.unit) updateData.unit = updates.unit
    if (updates.notes !== undefined) updateData.notes = updates.notes

    if (updates.status === "approved" || updates.status === "skipped") {
      updateData.reviewedAt = new Date()
      updateData.reviewedBy = session.user.id
    }

    await db
      .update(lineItems)
      .set(updateData)
      .where(and(eq(lineItems.id, itemId), eq(lineItems.bidId, id)))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Update item error:", error)
    return NextResponse.json({ error: "Failed to update item" }, { status: 500 })
  }
}
