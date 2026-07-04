import { ExternalLink, FolderOpen } from 'lucide-react'

import { Button } from '../../components/button.js'
import { useLabels } from '../../i18n/context.js'

// The canonical "open a downloaded file" row action — icon + label — for a downloadable table's trailing
// action column (the local copy, once on disk).
export const OpenFileButton = ({ onClick }: { onClick: () => void }) => {
  const t = useLabels()

  return (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground hover:text-foreground"
      title={t.openDocument}
      onClick={onClick}
    >
      <FolderOpen className="size-3.5" /> {t.openDocument}
    </Button>
  )
}

// The "view the file where it lives" row action — opens the row's URL externally (no local copy needed).
// Sits alongside Open in the trailing action column whenever the row has a URL.
export const ViewFileLink = ({ url }: { url: string }) => {
  const t = useLabels()

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={t.viewDocument}
      className="text-muted-foreground hover:text-foreground inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs"
    >
      <ExternalLink className="size-3.5" /> {t.viewDocument}
    </a>
  )
}
