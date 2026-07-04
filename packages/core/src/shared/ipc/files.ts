// Which of a service's local folders to resolve / pick. (Plugin-scoped — folderGet/folderPick require a pluginId.)
export type FolderKind = 'service' | 'documents' | 'extracts'

// What `revealFolder` can open in the OS file manager: a service's plugin-scoped folder, or an app-level
// folder ('logs' / 'data' — the ~/butin root) that takes no pluginId. 'partition' opens the active profile's
// Electron browser-session folder (cookies/localStorage), which lives in Electron's userData, NOT under ~/butin.
// One channel for every reveal.
export type RevealTarget = FolderKind | 'logs' | 'data' | 'partition'

// Options the Export modal passes to `exportData`: which enabled services to include (default all), whether to
// vault-seal the file (only honoured on an unlocked encrypted profile), and an explicit destination path.
export type ExportOptionsDto = { serviceIds?: string[]; encrypt?: boolean; destPath?: string }
