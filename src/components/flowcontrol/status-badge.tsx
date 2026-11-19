// ============================================================================
// FlowControl — Semantic status badge
// Maps workflow/document states to consistent semantic colors.
// ============================================================================

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type badgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info'

const variantClasses: Record<badgeVariant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  destructive: 'bg-red-600 text-white',
  outline: 'text-foreground border-border',
  success: 'bg-emerald-600 text-white',
  warning: 'bg-amber-500 text-white',
  info: 'bg-teal-600 text-white',
}

export function StatusBadge({ variant, children, className }: { variant: badgeVariant; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn(variantClasses[variant], 'font-medium border-transparent', className)}>
      {children}
    </Badge>
  )
}
