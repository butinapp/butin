import { useLabels } from '@butinapp/ui/i18n'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@butinapp/ui/primitives'
import { Loader2, PackageOpen } from 'lucide-react'

export type ExtractAllProgressView = { phase: string; message?: string; completed?: number; total?: number }

// A compact, prop-driven action: one button that runs "extract everything". While running it shows a
// spinner + the live phase inline (the running capability id). A tooltip spells out what it does. No IPC —
// the core renderer owns the mutation, the progress subscription, and the completion toast; this just
// renders state + emits onExtract.
export const ExtractAllControl = ({
  running,
  disabled,
  progress,
  onExtract
}: {
  running: boolean
  disabled?: boolean
  progress?: ExtractAllProgressView
  onExtract: () => void
}) => {
  const t = useLabels()
  const phase = progress?.message ?? progress?.phase

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm" variant="outline" disabled={running || disabled} onClick={onExtract}>
          {running ? <Loader2 className="animate-spin" /> : <PackageOpen />}
          {running ? (phase ? `${t.extractAllRunning} ${phase}` : t.extractAllRunning) : t.extractAll}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{t.extractAllHint}</TooltipContent>
    </Tooltip>
  )
}
