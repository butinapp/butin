import { useLabels } from '@butinapp/ui/i18n'
import { Button } from '@butinapp/ui/primitives'
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

// The one-time reveal of a recovery code, dismissed only by confirming you saved it. Used wherever Butin mints
// one — enabling a profile's encryption, packing a profile archive — because the contract is the same each
// time: shown once, unrecoverable afterwards, and the only way back in when the passphrase is gone. `title`
// and `blurb` name what the code opens; `notes` is anything the caller wants shown above the confirm.
export const RecoveryCodeReveal = ({
  code,
  title,
  blurb,
  notes,
  onConfirm
}: {
  code: string
  title: string
  blurb: string
  notes?: ReactNode
  onConfirm: () => void
}) => {
  const t = useLabels()
  const [copied, setCopied] = useState(false)

  // Revert the copied confirmation so the control reads "Copy" again if the user lingers on the reveal.
  useEffect(() => {
    if (!copied) {
      return
    }

    const id = setTimeout(() => setCopied(false), 2000)

    return () => clearTimeout(id)
  }, [copied])

  return (
    <div className="bg-card mt-1 flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-xs">{blurb}</p>
      <div className="flex items-center gap-2">
        <code className="bg-muted flex-1 rounded px-2 py-1.5 font-mono text-sm break-all" data-testid="recovery-key">
          {code}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(code)
            setCopied(true)
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t.encCopied : t.encCopy}
        </Button>
      </div>
      {notes}
      <Button size="sm" className="self-end" onClick={onConfirm}>
        {t.encSavedRecovery}
      </Button>
    </div>
  )
}
