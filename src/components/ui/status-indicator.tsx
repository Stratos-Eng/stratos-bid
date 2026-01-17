"use client"

import { cn } from "@/lib/utils"

export type StatusType = "verified" | "flagged" | "pending" | "error"

interface StatusIndicatorProps {
  status: StatusType
  label?: string
  className?: string
}

const statusConfig: Record<StatusType, { color: string; icon: string }> = {
  verified: { color: "bg-green-500", icon: "check" },
  flagged: { color: "bg-yellow-500", icon: "flag" },
  pending: { color: "bg-gray-400", icon: "clock" },
  error: { color: "bg-red-500", icon: "x" },
}

export function StatusIndicator({ status, label, className }: StatusIndicatorProps) {
  const config = statusConfig[status] || statusConfig.pending

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <span className={cn("h-2 w-2 rounded-full", config.color)} />
      {label && (
        <span className="text-xs capitalize text-muted-foreground">
          {label}
        </span>
      )}
    </div>
  )
}
