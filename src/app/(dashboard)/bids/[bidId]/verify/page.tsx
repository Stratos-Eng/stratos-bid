import { redirect } from "next/navigation"

// Redirect to the new Projects verification flow
// The bidId is the same as projectId since they share the same underlying data model
export default async function VerificationPage({
  params,
}: {
  params: Promise<{ bidId: string }>
}) {
  const { bidId } = await params
  redirect(`/projects/${bidId}`)
}
