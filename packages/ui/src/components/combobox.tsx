import type { ConfigOption } from '@butinapp/sdk'
import { Check, ChevronsUpDown, Loader2, Search, Sparkles } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { useMemo, useRef, useState } from 'react'

import { cn } from '../lib/utils.js'

// A searchable picker whose choices a plugin fetches through its authed client (orgs/projects/accounts).
// It accepts a FREE-TEXT value too — you can paste an id the list doesn't return. The trigger renders the
// matching option's label (falling back to the raw value), so the active selection is always legible.
// `onOpen` fires when the popup opens so the host can fetch options on demand; `loading`/`emptyHint` cover
// the not-yet/never states. Editability never depends on connection — only whether a fresh list can load
// does (host-gated).
export interface ComboboxProps {
  id?: string
  value: string
  onValueChange: (value: string) => void
  options: ConfigOption[]
  loading?: boolean
  disabled?: boolean
  placeholder?: string
  // Shown in the popup when there are no options and nothing is loading (e.g. "Connect to load your orgs").
  emptyHint?: string
  // Fires when the popup opens — the host triggers its (memoized) fetch here.
  onOpen?: () => void
  // Whether a typed query that matches no option offers a "Use <literal>" row (paste-an-id). On by default;
  // a closed picker (filtering a fixed set, like the Logs source filter) sets it false so search never coins
  // a value outside the list.
  allowFreeText?: boolean
}

export const Combobox = ({
  id,
  value,
  onValueChange,
  options,
  loading,
  disabled,
  placeholder,
  emptyHint,
  onOpen,
  allowFreeText = true
}: ComboboxProps) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find((o) => o.value === value)
  // What the trigger shows: the matched option's label, else the raw stored value (a cold relaunch shows the
  // id until the list loads), else the placeholder.
  const triggerText = selected?.label ?? (value || placeholder)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    if (!q) {
      return options
    }

    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [options, query])

  // The typed query is usable as a literal value (paste-an-id fallback) when it matches no option's value.
  const freeText = query.trim()
  const showFreeText = allowFreeText && freeText.length > 0 && !options.some((o) => o.value === freeText)

  const pick = (v: string): void => {
    onValueChange(v)
    setQuery('')
    setOpen(false)
  }

  const onOpenChange = (next: boolean): void => {
    setOpen(next)

    if (next) {
      onOpen?.()
    } else {
      setQuery('')
    }
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger
        id={id}
        disabled={disabled}
        className={cn(
          'border-input dark:bg-input/30 flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50'
        )}
      >
        <span className={cn('truncate', !selected && !value && 'text-muted-foreground')}>{triggerText}</span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-60" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            inputRef.current?.focus()
          }}
          className={cn(
            'bg-popover text-popover-foreground relative z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-md border shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'
          )}
        >
          <div className="flex items-center gap-2 border-b px-2.5">
            <Search className="size-3.5 shrink-0 opacity-60" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()

                  // Enter takes the first match, else the free-text literal — so "type an id, hit Enter" works.
                  if (filtered[0]) {
                    pick(filtered[0].value)
                  } else if (showFreeText) {
                    pick(freeText)
                  }
                }
              }}
              placeholder={placeholder ?? 'Search…'}
              className="placeholder:text-muted-foreground h-9 w-full bg-transparent text-sm outline-none"
            />
          </div>
          <div className="max-h-64 overflow-auto p-1">
            {loading ? (
              <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-xs">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 && !showFreeText ? (
              <div className="text-muted-foreground px-2 py-3 text-xs">{emptyHint ?? 'No matches.'}</div>
            ) : null}

            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none"
              >
                <Check className={cn('mt-0.5 size-4 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{o.label}</span>
                    {o.recommended ? (
                      <span className="text-primary inline-flex items-center gap-0.5 text-[10px] font-medium">
                        <Sparkles className="size-3" /> suggested
                      </span>
                    ) : null}
                  </span>
                  {o.description ? (
                    <span className="text-muted-foreground block truncate text-xs">{o.description}</span>
                  ) : null}
                </span>
              </button>
            ))}

            {showFreeText ? (
              <button
                type="button"
                onClick={() => pick(freeText)}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none"
              >
                <Check className="size-4 shrink-0 opacity-0" />
                <span className="truncate">
                  Use <span className="font-mono">{freeText}</span>
                </span>
              </button>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
