import { Check, ChevronDown } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'

import { cn } from '../lib/utils.js'

// A themed dropdown (radix Select). Fully theme-portable: the trigger reads like an Input, the popup uses
// the popover tokens. High-level surface (value + options + onValueChange) — all the settings form needs.
export type SelectOption = {
  value: string
  label: string
}

export const Select = ({
  id,
  value,
  options,
  onValueChange,
  placeholder
}: {
  id?: string
  value: string
  options: SelectOption[]
  onValueChange: (value: string) => void
  placeholder?: string
}) => (
  <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
    <SelectPrimitive.Trigger
      id={id}
      className={cn(
        'border-input dark:bg-input/30 flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-sm whitespace-nowrap shadow-xs outline-none',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] data-[placeholder]:text-muted-foreground'
      )}
    >
      <SelectPrimitive.Value placeholder={placeholder} />
      <SelectPrimitive.Icon>
        <ChevronDown className="size-4 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          'bg-popover text-popover-foreground relative z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'
        )}
      >
        <SelectPrimitive.Viewport className="p-1">
          {options.map((o) => (
            <SelectPrimitive.Item
              key={o.value}
              value={o.value}
              className={cn(
                'focus:bg-accent focus:text-accent-foreground relative flex cursor-pointer items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none'
              )}
            >
              <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
                <Check className="size-4" />
              </SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>
          ))}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
)
