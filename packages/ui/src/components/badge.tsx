import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../lib/utils.js'

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0 gap-1 [&>svg]:size-3 transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
        // Soft-fill tones: low-alpha fill + colored text, dark/light aware. The sentiment set
        // (neutral/success/warning/danger/info) colors a role:'status' value. The categorical set below sits
        // in the purple→pink→blue arc — deliberately clear of the sentiment hues — so a role:'category' badge
        // never reads as good/bad; the renderer assigns one per value.
        neutral: 'border-transparent bg-muted text-muted-foreground',
        success: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        warning: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
        danger: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
        info: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300',
        indigo: 'border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
        violet: 'border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300',
        purple: 'border-transparent bg-purple-500/15 text-purple-700 dark:text-purple-300',
        fuchsia: 'border-transparent bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
        pink: 'border-transparent bg-pink-500/15 text-pink-700 dark:text-pink-300',
        cyan: 'border-transparent bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
        teal: 'border-transparent bg-teal-500/15 text-teal-700 dark:text-teal-300',
        rose: 'border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-300'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

const Badge = ({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) => (
  <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
)

export { Badge, badgeVariants }
