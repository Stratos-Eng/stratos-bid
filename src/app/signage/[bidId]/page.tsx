import { redirect } from "next/navigation"

// Redirect to the new Projects verification flow
export default async function SignagePage({
  params,
}: {
  params: Promise<{ bidId: string }>
}) {
  const { bidId } = await params
  redirect(`/projects/${bidId}`)
}
