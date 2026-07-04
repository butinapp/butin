import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'

import { cn } from '../lib/utils.js'

// Tabs (radix). The default list is a pill rail; variant="line" is an underlined bar.
// The trigger reads the list's variant via the named `group/list` so List + Trigger stay decoupled.
export const Tabs = ({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) => (
  <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-3', className)} {...props} />
)

export const TabsList = ({
  className,
  variant = 'pill',
  ...props
}: ComponentProps<typeof TabsPrimitive.List> & { variant?: 'pill' | 'line' }) => (
  <TabsPrimitive.List
    data-slot="tabs-list"
    data-variant={variant}
    className={cn(
      'group/list inline-flex items-center',
      variant === 'pill'
        ? 'bg-muted text-muted-foreground h-9 w-fit gap-1 rounded-lg p-1'
        : 'text-muted-foreground h-9 w-full gap-4 border-b',
      className
    )}
    {...props}
  />
)

export const TabsTrigger = ({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) => (
  <TabsPrimitive.Trigger
    data-slot="tabs-trigger"
    className={cn(
      "inline-flex cursor-pointer items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      // pill list — active trigger gets a raised card
      'group-data-[variant=pill]/list:rounded-md group-data-[variant=pill]/list:px-2.5 group-data-[variant=pill]/list:py-1 group-data-[variant=pill]/list:data-[state=active]:bg-background group-data-[variant=pill]/list:data-[state=active]:shadow-sm',
      // line list — active trigger grows an underline from the list's bottom border
      'group-data-[variant=line]/list:-mb-px group-data-[variant=line]/list:h-full group-data-[variant=line]/list:border-b-2 group-data-[variant=line]/list:border-transparent group-data-[variant=line]/list:px-0.5 group-data-[variant=line]/list:data-[state=active]:border-primary',
      className
    )}
    {...props}
  />
)

export const TabsContent = ({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) => (
  <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />
)
