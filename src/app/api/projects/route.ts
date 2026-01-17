import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/db"
import { bids, documents, lineItems } from "@/db/schema"
import { eq, and, inArray } from "drizzle-orm"

// POST /api/projects - Create a new project
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { name } = await req.json()

    if (!name?.trim()) {
      return NextResponse.json({ error: "Project name required" }, { status: 400 })
    }

    // Create a bid entry to hold the project
    const [bid] = await db
      .insert(bids)
      .values({
        userId: session.user.id,
        sourcePlatform: "upload",
        sourceBidId: `upload-${Date.now()}`,
        title: name.trim(),
        status: "reviewing",
      })
      .returning()

    return NextResponse.json({
      projectId: bid.id,
      bidId: bid.id,
    })
  } catch (error) {
    console.error("Create project error:", error)
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 })
  }
}

// GET /api/projects - List projects
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const projects = await db
      .select()
      .from(bids)
      .where(eq(bids.userId, session.user.id))
      .orderBy(bids.createdAt)

    return NextResponse.json({ projects })
  } catch (error) {
    console.error("List projects error:", error)
    return NextResponse.json({ error: "Failed to list projects" }, { status: 500 })
  }
}

// DELETE /api/projects - Bulk delete projects
export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { ids } = await req.json()

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No project IDs provided" }, { status: 400 })
    }

    // Verify ownership of all projects
    const userProjects = await db
      .select({ id: bids.id })
      .from(bids)
      .where(and(
        eq(bids.userId, session.user.id),
        inArray(bids.id, ids)
      ))

    const ownedIds = userProjects.map(p => p.id)

    if (ownedIds.length === 0) {
      return NextResponse.json({ error: "No valid projects to delete" }, { status: 404 })
    }

    // Delete related data first (cascade)
    // Delete signage items for documents in these bids
    const docsToDelete = await db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.bidId, ownedIds))

    if (docsToDelete.length > 0) {
      const docIds = docsToDelete.map(d => d.id)
      await db.delete(lineItems).where(inArray(lineItems.documentId, docIds))
    }

    // Delete documents
    await db.delete(documents).where(inArray(documents.bidId, ownedIds))

    // Delete bids (projects)
    await db.delete(bids).where(inArray(bids.id, ownedIds))

    return NextResponse.json({
      deleted: ownedIds.length,
      ids: ownedIds
    })
  } catch (error) {
    console.error("Delete projects error:", error)
    return NextResponse.json({ error: "Failed to delete projects" }, { status: 500 })
  }
}
