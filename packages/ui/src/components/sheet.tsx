import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../lib/utils.js'

// A right-side slide-over (radix Dialog). Used for the connection drawer; theme-portable via shadcn tokens.
export const Sheet = Dialog.Root
export const SheetTrigger = Dialog.Trigger
export const SheetClose = Dialog.Close

export const SheetContent = ({ className, children, ...props }: ComponentProps<typeof Dialog.Content>) => (
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
    <Dialog.Content
      className={cn(
        'bg-background fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l p-6 shadow-lg',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
        className
      )}
      {...props}
    >
      {children}
      <Dialog.Close className="text-muted-foreground hover:text-foreground absolute top-4 right-4">
        <X className="size-4" />
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
)

export const SheetHeader = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-1">{children}</div>
)

export const SheetTitle = ({ className, ...props }: ComponentProps<typeof Dialog.Title>) => (
  <Dialog.Title className={cn('text-lg font-semibold tracking-tight', className)} {...props} />
)
