import type { ComponentProps } from 'react'

import { cn } from '../lib/utils.js'

// A shimmering placeholder block. Compose several to mirror the shape of the content that's loading.
export const Skeleton = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="skeleton" className={cn('bg-muted/60 animate-pulse rounded-md', className)} {...props} />
)
