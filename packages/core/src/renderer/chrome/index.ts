// The Butin app's chrome: the application shell + sidebar, per-service page scaffolding,
// providers/onboarding/settings/logs/notifications panels, profile + encryption management, and the
// export/extract flows. Prop-driven (the route containers own IPC and feed these), but they
// encode the APP's structure — so they live in core, not in the embeddable @butinapp/ui.

// The embeddable shell scaffolding (AppShell · Sidebar · ServiceTabs · ThemeToggle · ConnDot) lives in
// @butinapp/ui/shell — import it from there, not here. This barrel is the APP-specific chrome only.
export { ServicePageShell } from './shell/service-page-shell.js'
export { ServiceSettingsPanel } from './shell/service-settings-panel.js'
export type {
  ServiceSettingsBusy,
  ServiceInventoryRow,
  ServiceMechanicsView,
  FolderStatsView,
  MoveTargetProfile
} from './shell/service-settings-panel.js'

// Profiles + at-rest encryption
export { ProfileSwitcher } from './shell/profile-switcher.js'
export type { ProfileOption } from './shell/profile-switcher.js'
export { ManageProfiles } from './shell/manage-profiles.js'
export type { ManageProfileRow } from './shell/manage-profiles.js'
export { EncryptionBadge } from './shell/encryption-badge.js'
export type { VaultState } from './shell/encryption-badge.js'
export { UnlockScreen } from './shell/unlock-screen.js'
export type { UnlockProfile } from './shell/unlock-screen.js'
export { ProfileEncryptionControls } from './shell/profile-encryption-controls.js'
export type { ProfileEncryptionActions } from './shell/profile-encryption-controls.js'
export { ProfileExportPanel, ProfileImportPanel } from './shell/profile-archive-controls.js'
export type {
  ArchiveExportRow,
  ArchivePreviewRow,
  ArchiveProgressRow,
  ProfileArchiveActions
} from './shell/profile-archive-controls.js'

// Service roster + onboarding + per-service panels
export { ProvidersPage } from './providers.js'
export type { ProviderView, ProviderBusy, ProviderAction, BulkProgress } from './providers.js'
export { AvailableCatalog } from './available-catalog.js'
export { OnboardingStepper } from './onboarding/onboarding-stepper.js'
export type { OnboardingStepView, OnboardingStepStatus } from './onboarding/onboarding-stepper.js'
export { ErrorPanel } from './error-panel.js'
export { RefreshProgress } from './refresh-progress.js'
export type { RefreshProgressItem, RefreshStepStatus } from './refresh-progress.js'
export { PluginConfigForm } from './settings/plugin-config-form.js'
export type { PluginConfigFormProps } from './settings/plugin-config-form.js'
export { LogViewer } from './logs/log-viewer.js'
export type { LogViewerEntry, LogViewerLevel, LogViewerProps } from './logs/log-viewer.js'
export { DeveloperPanel } from './developer/developer-panel.js'

// Notifications + alerts
export { NotificationBell } from './notifications/notification-bell.js'
export type { NotificationBellProps } from './notifications/notification-bell.js'
export { AlertsPane } from './notifications/alerts-pane.js'
export type { AlertsPaneLabels } from './notifications/alerts-pane.js'
export { formatNotification } from './notifications/format-notification.js'
export type { FormatContext, NotificationLabels } from './notifications/format-notification.js'
export type { NotificationView, AlertConfigView, AlertWindow, AlertFacet } from './notifications/types.js'

// Export / extract
export { ExtractAllControl } from './extract/extract-all-control.js'
export type { ExtractAllProgressView } from './extract/extract-all-control.js'
export { ExportDialog } from './export/export-dialog.js'
export type { ExportServiceRow } from './export/export-dialog.js'
