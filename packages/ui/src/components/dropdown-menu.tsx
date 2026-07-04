import { Check } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'

import { cn } from '../lib/utils.js'

// Small app-styled dropdown (radix) — outside-click + escape dismiss for free. Used for the DataTable
// column menu, export menu, and page-size picker. CheckboxItem stays open on toggle (multi-select menus).
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export const DropdownMenuContent = ({
  className,
  sideOffset = 4,
  align = 'end',
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      sideOffset={sideOffset}
      align={align}
      className={cn(
        'bg-popover text-popover-foreground z-50 min-w-32 overflow-hidden rounded-md border p-1 shadow-md',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
)

export const DropdownMenuItem = ({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) => (
  <DropdownMenuPrimitive.Item
    className={cn(
      'focus:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none select-none',
      className
    )}
    {...props}
  />
)

export const DropdownMenuCheckboxItem = ({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) => (
  <DropdownMenuPrimitive.CheckboxItem
    // Keep the menu open while toggling several columns in a row.
    onSelect={(e) => e.preventDefault()}
    className={cn(
      'focus:bg-accent relative flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-6 text-xs outline-none select-none',
      className
    )}
    {...props}
  >
    <span className="absolute left-1 flex size-4 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-3.5" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
)
