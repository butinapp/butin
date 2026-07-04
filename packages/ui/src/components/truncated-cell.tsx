import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { useLabels } from '../i18n/context.js'

// A width-capped table cell for long free-text values. The value shows as one ellipsized line (a native
// `title` gives a hover peek); clicking opens a popover holding the full, selectable, copyable value. Plain
// useState (not a radix popover) so it opens under fireEvent.click in jsdom — radix menus need pointer-capture
// jsdom lacks. Empty text renders nothing.
export const TruncatedCell = ({ text }: { text: string }) => {
  const t = useLabels()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (text === '') {
    return null
  }

  const copy = () => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="relative">
      <button
        type="button"
        title={text}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:text-foreground block w-full max-w-full truncate text-left"
      >
        {text}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            className="bg-popover absolute left-0 z-50 mt-1 w-[min(34rem,80vw)] rounded-md border p-2 shadow-md"
          >
            <p className="max-h-[60vh] overflow-auto text-sm whitespace-pre-wrap select-text">{text}</p>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={copy}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? t.cellCopied : t.cellCopy}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
