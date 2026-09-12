import type { PluginCategory, TroubleshootingCause } from '@butinapp/sdk'

// The label contract. `@butinapp/ui` is presentational + embeddable, so it can't own a translation
// runtime — instead it defines the shape of every user-facing string and ships an English default.
// The host (core) provides a translated dict via LabelsProvider; an embed with no provider renders
// English. Interpolated/plural strings are functions, so there's no ICU runtime.
export type Locale = 'en' | 'fr'

export type ButinLabels = {
  // BCP-47 tag driving Intl number/date formatting (money, counts, timestamps).
  intlLocale: string

  // App chrome (header / home).
  headline: string
  tagline: string
  libraryTitle: string
  librarySubtitle: string
  dataHeading: string
  homeAria: string

  // Sidebar / shell nav.
  navManagement: string
  navOverview: string
  navDeveloper: string
  navPeople: string
  peopleSummary: (people: number, services: number) => string
  peopleEmpty: string
  logsHeading: string
  navSettings: string
  devNavBrowser: string
  systemHeading: string
  servicesHeading: string
  searchPlaceholder: string
  noServicesMatch: string
  // Shown in place of the list on a fresh install, before any service is installed.
  noServicesInstalled: string
  // Tooltip on an installed-but-disabled service in the sidebar (shown dimmed + inert).
  sidebarDisabledHint: string
  menuLabel: string

  // Roster: Available/Installed tabs, install/uninstall, and the first-run onboarding stepper.
  tabInstalled: string
  tabAvailable: string
  installAction: string
  uninstallAction: string
  uninstallArmed: string
  uninstallConfirm: string
  // Toggle in the armed uninstall panel: also delete the whole on-disk data folder. The …Docs variant names
  // the count of downloaded documents that would be removed.
  uninstallEraseFolder: string
  uninstallEraseFolderDocs: (n: number) => string
  allInstalled: string
  availableSearchPlaceholder: string
  skipForNow: string
  finishSetup: string
  onboardingContinue: string
  onboardingSignInTitle: string
  onboardingSignInBlurb: string
  onboardingSettingsTitle: string
  onboardingSettingsBlurb: string
  onboardingRefreshTitle: string
  onboardingRefreshBlurb: string

  // Structured error guidance (ErrorPanel): the action buttons, the Details disclosure, and the generic
  // per-cause message (a plugin's troubleshooting hint overrides these at the host).
  actionRetry: string
  actionReconnect: string
  actionEditSettings: string
  actionOpenDashboard: string
  actionOpenDocs: string
  errorDetails: string
  failureMessage: Record<TroubleshootingCause, string>

  // Library export (offline viewer bundle of the active profile's cached data).
  exportButton: string
  exportTitle: string
  exportDescription: string
  exportServices: string
  exportSelectAll: string
  exportNoData: string
  exportEncrypt: string
  exportEncryptHint: string
  exportPlaintextWarning: string
  exportPlaintextNote: string
  exportDestination: string
  exportDestinationDefault: string
  exportChange: string
  exportRunning: string
  exportDone: string
  exportReveal: string

  // Toasts (core).
  sessionSaved: string
  sessionSecured: string
  sessionNotCaptured: string
  // Neutral, non-error toast when the login window is closed before any session was captured.
  sessionCanceled: string
  sessionCleared: string
  settingsSaved: string
  dataSaved: (capability: string) => string
  fetchFailed: string

  // App settings page (chrome).
  settingsTitle: string
  settingsSubtitle: string
  themeLabel: string
  themeHint: string
  themeToggle: string
  sectionLanguage: string
  languageHint: string
  sectionDataPrivacy: string
  sectionAbout: string
  // Settings section sub-nav labels (the section names not already covered by a section title).
  settingsNavGeneral: string
  settingsNavAdvanced: string
  settingsNavSystem: string
  settingsNavStorage: string
  settingsNavBrowserSignin: string
  // Browser sign-in: seed a personal-Google (or other) session through a real Chrome the embedded browser can't pass.
  browserSigninTitle: string
  browserSigninLead: string
  browserSigninStepsTitle: string
  browserSigninStep1: string
  browserSigninStep2: string
  browserSigninStep3: string
  browserSigninButton: string
  browserSigninReopen: string
  browserSigninConnected: string
  browserSigninNone: string
  browserSigninBusy: string
  browserSigninSynced: (n: number) => string
  browserSigninError: string
  browserSigninAdvanced: string
  browserSigninUrlLabel: string
  browserSigninPathLabel: string
  browserSigninPathHint: string
  browserSigninRemoveTitle: string
  browserSigninRemoveHint: string
  browserSigninRemove: string
  browserSigninRemoveTooltip: string
  // Settings resilience: a section's pending placeholder + failure toasts for a save / folder reveal.
  settingsLoading: string
  settingsSaveFailed: string
  openFolderFailed: string
  // General: start-page preference.
  startPageLabel: string
  startPageHint: string
  startPageOverview: string
  startPageLast: string
  // Security (Data & Privacy): encrypted-profile auto-lock.
  sectionSecurity: string
  idleLockLabel: string
  idleLockHint: string
  idleLockOff: string
  lockOnSleepLabel: string
  lockOnSleepHint: string
  // Advanced: read-cache window.
  cacheWindowLabel: string
  cacheWindowHint: string
  // Advanced: log capture level + retention.
  logLevelLabel: string
  logLevelHint: string
  logRetentionLabel: string
  logRetentionHint: string
  // Capture behaviour (manual-capture toggle).
  manualCaptureLabel: string
  manualCaptureHint: string
  // Network behaviour (request-pacing toggle).
  paceRequestsLabel: string
  paceRequestsHint: string
  // Developer mode — surfaces debug tooling (the raw ledger in a service's Settings tab).
  devModeSection: string
  devModeLabel: string
  devModeHint: string
  // Display-format settings.
  sectionFormatting: string
  currencyFormatLabel: string
  currencyFormatHint: string
  dateFormatLabel: string
  dateFormatHint: string
  // Currency / FX settings.
  sectionCurrency: string
  baseCurrencyLabel: string
  baseCurrencyHint: string
  exchangeRatesLabel: string
  exchangeRatesHint: string
  // The opt-in for filling rates from a public rate API.
  fetchRatesLabel: string
  fetchRatesHint: string
  exchangeRatesEmpty: string
  // The app's own updates: the opt-out launch check, and the status + actions under the version in About.
  sectionUpdates: string
  autoUpdateLabel: string
  autoUpdateHint: string
  updateCheck: string
  updateChecking: string
  updateUpToDate: (when: string) => string
  updateDownloading: (version: string, percent: number) => string
  updateReady: (version: string) => string
  updateRestart: string
  updateRestartShort: string
  updateError: (message: string) => string
  updateUnavailable: string
  saveRates: string
  // Two-click confirm shared by destructive actions (the per-service uninstall/erase).
  clearDataConfirm: string

  // Portal grid + detail header.
  noServices: string
  sessionLive: string
  locked: string
  reportCount: (n: number) => string
  allServices: string

  // Session form.
  sessionTitle: string
  sessionLiveBadge: string
  sessionStoredDesc: string
  sessionEmptyDesc: string
  capturingSession: string
  recaptureSession: string
  captureSession: string
  clearSession: string
  advancedPaste: string
  hide: string
  pastePlaceholder: string
  save: string

  // Capability card.
  fetch: string
  fetching: string
  completedAt: (when: string) => string

  // Per-service page (tabs).
  refresh: string
  refreshThisTab: string
  refetchAll: string
  notLoadedYet: string
  refreshedAgo: (relative: string, absolute: string) => string
  refreshWarning: string
  connectPrompt: (service: string) => string
  disconnectedWithData: (service: string) => string

  // Overview tiles.
  noDataYet: string
  // The first-launch guidance under the empty Overview, with the action that opens Management.
  noDataYetHint: string
  noDataYetAction: string
  // Shown when spend services can't be rolled up into the base currency (no rate yet / offline): their native
  // amounts are listed instead of blanking the band.
  spendUnconverted: (base: string) => string
  serviceCount: (n: number) => string
  overviewSpending: string
  overviewBalances: string
  overviewOthers: string
  netWorth: string
  itemCount: (n: number) => string
  lastFetched: (when: string) => string

  // Spend trend chart (monthly/daily toggle + year picker).
  chartMonthly: string
  chartDaily: string
  chartYears: string
  chartAllYears: string
  chartEstimated: string
  chartMtdEstimate: string

  // Generic dashboard.
  noRows: string
  tableSelectAll: (n: number) => string
  tableColumns: string
  tableExport: string
  tablePerPage: (n: number) => string
  tablePageOf: (page: number, total: number) => string
  tableRowCount: (n: number) => string
  tablePrev: string
  tableNext: string
  // Expandable rows: the per-row chevron's accessible label + the per-day detail's heading + estimated tag.
  toggleRowDetails: string
  perDayHeading: string
  estimatedTag: string
  // Truncated long-text cell: the copy-to-clipboard action and its post-copy confirmation.
  cellCopy: string
  cellCopied: string

  // Documents capability.
  documentsEmpty: string
  documentsFolderLabel: string
  documentsChangeFolder: string
  downloadSelected: (n: number) => string
  downloadAll: string
  openFolder: string
  openDocument: string
  viewDocument: string
  retryFailed: string
  selectAll: string
  docDownloaded: string
  docDownloading: string
  docFailed: string
  downloadDone: (done: number, skipped: number) => string

  // Per-service settings form.
  serviceSettingsTitle: string
  perServiceConfig: string
  saveSettings: string
  leaveBlank: string

  // Management screen.
  noServicesRegistered: string
  connect: string
  reconnect: string
  extractAll: string
  extractAllRunning: string
  extractAllDone: (tabs: number, files: number) => string
  test: string
  enabledLabel: string
  enableToUseHint: string
  refreshData: string
  extractAllHint: string

  // Data-status toolbar (search + status filter + bulk actions).
  filterAll: string
  filterEnabled: string
  filterConnected: string
  filterUnverified: string
  filterDisconnected: string
  filterIssues: string
  filterDisabled: string
  // Management: connected services whose data is stale (never fetched, or older than the freshness window) —
  // the filter that isolates services you just reconnected so a bulk Refresh-all touches only those.
  filterStale: string
  testAll: string
  refreshAll: string
  // Management: bulk-action labels carrying the count of services the action will process (the visible set).
  testAllCount: (n: number) => string
  refreshAllCount: (n: number) => string
  // Management card: when the service's data was last fetched, and the empty state when it never has been.
  lastRefreshed: (rel: string) => string
  neverRefreshed: string
  // Management: dismiss the post-sweep refresh summary banner.
  dismissSummary: string
  // Management: live "N of M" progress while a bulk Test-all / Refresh-all walks the services.
  testingProgress: (done: number, total: number) => string
  refreshingProgress: (done: number, total: number) => string
  // Management: category section headers (keyed by meta.category; unknown → 'other').
  category: Record<PluginCategory, string>
  // Management: disabled-plugin + probe-first-refresh strings.
  serviceDisabledBanner: string
  refreshSummary: (refreshed: number, needsReconnect: number) => string
  needsReconnect: string

  // Service page — Settings tab + header status pill.
  settingsConnection: string
  settingsConfiguration: string
  settingsService: string
  settingsData: string
  openDashboard: string
  openInButin: string
  refreshAllTabs: string
  testPassed: string
  testFailed: string
  enabledHint: string
  statusConnected: string
  statusDisconnected: string
  statusUnverified: string
  disconnect: string
  eraseData: string
  eraseDataHint: string
  // Appended to the erase tooltip when the service has downloaded documents — reassures the user they survive.
  eraseDataDocsKept: (n: number) => string
  dataErased: string
  moveToProfile: string
  moveToProfileHint: string
  moveConfirmTo: (name: string) => string
  cancel: string
  moveDone: (name: string) => string
  outputFolder: string
  never: string

  // Service page — Settings tab: at-a-glance stats, data inventory, and the "Under the hood" mechanics.
  statRecords: string
  statFiles: string
  statOnDisk: string
  statLastSynced: string
  invCapability: string
  invRecords: string
  invLastFetched: string
  invHistory: string
  invTrend: string
  invView: string
  settingsUnderHood: string
  underHoodSubtitle: string
  mechHowConnects: string
  mechAuth: string
  mechTransport: string
  mechCookieDomains: string
  mechSignIn: string
  mechPlugin: string
  requiresBrowserEngineLabel: string
  // Ledger debug panel (dev-mode only) — the raw daily-change history per capability.
  settingsLedgerDebug: string
  ledgerDebugSubtitle: string
  ledgerLoading: string
  ledgerNoData: string
  ledgerDatasetsTitle: string
  ledgerSeriesTitle: string
  ledgerColRow: string
  ledgerColFirstSeen: string
  ledgerColLastSeen: string
  ledgerColVersions: string
  ledgerRows: string
  ledgerPoints: string
  ledgerDerivedDaily: string
  settingsManage: string

  // Profile manager (the Manage profiles dialog).
  profileSwitchTo: (name: string) => string
  profileCurrent: string
  profileActionsAria: (name: string) => string
  profileRename: string
  profileDuplicate: string
  profileDuplicateLockedHint: string
  profileColor: string
  profileColorAria: (name: string) => string
  profileManageEncryption: string
  profileExport: string
  profileExportLockedHint: string
  profileDelete: string
  profileDeleteConfirm: string
  profileNew: string
  profileNewName: string
  profileAdd: string
  profileSave: string
  profileActive: string
  profileNameAria: string
  // Profile archive — moving a profile to another computer.
  archiveExportTitle: string
  archiveExportBlurb: string
  archivePassphrase: string
  archivePassphraseConfirm: string
  archivePassphraseMismatch: string
  archiveExportSubmit: string
  archiveExporting: string
  archiveRecoveryTitle: string
  archiveRecoveryBlurb: string
  archiveImport: string
  archiveImportTitle: string
  archiveImportBlurb: string
  archiveChooseFile: string
  archiveImportAs: string
  archiveImportSubmit: string
  archiveImporting: string
  archiveWrongPassphrase: string
  archiveContents: (services: number, files: number, size: string) => string
  archivePackedAt: (app: string, when: string) => string
  archiveReHomedNote: (services: string) => string
  archiveUnreadableNote: (count: number) => string
  archiveSourceEncryptedNote: string
  archiveImported: (name: string) => string
  archiveDone: string
  profilesDialogTitle: string
  profilesDialogBlurb: string

  // Per-profile at-rest encryption (the manage-profiles controls + the lock gate).
  encStateOff: string
  encStateLocked: string
  encStateUnlocked: string
  encBadgeLockedAria: string
  encBadgeUnlockedAria: string
  // Banner when saved sign-ins sit on disk without OS encryption and the profile is not encrypted either.
  sessionsUnprotectedBanner: string
  encryptProfile: string
  encryptProfileHint: string
  encMasterPassword: string
  encConfirmPassword: string
  encPasswordMismatch: string
  encEnable: string
  encEnabling: string
  encRecoveryTitle: string
  encRecoveryBlurb: string
  encRecoveryKey: string
  encCopy: string
  encCopied: string
  encSavedRecovery: string
  encDone: string
  encLock: string
  encUnlockToManage: string
  encChangePassword: string
  encChangePasswordTitle: string
  encOldPassword: string
  encNewPassword: string
  encChangeSaved: string
  encWrongPassword: string
  encResetTitle: string
  encResetBlurb: string
  encReset: string
  encWrongRecovery: string
  encDisable: string
  encDisableTitle: string
  encDisableBlurb: string
  encDisableConfirm: string
  encDisabled: string
  encDuplicatePlaintext: string

  // Lock gate (the full-screen unlock prompt shown in place of the app for a locked active profile).
  lockGateTitle: string
  lockGateBlurb: string
  lockGatePassword: string
  lockGateUnlock: string
  lockGateUnlocking: string
  lockGateUseRecovery: string
  lockGateUsePassword: string
  lockGateBadSecret: string
  lockGateSwitchProfile: string
  lockGateForgot: string
  notifications: {
    title: string
    empty: string
    markAll: string
    windowDod: string
    windowWow: string
    windowMom: string
    facetSpend: string
    facetUsage: string
    allServices: string
    up: string
    down: string
    newActivity: string
    fxMissingTitle: string
    fxMissingBody: (currency: string, base: string, service: string) => string
    dismiss: string
    unread: (count: number) => string
    settingsChangeTitle: string
    settingsHealthTitle: string
    settingsFxMissing: string
    settingsHint: string
  }
}

export const en: ButinLabels = {
  intlLocale: 'en-US',

  headline: 'All your accounts. One place.',
  tagline: 'Your data, brought home.',
  libraryTitle: 'Library',
  librarySubtitle: "Everything you've brought home, gathered in one place.",
  dataHeading: 'Data',
  homeAria: 'Home',

  navManagement: 'Management',
  navOverview: 'Overview',
  navDeveloper: 'Developer',
  navPeople: 'People',
  peopleSummary: (people, services) =>
    `${people} ${people === 1 ? 'person' : 'people'} across ${services} ${services === 1 ? 'service' : 'services'}`,
  peopleEmpty: 'No member data yet — services that report team members will show their people here after a refresh.',
  logsHeading: 'Logs',
  navSettings: 'Settings',
  devNavBrowser: 'Navigation browser',
  systemHeading: 'System',
  servicesHeading: 'Services',
  searchPlaceholder: 'Search…',
  noServicesMatch: 'No services match',
  noServicesInstalled: 'Nothing installed yet',
  sidebarDisabledHint: 'Disabled — re-enable in Management',
  menuLabel: 'Menu',

  tabInstalled: 'Installed',
  tabAvailable: 'Available',
  installAction: 'Install',
  uninstallAction: 'Uninstall',
  uninstallArmed: 'Confirm uninstall',
  uninstallConfirm:
    'Uninstall this service? Its stored session, settings, and cached data will be removed. Downloaded files are kept unless you choose to erase them below.',
  uninstallEraseFolder: 'Also delete this service’s data folder (removes downloaded files too)',
  uninstallEraseFolderDocs: (n) =>
    `Also delete this service’s data folder, including ${n.toLocaleString('en-US')} downloaded ${n === 1 ? 'document' : 'documents'}`,
  allInstalled: 'All services installed',
  availableSearchPlaceholder: 'Search services…',
  skipForNow: 'Skip for now',
  finishSetup: 'Finish setup',
  onboardingContinue: 'Continue',
  onboardingSignInTitle: 'Sign in',
  onboardingSignInBlurb:
    'Butin opens the service’s login so you can sign in once. Your session stays encrypted on this machine.',
  onboardingSettingsTitle: 'Settings',
  onboardingSettingsBlurb: 'A few details this service needs before its first fetch.',
  onboardingRefreshTitle: 'First fetch',
  onboardingRefreshBlurb: "Pull this service's data into Butin — files are saved separately, via Save everything.",

  actionRetry: 'Try again',
  actionReconnect: 'Reconnect',
  actionEditSettings: 'Edit settings',
  actionOpenDashboard: 'Open dashboard',
  actionOpenDocs: 'Troubleshooting',
  errorDetails: 'Technical details',
  failureMessage: {
    'session-not-captured': 'The login window closed before Butin captured a session. Sign in again to finish.',
    'session-expired': 'Your session has expired. Reconnect to refresh it.',
    'config-missing': 'This service needs a setting filled in before it can fetch.',
    'config-invalid': 'A setting was rejected. Check the values and try again.',
    'verification-required': 'The service needs to re-verify your browser. Reconnect to continue.',
    permission: 'The service refused this request. You may not have access to this data.',
    network: 'Butin couldn’t reach the service. Check your connection and try again.',
    'data-invalid': 'This service returned data Butin couldn’t make sense of. The service may have changed.',
    unknown: 'Something went wrong fetching this data.'
  },

  exportButton: 'Export',
  exportTitle: 'Export data',
  exportDescription:
    'Exports your saved dashboard data — the overview and each service’s latest cached tabs — as one JSON file for the Butin viewer. No live connection is made; documents and credentials are not included.',
  exportServices: 'Services',
  exportSelectAll: 'Select all',
  exportNoData: 'no data yet',
  exportEncrypt: 'Encrypt this export',
  exportEncryptHint: 'Only this Butin profile can reopen it.',
  exportPlaintextWarning: 'Plaintext — readable by anyone with the file.',
  exportPlaintextNote: 'Output is plaintext (not encrypted).',
  exportDestination: 'Destination',
  exportDestinationDefault: 'Downloads folder',
  exportChange: 'Change…',
  exportRunning: 'Exporting…',
  exportDone: 'Data exported',
  exportReveal: 'Reveal in folder',

  sessionSaved: 'Session saved',
  sessionSecured: 'Session secured',
  sessionNotCaptured: 'Session not captured',
  sessionCanceled: 'Sign-in canceled — no session captured.',
  sessionCleared: 'Session cleared',
  settingsSaved: 'Settings saved',
  dataSaved: (capability) => `${capability} — data saved`,
  fetchFailed: 'Fetch failed',

  settingsTitle: 'Settings',
  settingsSubtitle: 'Appearance, capture, formatting, and your local data.',
  themeLabel: 'Theme',
  themeHint: 'Match your system, or pin light/dark.',
  themeToggle: 'Toggle light/dark',
  sectionLanguage: 'Language',
  languageHint: 'English or French.',
  sectionDataPrivacy: 'Data & privacy',
  sectionAbout: 'About',
  settingsNavGeneral: 'General',
  settingsNavAdvanced: 'Advanced',
  settingsNavSystem: 'System',
  settingsNavStorage: 'Storage',
  settingsNavBrowserSignin: 'Browser sign-in',
  browserSigninTitle: 'Browser sign-in',
  browserSigninLead:
    'Some accounts, personal Google especially, refuse the built-in browser. Sign in once through your own Chrome and Butin keeps the session so your connected services can use it.',
  browserSigninStepsTitle: 'How it works',
  browserSigninStep1: 'Click the button below. Your own Chrome opens on the Google sign-in page.',
  browserSigninStep2: 'Sign in to your account the way you normally would, including any two-step verification.',
  browserSigninStep3: 'Close the Chrome window. Butin brings the session home, and you are set.',
  browserSigninButton: 'Sign in with Chrome',
  browserSigninReopen: 'Open Chrome again',
  browserSigninConnected: 'A browser session is saved.',
  browserSigninNone: 'No browser session saved yet.',
  browserSigninBusy: 'Chrome is open. Sign in there, then close the window to finish.',
  browserSigninSynced: (n) => `Session saved. Brought home ${n} cookie${n === 1 ? '' : 's'}.`,
  browserSigninError: 'Chrome sign-in did not finish. Please try again.',
  browserSigninAdvanced: 'Use a different sign-in URL',
  browserSigninUrlLabel: 'Sign-in URL',
  browserSigninPathLabel: 'Where it is stored',
  browserSigninPathHint: 'A separate Chrome profile Butin created for this. Click the path to open the folder.',
  browserSigninRemoveTitle: 'Remove this saved session',
  browserSigninRemoveHint:
    'Deletes the separate Chrome profile, including its saved Google login and cookies, from your machine. Nothing else is touched, and you can sign in again anytime.',
  browserSigninRemove: 'Remove',
  browserSigninRemoveTooltip: 'Delete the saved Chrome profile and its cookies from this machine.',
  settingsLoading: 'Loading…',
  settingsSaveFailed: "Couldn't save your change",
  openFolderFailed: "Couldn't open that folder",
  startPageLabel: 'Start page',
  startPageHint: 'Where Butin opens when you launch it.',
  startPageOverview: 'Overview',
  startPageLast: 'Where I left off',
  sectionSecurity: 'Security',
  idleLockLabel: 'Auto-lock when idle',
  idleLockHint: 'Lock encrypted profiles after this much inactivity.',
  idleLockOff: 'Never',
  lockOnSleepLabel: 'Lock on sleep',
  lockOnSleepHint: 'Lock encrypted profiles when your computer sleeps.',
  cacheWindowLabel: 'Cache window',
  cacheWindowHint: 'How long a fetched response is reused before refetching — spans a refresh-all run.',
  logLevelLabel: 'Log level',
  logLevelHint: 'What gets recorded. Anything below this level is never captured.',
  logRetentionLabel: 'Keep logs',
  logRetentionHint:
    'Session only keeps logs in the live view without writing files; a window writes daily files pruned past it.',
  manualCaptureLabel: 'Capture manually',
  manualCaptureHint:
    'When sign-in is detected, wait for you to click Capture instead of grabbing the session automatically.',
  paceRequestsLabel: 'Pace requests',
  paceRequestsHint:
    'Space requests to each service by a short random delay (100–500ms) so Butin stays a light, steady client instead of bursting. Turn off for the fastest refreshes.',
  devModeSection: 'Developer',
  devModeLabel: 'Developer mode',
  devModeHint: "Show debug tooling — like the raw daily-change ledger — in each service's Settings tab.",
  sectionFormatting: 'Formatting',
  currencyFormatLabel: 'Currency format',
  currencyFormatHint: 'How money is displayed (style only — amounts are unchanged).',
  dateFormatLabel: 'Date format',
  dateFormatHint: 'How dates and times are shown.',
  sectionCurrency: 'Currency',
  baseCurrencyLabel: 'Base currency',
  baseCurrencyHint: 'The currency the Overview totals are shown in. Other currencies are converted into it.',
  fetchRatesLabel: 'Fetch exchange rates',
  fetchRatesHint:
    'Fills a missing or stale rate from a public rate API (api.frankfurter.dev, then open.er-api.com) when the Overview opens. Off, the rates below are all it uses.',
  exchangeRatesLabel: 'Exchange rates',
  exchangeRatesHint:
    'Value of 1 unit of each currency in your base currency. Without a rate, that currency is shown on its own and left out of combined totals.',
  exchangeRatesEmpty: 'Every connected service already reports in your base currency — no rates needed.',
  sectionUpdates: 'Updates',
  autoUpdateLabel: 'Check for updates on launch',
  autoUpdateHint:
    'Once per launch, Butin asks GitHub for its latest release and downloads it in the background; you choose when to restart. That request carries your IP address and the app version, nothing else.',
  updateCheck: 'Check for updates',
  updateChecking: 'Checking…',
  updateUpToDate: (when) => `Up to date — checked ${when}`,
  updateDownloading: (version, percent) => `Downloading ${version}… ${percent}%`,
  updateReady: (version) => `Butin ${version} is ready`,
  updateRestart: 'Restart to update',
  updateRestartShort: 'Restart',
  updateError: (message) => `Update check failed: ${message}`,
  updateUnavailable: 'Updates apply to the installed app only.',
  saveRates: 'Save rates',
  clearDataConfirm: 'Click again to confirm',

  noServices: 'No services yet.',
  sessionLive: 'session active',
  locked: 'locked',
  reportCount: (n) => `${n} ${n === 1 ? 'report' : 'reports'}`,
  allServices: 'All services',

  sessionTitle: 'Session',
  sessionLiveBadge: 'active',
  sessionStoredDesc: 'Session secured (encrypted). Re-capture it to refresh access.',
  sessionEmptyDesc:
    'Sign in once in a real browser — Butin saves the session, then syncs your data headless from then on.',
  capturingSession: 'Capturing session…',
  recaptureSession: 'Re-capture session',
  captureSession: 'Capture session',
  clearSession: 'Clear session',
  advancedPaste: 'advanced: paste session',
  hide: 'hide',
  pastePlaceholder: 'paste the full cookie header — your session (must include the auth cookie)',
  save: 'Save',

  fetch: 'Fetch',
  fetching: 'Fetching…',
  completedAt: (when) => `completed ${when}`,

  refresh: 'Refresh',
  refreshThisTab: 'Refresh this tab only',
  refetchAll: 'Refetch all history',
  notLoadedYet: 'not loaded yet',
  refreshedAgo: (relative, absolute) => `refreshed ${relative} · ${absolute}`,
  refreshWarning: 'Refresh failed — showing the last loaded data.',
  connectPrompt: (service) => `Connect ${service} to fetch its first report.`,
  disconnectedWithData: (service) => `${service} is disconnected — showing the last loaded data.`,

  noDataYet: 'No data yet',
  noDataYetHint: 'Install a service in Management and sign in once — its data lands here.',
  noDataYetAction: 'Open Management',
  spendUnconverted: (base) => `No ${base} exchange rate yet — showing amounts as reported:`,
  serviceCount: (n) => `${n} ${n === 1 ? 'service' : 'services'}`,
  overviewSpending: 'Spending',
  overviewBalances: 'Balances',
  overviewOthers: 'Others',
  netWorth: 'Net worth',
  itemCount: (n) => `${n} ${n === 1 ? 'item' : 'items'}`,
  lastFetched: (when) => `Fetched ${when}`,

  chartMonthly: 'Monthly',
  chartDaily: 'Daily',
  chartYears: 'Years',
  chartAllYears: 'All years',
  chartEstimated: 'Estimated — no snapshot this day',
  chartMtdEstimate: 'Estimate — month to date',

  noRows: 'No rows.',
  tableSelectAll: (n) => `Select all ${n}`,
  tableColumns: 'Columns',
  tableExport: 'Export',
  tablePerPage: (n) => `${n} / page`,
  tablePageOf: (page, total) => `${page} / ${total}`,
  tableRowCount: (n) => `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}`,
  tablePrev: 'Prev',
  tableNext: 'Next',
  toggleRowDetails: 'Toggle row details',
  perDayHeading: 'Per day',
  estimatedTag: '(est.)',
  cellCopy: 'Copy',
  cellCopied: 'Copied',
  documentsEmpty: 'No documents found.',
  documentsFolderLabel: 'Saving to',
  documentsChangeFolder: 'Change…',
  downloadSelected: (n) => `Download ${n} selected`,
  downloadAll: 'Download all',
  openFolder: 'Open folder',
  openDocument: 'Open',
  viewDocument: 'View',
  retryFailed: 'Retry failed',
  selectAll: 'select all',
  docDownloaded: 'downloaded',
  docDownloading: 'downloading…',
  docFailed: 'failed',
  downloadDone: (done, skipped) => `${done} downloaded${skipped ? `, ${skipped} already on disk` : ''}`,

  serviceSettingsTitle: 'Settings',
  perServiceConfig: 'Per-service config — stored locally, secrets encrypted.',
  saveSettings: 'Save settings',
  leaveBlank: 'leave blank to keep current',

  noServicesRegistered: 'No services registered.',
  connect: 'Connect',
  reconnect: 'Reconnect',
  extractAll: 'Save everything',
  extractAllRunning: 'Saving…',
  extractAllDone: (tabs, files) => `Saved ${tabs} tabs, ${files} files`,
  test: 'Test',
  enabledLabel: 'Enabled',
  enableToUseHint: 'Off — enable to use',
  refreshData: 'Refresh data',
  extractAllHint: 'Fetches every tab and downloads all available files for this service into a local folder.',

  filterAll: 'All',
  filterEnabled: 'Enabled',
  filterConnected: 'Connected',
  filterUnverified: 'Unverified',
  filterDisconnected: 'Disconnected',
  filterIssues: 'Issues',
  filterDisabled: 'Disabled',
  filterStale: 'Needs refresh',
  testAll: 'Test all',
  testAllCount: (n) => `Test all (${n})`,
  refreshAllCount: (n) => `Refresh all (${n})`,
  lastRefreshed: (rel) => `Refreshed ${rel}`,
  neverRefreshed: 'Never refreshed',
  dismissSummary: 'Dismiss',
  testingProgress: (done, total) => `Testing ${done} of ${total}…`,
  refreshingProgress: (done, total) => `Refreshing ${done} of ${total}…`,
  refreshAll: 'Refresh All',
  category: {
    finance: 'Finance',
    cloud: 'Cloud',
    ai: 'AI',
    devtools: 'Dev tools',
    productivity: 'Productivity',
    rental: 'Rentals',
    utilities: 'Utilities',
    other: 'Other'
  },
  serviceDisabledBanner: 'This service is disabled — enable it to fetch data.',
  refreshSummary: (refreshed, needsReconnect) => `${refreshed} refreshed · ${needsReconnect} need reconnect`,
  needsReconnect: 'Reconnect',

  settingsConnection: 'Connection',
  settingsConfiguration: 'Configuration',
  settingsService: 'Service',
  settingsData: 'Data',
  openDashboard: 'Open dashboard',
  openInButin: 'Open in Butin',
  refreshAllTabs: 'Refresh all tabs',
  testPassed: 'connection ok',
  testFailed: 'connection failed',
  enabledHint: 'Disabled services are hidden from the sidebar and Overview.',
  statusConnected: 'connected',
  statusDisconnected: 'disconnected',
  statusUnverified: 'unverified',
  disconnect: 'Disconnect',
  eraseData: 'Erase stored data',
  eraseDataHint:
    'Deletes this service’s cached tab data (reports + the documents list) from your machine. Keeps your session and any downloaded files; you can re-fetch anytime.',
  eraseDataDocsKept: (n) =>
    `${n.toLocaleString('en-US')} downloaded ${n === 1 ? 'document is' : 'documents are'} kept — only cached tab data is erased.`,
  dataErased: 'Stored data erased',
  moveToProfile: 'Move to another profile',
  moveToProfileHint: 'Hand this service’s connection and cached data to another profile.',
  moveConfirmTo: (name) => `Confirm move to ${name}`,
  cancel: 'Cancel',
  moveDone: (name) => `Moved to ${name}`,
  outputFolder: 'Output folder',
  never: 'never',

  statRecords: 'Records cached',
  statFiles: 'Files',
  statOnDisk: 'On disk',
  statLastSynced: 'Last synced',
  invCapability: 'Capability',
  invRecords: 'Records',
  invLastFetched: 'Last fetched',
  invHistory: 'History',
  invTrend: 'Trend',
  invView: 'View',
  settingsUnderHood: 'Under the hood',
  underHoodSubtitle: 'how Butin reads this service',
  mechHowConnects: 'How it connects',
  mechAuth: 'Auth method',
  mechTransport: 'Transport',
  mechCookieDomains: 'Cookie domains',
  mechSignIn: 'Sign-in URL',
  mechPlugin: 'Plugin',
  requiresBrowserEngineLabel: 'Browser engine',
  settingsLedgerDebug: 'Ledger (debug)',
  ledgerDebugSubtitle: 'raw daily-change history',
  ledgerLoading: 'Loading…',
  ledgerNoData: 'No ledger recorded yet',
  ledgerDatasetsTitle: 'Datasets',
  ledgerSeriesTitle: 'Series',
  ledgerColRow: 'Row',
  ledgerColFirstSeen: 'First seen',
  ledgerColLastSeen: 'Last seen',
  ledgerColVersions: 'Versions',
  ledgerRows: 'rows',
  ledgerPoints: 'points',
  ledgerDerivedDaily: 'derived daily',
  settingsManage: 'Manage & danger zone',

  profileSwitchTo: (name) => `Switch to ${name}`,
  profileCurrent: 'Current',
  profileActionsAria: (name) => `${name} actions`,
  profileRename: 'Rename',
  profileDuplicate: 'Duplicate',
  profileDuplicateLockedHint: 'Unlock this profile to duplicate it.',
  profileColor: 'Color',
  profileColorAria: (name) => `Color for ${name}`,
  profileManageEncryption: 'Encryption',
  profileExport: 'Export…',
  profileExportLockedHint: 'Unlock this profile to export it.',
  profileDelete: 'Delete',
  profileDeleteConfirm: 'Confirm delete',
  profileNew: 'New profile',
  profileNewName: 'Profile name',
  profileAdd: 'Create',
  profileSave: 'Save',
  profileActive: 'Active',
  profileNameAria: 'Profile name',
  archiveExportTitle: 'Export this profile',
  archiveExportBlurb:
    'One sealed file holding this profile’s sessions, cached data and every downloaded document — so you can move it to another computer.',
  archivePassphrase: 'Passphrase',
  archivePassphraseConfirm: 'Confirm passphrase',
  archivePassphraseMismatch: 'Passphrases don’t match.',
  archiveExportSubmit: 'Export',
  archiveExporting: 'Packing…',
  archiveRecoveryTitle: 'Save this recovery code',
  archiveRecoveryBlurb: 'It opens the archive if the passphrase is ever lost. It is shown once.',
  archiveImport: 'Import profile…',
  archiveImportTitle: 'Import a profile',
  archiveImportBlurb: 'It lands as a new profile. Nothing you already have is changed.',
  archiveChooseFile: 'Choose file…',
  archiveImportAs: 'Import as',
  archiveImportSubmit: 'Import',
  archiveImporting: 'Restoring…',
  archiveWrongPassphrase: 'That passphrase does not open this archive.',
  archiveContents: (services, files, size) =>
    `${services} service${services === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}, ${size}`,
  archivePackedAt: (app, when) => `Packed ${when} by Butin ${app}`,
  archiveReHomedNote: (services) => `Documents kept outside the profile were brought back into it: ${services}.`,
  archiveUnreadableNote: (count) =>
    `${count} stored secret${count === 1 ? '' : 's'} could not be read on the source machine — sign in to those services again.`,
  archiveSourceEncryptedNote:
    'The source profile was encrypted; this copy is not. Turn encryption on if you want it here.',
  archiveImported: (name) => `${name} imported`,
  archiveDone: 'Done',
  profilesDialogTitle: 'Profiles',
  profilesDialogBlurb: 'Each profile is its own isolated workspace — separate logins, settings, and data.',

  encStateOff: 'Not encrypted',
  encStateLocked: 'Locked',
  encStateUnlocked: 'Encrypted',
  encBadgeLockedAria: 'Profile locked',
  encBadgeUnlockedAria: 'Profile encrypted',
  sessionsUnprotectedBanner:
    'Saved sign-ins are stored without OS encryption on this machine — no usable keyring was found. Encrypt this profile from the profile menu to seal them.',
  encryptProfile: 'Encrypt this profile',
  encryptProfileHint:
    'Protect this profile’s sessions and data with a master password. You’ll need it to unlock the profile on each launch.',
  encMasterPassword: 'Master password',
  encConfirmPassword: 'Confirm password',
  encPasswordMismatch: 'Passwords don’t match.',
  encEnable: 'Encrypt profile',
  encEnabling: 'Encrypting…',
  encRecoveryTitle: 'Save your recovery key',
  encRecoveryBlurb:
    'This is the only way back in if you forget your password. It’s shown once — store it somewhere safe. Butin can’t recover it for you.',
  encRecoveryKey: 'Recovery key',
  encCopy: 'Copy',
  encCopied: 'Copied',
  encSavedRecovery: 'I’ve saved my recovery key',
  encDone: 'Done',
  encLock: 'Lock',
  encUnlockToManage: 'Switch to this profile and unlock it to change its encryption.',
  encChangePassword: 'Change password',
  encChangePasswordTitle: 'Change master password',
  encOldPassword: 'Current password',
  encNewPassword: 'New password',
  encChangeSaved: 'Password changed',
  encWrongPassword: 'Current password is incorrect.',
  encResetTitle: 'Reset with recovery key',
  encResetBlurb: 'Enter your recovery key and choose a new master password.',
  encReset: 'Reset password',
  encWrongRecovery: 'Recovery key is incorrect.',
  encDisable: 'Turn off encryption',
  encDisableTitle: 'Turn off encryption',
  encDisableBlurb:
    'This rewrites this profile’s sessions and data as plaintext on disk. The master password is removed.',
  encDisableConfirm: 'Turn off encryption',
  encDisabled: 'Encryption turned off',
  encDuplicatePlaintext: 'The copy is unencrypted — enable encryption on it if you need it.',

  lockGateTitle: 'This profile is locked',
  lockGateBlurb: 'Enter the master password for this profile to unlock its sessions and data.',
  lockGatePassword: 'Master password',
  lockGateUnlock: 'Unlock',
  lockGateUnlocking: 'Unlocking…',
  lockGateUseRecovery: 'Use recovery key instead',
  lockGateUsePassword: 'Use password instead',
  lockGateBadSecret: 'Incorrect password or recovery key.',
  lockGateSwitchProfile: 'Or switch to another profile',
  lockGateForgot: 'Forgot your password?',
  notifications: {
    title: 'Notifications',
    empty: 'All clear',
    markAll: 'Mark all read',
    windowDod: 'day over day',
    windowWow: 'week over week',
    windowMom: 'month over month',
    facetSpend: 'spend',
    facetUsage: 'usage',
    allServices: 'All services',
    up: 'up',
    down: 'down',
    newActivity: 'started',
    fxMissingTitle: 'Missing exchange rate',
    fxMissingBody: (currency, base, service) =>
      `No ${currency}→${base} rate — ${service} is excluded from cross-service totals. Set it in Settings.`,
    dismiss: 'Dismiss',
    unread: (count) => `${count} unread`,
    settingsChangeTitle: 'Change alerts',
    settingsHealthTitle: 'Data health',
    settingsFxMissing: 'Warn when a service’s currency has no exchange rate',
    settingsHint: 'Percent change that triggers an alert. Blank = off.'
  }
}

export const fr: ButinLabels = {
  intlLocale: 'fr-CA',

  headline: 'Tous vos comptes. Un seul endroit.',
  tagline: 'Vos données, chez vous.',
  libraryTitle: 'Bibliothèque',
  librarySubtitle: 'Tout ce que vous avez rapatrié, réuni au même endroit.',
  dataHeading: 'Données',
  homeAria: 'Accueil',

  navManagement: 'Gestion',
  navOverview: 'Aperçu',
  navDeveloper: 'Développeur',
  navPeople: 'Personnes',
  peopleSummary: (people, services) =>
    `${people} personne${people > 1 ? 's' : ''} sur ${services} service${services > 1 ? 's' : ''}`,
  peopleEmpty:
    'Aucune donnée de membres pour l’instant — les services qui rapportent des membres d’équipe apparaîtront ici après une actualisation.',
  logsHeading: 'Journaux',
  navSettings: 'Réglages',
  devNavBrowser: 'Navigateur',
  systemHeading: 'Système',
  servicesHeading: 'Services',
  searchPlaceholder: 'Rechercher…',
  noServicesMatch: 'Aucun service',
  noServicesInstalled: 'Rien d’installé pour l’instant',
  sidebarDisabledHint: 'Désactivé — réactivez-le dans Gestion',
  menuLabel: 'Menu',

  tabInstalled: 'Installés',
  tabAvailable: 'Disponibles',
  installAction: 'Installer',
  uninstallAction: 'Désinstaller',
  uninstallArmed: 'Confirmer la désinstallation',
  uninstallConfirm:
    'Désinstaller ce service ? Sa session, ses réglages et ses données en cache seront supprimés. Les fichiers téléchargés sont conservés, sauf si vous choisissez de les effacer ci-dessous.',
  uninstallEraseFolder: 'Supprimer aussi le dossier de données du service (efface les fichiers téléchargés)',
  uninstallEraseFolderDocs: (n) =>
    `Supprimer aussi le dossier de données du service, dont ${n.toLocaleString('fr-CA')} ${n === 1 ? 'document téléchargé' : 'documents téléchargés'}`,
  allInstalled: 'Tous les services sont installés',
  availableSearchPlaceholder: 'Rechercher un service…',
  skipForNow: 'Passer pour l’instant',
  finishSetup: 'Terminer la configuration',
  onboardingContinue: 'Continuer',
  onboardingSignInTitle: 'Connexion',
  onboardingSignInBlurb:
    'Butin ouvre la page de connexion du service pour vous y connecter une seule fois. Votre session reste chiffrée sur cet appareil.',
  onboardingSettingsTitle: 'Réglages',
  onboardingSettingsBlurb: 'Quelques détails dont ce service a besoin avant sa première récupération.',
  onboardingRefreshTitle: 'Première récupération',
  onboardingRefreshBlurb:
    'Récupérez les données de ce service — les fichiers s’enregistrent séparément, via Tout enregistrer.',

  actionRetry: 'Réessayer',
  actionReconnect: 'Reconnecter',
  actionEditSettings: 'Modifier les réglages',
  actionOpenDashboard: 'Ouvrir le tableau de bord',
  actionOpenDocs: 'Dépannage',
  errorDetails: 'Détails techniques',
  failureMessage: {
    'session-not-captured':
      'La fenêtre de connexion s’est fermée avant la capture de la session. Reconnectez-vous pour terminer.',
    'session-expired': 'Votre session a expiré. Reconnectez-vous pour la rafraîchir.',
    'config-missing': 'Ce service a besoin d’un réglage avant de pouvoir récupérer les données.',
    'config-invalid': 'Un réglage a été refusé. Vérifiez les valeurs et réessayez.',
    'verification-required': 'Le service doit revérifier votre navigateur. Reconnectez-vous pour continuer.',
    permission: 'Le service a refusé cette requête. Vous n’avez peut-être pas accès à ces données.',
    network: 'Butin n’a pas pu joindre le service. Vérifiez votre connexion et réessayez.',
    'data-invalid': 'Ce service a renvoyé des données que Butin n’a pas pu interpréter. Le service a peut-être changé.',
    unknown: 'Une erreur est survenue lors de la récupération de ces données.'
  },

  exportButton: 'Exporter',
  exportTitle: 'Exporter les données',
  exportDescription:
    'Exporte vos données de tableau de bord enregistrées — la vue d’ensemble et les derniers onglets en cache de chaque service — dans un seul fichier JSON pour la visionneuse Butin. Aucune connexion en direct n’est établie ; les documents et identifiants ne sont pas inclus.',
  exportServices: 'Services',
  exportSelectAll: 'Tout sélectionner',
  exportNoData: 'aucune donnée',
  exportEncrypt: 'Chiffrer cet export',
  exportEncryptHint: 'Seul ce profil Butin pourra le rouvrir.',
  exportPlaintextWarning: 'En clair — lisible par quiconque possède le fichier.',
  exportPlaintextNote: 'Sortie en clair (non chiffrée).',
  exportDestination: 'Destination',
  exportDestinationDefault: 'Dossier Téléchargements',
  exportChange: 'Modifier…',
  exportRunning: 'Exportation…',
  exportDone: 'Données exportées',
  exportReveal: 'Afficher dans le dossier',

  sessionSaved: 'Session enregistrée',
  sessionSecured: 'Session sécurisée',
  sessionNotCaptured: 'Session non capturée',
  sessionCanceled: 'Connexion annulée — aucune session capturée.',
  sessionCleared: 'Session effacée',
  settingsSaved: 'Réglages enregistrés',
  dataSaved: (capability) => `${capability} — données sécurisées`,
  fetchFailed: 'Échec du chargement',

  settingsTitle: 'Réglages',
  settingsSubtitle: 'Apparence, capture, formatage et vos données locales.',
  themeLabel: 'Thème',
  themeHint: 'Suivre le système, ou fixer clair/sombre.',
  themeToggle: 'Basculer clair/sombre',
  sectionLanguage: 'Langue',
  languageHint: 'Anglais ou français.',
  sectionDataPrivacy: 'Données et confidentialité',
  sectionAbout: 'À propos',
  settingsNavGeneral: 'Général',
  settingsNavAdvanced: 'Avancé',
  settingsNavSystem: 'Système',
  settingsNavStorage: 'Stockage',
  settingsNavBrowserSignin: 'Connexion navigateur',
  browserSigninTitle: 'Connexion navigateur',
  browserSigninLead:
    "Certains comptes, Google personnel en particulier, refusent le navigateur intégré. Connectez-vous une fois avec votre propre Chrome et Butin conserve la session pour que vos services connectés l'utilisent.",
  browserSigninStepsTitle: 'Comment ça marche',
  browserSigninStep1: 'Cliquez sur le bouton ci-dessous. Votre propre Chrome ouvre la page de connexion Google.',
  browserSigninStep2:
    'Connectez-vous à votre compte comme vous le faites normalement, y compris toute vérification en deux étapes.',
  browserSigninStep3: 'Fermez la fenêtre Chrome. Butin rapatrie la session, et tout est prêt.',
  browserSigninButton: 'Se connecter avec Chrome',
  browserSigninReopen: 'Rouvrir Chrome',
  browserSigninConnected: 'Une session de navigateur est enregistrée.',
  browserSigninNone: 'Aucune session de navigateur enregistrée.',
  browserSigninBusy: 'Chrome est ouvert. Connectez-vous, puis fermez la fenêtre pour terminer.',
  browserSigninSynced: (n) => `Session enregistrée. ${n} témoin${n === 1 ? '' : 's'} rapatrié${n === 1 ? '' : 's'}.`,
  browserSigninError: "La connexion Chrome ne s'est pas terminée. Veuillez réessayer.",
  browserSigninAdvanced: 'Utiliser une autre URL de connexion',
  browserSigninUrlLabel: 'URL de connexion',
  browserSigninPathLabel: 'Emplacement de stockage',
  browserSigninPathHint:
    'Un profil Chrome distinct créé par Butin pour cela. Cliquez sur le chemin pour ouvrir le dossier.',
  browserSigninRemoveTitle: 'Supprimer cette session enregistrée',
  browserSigninRemoveHint:
    "Supprime le profil Chrome distinct, y compris l'identifiant Google et les témoins enregistrés, de votre machine. Rien d'autre n'est touché, et vous pouvez vous reconnecter à tout moment.",
  browserSigninRemove: 'Supprimer',
  browserSigninRemoveTooltip: 'Supprimer le profil Chrome enregistré et ses témoins de cette machine.',
  settingsLoading: 'Chargement…',
  settingsSaveFailed: "Impossible d'enregistrer la modification",
  openFolderFailed: "Impossible d'ouvrir ce dossier",
  startPageLabel: 'Page de démarrage',
  startPageHint: 'Où Butin s’ouvre au lancement.',
  startPageOverview: 'Aperçu',
  startPageLast: 'Où j’étais',
  sectionSecurity: 'Sécurité',
  idleLockLabel: 'Verrouillage auto en inactivité',
  idleLockHint: 'Verrouille les profils chiffrés après cette durée d’inactivité.',
  idleLockOff: 'Jamais',
  lockOnSleepLabel: 'Verrouiller en veille',
  lockOnSleepHint: 'Verrouille les profils chiffrés quand l’ordinateur se met en veille.',
  cacheWindowLabel: 'Fenêtre de cache',
  cacheWindowHint: 'Durée de réutilisation d’une réponse avant rechargement — couvre une actualisation globale.',
  logLevelLabel: 'Niveau de journalisation',
  logLevelHint: 'Ce qui est enregistré. En dessous de ce niveau, rien n’est capturé.',
  logRetentionLabel: 'Conserver les journaux',
  logRetentionHint:
    'Session seulement garde les journaux dans la vue sans écrire de fichiers ; une fenêtre écrit des fichiers quotidiens nettoyés au-delà.',
  manualCaptureLabel: 'Capturer manuellement',
  manualCaptureHint:
    'À la détection de la connexion, attendre que vous cliquiez sur Capturer au lieu de récupérer la session automatiquement.',
  paceRequestsLabel: 'Espacer les requêtes',
  paceRequestsHint:
    'Espacer les requêtes vers chaque service d’un court délai aléatoire (100–500 ms) pour que Butin reste un client léger et régulier au lieu d’envoyer des rafales. Désactiver pour les rafraîchissements les plus rapides.',
  devModeSection: 'Développement',
  devModeLabel: 'Mode développeur',
  devModeHint:
    'Afficher les outils de débogage — comme le journal brut des changements quotidiens — dans l’onglet Réglages de chaque service.',
  sectionFormatting: 'Format',
  currencyFormatLabel: 'Format monétaire',
  currencyFormatHint: 'Affichage des montants (style seulement — les montants ne changent pas).',
  dateFormatLabel: 'Format de date',
  dateFormatHint: 'Affichage des dates et heures.',
  sectionCurrency: 'Devise',
  baseCurrencyLabel: 'Devise de référence',
  baseCurrencyHint:
    'La devise dans laquelle les totaux de l’aperçu sont affichés. Les autres devises y sont converties.',
  fetchRatesLabel: 'Récupérer les taux de change',
  fetchRatesHint:
    'Complète un taux manquant ou périmé depuis une API publique (api.frankfurter.dev, puis open.er-api.com) à l’ouverture de l’aperçu. Si cette option est désactivée, seuls les taux ci-dessous sont utilisés.',
  exchangeRatesLabel: 'Taux de change',
  exchangeRatesHint:
    'Valeur d’une unité de chaque devise dans votre devise de référence. Sans taux, la devise est affichée seule et exclue des totaux combinés.',
  exchangeRatesEmpty: 'Tous les services connectés utilisent déjà votre devise de référence — aucun taux requis.',
  sectionUpdates: 'Mises à jour',
  autoUpdateLabel: 'Vérifier les mises à jour au lancement',
  autoUpdateHint:
    'À chaque lancement, Butin vérifie auprès de GitHub si une nouvelle version est disponible et la télécharge en arrière-plan ; vous choisissez quand redémarrer. Cette requête transmet uniquement votre adresse IP et la version de l’application, rien d’autre.',
  updateCheck: 'Vérifier les mises à jour',
  updateChecking: 'Vérification…',
  updateUpToDate: (when) => `À jour — vérifié à ${when}`,
  updateDownloading: (version, percent) => `Téléchargement de ${version}… ${percent} %`,
  updateReady: (version) => `La mise à jour Butin ${version} est prête`,
  updateRestart: 'Redémarrer pour mettre à jour',
  updateRestartShort: 'Redémarrer',
  updateError: (message) => `Échec de la vérification : ${message}`,
  updateUnavailable: 'Les mises à jour sont uniquement disponibles pour l’application installée.',
  saveRates: 'Enregistrer les taux',
  clearDataConfirm: 'Cliquez à nouveau pour confirmer',

  noServices: 'Aucun service pour l’instant.',
  sessionLive: 'session active',
  locked: 'verrouillé',
  reportCount: (n) => `${n} ${n === 1 ? 'rapport' : 'rapports'}`,
  allServices: 'Tous les services',

  sessionTitle: 'Session',
  sessionLiveBadge: 'active',
  sessionStoredDesc: 'Session sécurisée (chiffrée). Recapturez-la pour rafraîchir l’accès.',
  sessionEmptyDesc:
    'Connectez-vous une fois dans un vrai navigateur — Butin enregistre la session, puis charge vos données en arrière-plan.',
  capturingSession: 'Capture de la session…',
  recaptureSession: 'Recapturer la session',
  captureSession: 'Capturer la session',
  clearSession: 'Effacer la session',
  advancedPaste: 'avancé : coller la session',
  hide: 'masquer',
  pastePlaceholder: 'collez l’en-tête cookie complet — votre session (doit inclure le cookie d’auth)',
  save: 'Enregistrer',

  fetch: 'Charger',
  fetching: 'Chargement…',
  completedAt: (when) => `terminé ${when}`,

  refresh: 'Rafraîchir',
  refreshThisTab: 'Rafraîchir cet onglet seulement',
  refetchAll: 'Tout retélécharger',
  notLoadedYet: 'pas encore chargé',
  refreshedAgo: (relative, absolute) => `actualisé ${relative} · ${absolute}`,
  refreshWarning: 'Échec du rafraîchissement — affichage des dernières données chargées.',
  connectPrompt: (service) => `Connectez ${service} pour récupérer ses premières données.`,
  disconnectedWithData: (service) => `${service} est déconnecté — affichage des dernières données chargées.`,

  noDataYet: 'Aucune donnée',
  noDataYetHint: 'Installez un service dans Gestion et connectez-vous une fois — ses données arrivent ici.',
  noDataYetAction: 'Ouvrir Gestion',
  spendUnconverted: (base) => `Aucun taux de change ${base} — montants tels que déclarés :`,
  serviceCount: (n) => `${n} ${n === 1 ? 'service' : 'services'}`,
  overviewSpending: 'Dépenses',
  overviewBalances: 'Soldes',
  overviewOthers: 'Autres',
  netWorth: 'Valeur nette',
  itemCount: (n) => `${n} ${n === 1 ? 'élément' : 'éléments'}`,
  lastFetched: (when) => `Récupéré ${when}`,

  chartMonthly: 'Mensuel',
  chartDaily: 'Quotidien',
  chartYears: 'Années',
  chartAllYears: 'Toutes les années',
  chartEstimated: 'Estimé — aucun relevé ce jour',
  chartMtdEstimate: 'Estimation — cumul du mois',

  noRows: 'Aucune ligne.',
  tableSelectAll: (n) => `Tout sélectionner (${n})`,
  tableColumns: 'Colonnes',
  tableExport: 'Exporter',
  tablePerPage: (n) => `${n} / page`,
  tablePageOf: (page, total) => `${page} / ${total}`,
  tableRowCount: (n) => `${n.toLocaleString('fr')} élément${n === 1 ? '' : 's'}`,
  tablePrev: 'Préc.',
  tableNext: 'Suiv.',
  toggleRowDetails: 'Afficher le détail de la ligne',
  perDayHeading: 'Par jour',
  estimatedTag: '(est.)',
  cellCopy: 'Copier',
  cellCopied: 'Copié',
  documentsEmpty: 'Aucun document trouvé.',
  documentsFolderLabel: 'Enregistrer dans',
  documentsChangeFolder: 'Changer…',
  downloadSelected: (n) => `Télécharger ${n} sélectionné${n > 1 ? 's' : ''}`,
  downloadAll: 'Tout télécharger',
  openFolder: 'Ouvrir le dossier',
  openDocument: 'Ouvrir',
  viewDocument: 'Voir',
  retryFailed: 'Réessayer les échecs',
  selectAll: 'tout sélectionner',
  docDownloaded: 'téléchargé',
  docDownloading: 'téléchargement…',
  docFailed: 'échec',
  downloadDone: (done, skipped) =>
    `${done} téléchargé${done > 1 ? 's' : ''}${skipped ? `, ${skipped} déjà sur le disque` : ''}`,

  serviceSettingsTitle: 'Réglages',
  perServiceConfig: 'Config par service — stockée en local, secrets chiffrés.',
  saveSettings: 'Enregistrer',
  leaveBlank: 'laisser vide pour conserver',

  noServicesRegistered: 'Aucun service enregistré.',
  connect: 'Connecter',
  reconnect: 'Reconnecter',
  extractAll: 'Tout enregistrer',
  extractAllRunning: 'Enregistrement…',
  extractAllDone: (tabs, files) => `${tabs} onglets, ${files} fichiers enregistrés`,
  test: 'Tester',
  enabledLabel: 'Activé',
  enableToUseHint: 'Désactivé — activez pour utiliser',
  refreshData: 'Rafraîchir',
  extractAllHint:
    'Charge tous les onglets et télécharge tous les fichiers disponibles de ce service dans un dossier local.',

  filterAll: 'Tous',
  filterEnabled: 'Activés',
  filterConnected: 'Connectés',
  filterUnverified: 'Non vérifiés',
  filterDisconnected: 'Déconnectés',
  filterIssues: 'Problèmes',
  filterDisabled: 'Désactivés',
  filterStale: 'À rafraîchir',
  testAll: 'Tout tester',
  testAllCount: (n) => `Tout tester (${n})`,
  refreshAllCount: (n) => `Tout rafraîchir (${n})`,
  lastRefreshed: (rel) => `Rafraîchi ${rel}`,
  neverRefreshed: 'Jamais rafraîchi',
  dismissSummary: 'Ignorer',
  testingProgress: (done, total) => `Test ${done} sur ${total}…`,
  refreshingProgress: (done, total) => `Rafraîchissement ${done} sur ${total}…`,
  refreshAll: 'Tout rafraîchir',
  category: {
    finance: 'Finance',
    cloud: 'Infonuagique',
    ai: 'IA',
    devtools: 'Outils dev',
    productivity: 'Productivité',
    rental: 'Locations',
    utilities: 'Services publics',
    other: 'Autres'
  },
  serviceDisabledBanner: 'Ce service est désactivé — activez-le pour récupérer les données.',
  refreshSummary: (refreshed, needsReconnect) => `${refreshed} rafraîchi(s) · ${needsReconnect} à reconnecter`,
  needsReconnect: 'Reconnecter',

  settingsConnection: 'Connexion',
  settingsConfiguration: 'Configuration',
  settingsService: 'Service',
  settingsData: 'Données',
  openDashboard: 'Ouvrir le tableau de bord',
  openInButin: 'Ouvrir dans Butin',
  refreshAllTabs: 'Tout rafraîchir',
  testPassed: 'connexion ok',
  testFailed: 'échec de la connexion',
  enabledHint: 'Les services désactivés sont masqués de la barre latérale et de la vue d’ensemble.',
  statusConnected: 'connecté',
  statusDisconnected: 'déconnecté',
  statusUnverified: 'non vérifié',
  disconnect: 'Déconnecter',
  eraseData: 'Effacer les données',
  eraseDataHint:
    'Supprime de votre appareil les données en cache de ce service (rapports + liste des documents). Conserve votre session et les fichiers déjà téléchargés ; vous pouvez tout recharger ensuite.',
  eraseDataDocsKept: (n) =>
    `${n.toLocaleString('fr-CA')} ${n === 1 ? 'document téléchargé est conservé' : 'documents téléchargés sont conservés'} — seules les données en cache sont effacées.`,
  dataErased: 'Données effacées',
  moveToProfile: 'Déplacer vers un autre profil',
  moveToProfileHint: 'Confie la connexion et les données en cache de ce service à un autre profil.',
  moveConfirmTo: (name) => `Confirmer le déplacement vers ${name}`,
  cancel: 'Annuler',
  moveDone: (name) => `Déplacé vers ${name}`,
  outputFolder: 'Dossier de sortie',
  never: 'jamais',

  statRecords: 'Enregistrements en cache',
  statFiles: 'Fichiers',
  statOnDisk: 'Sur le disque',
  statLastSynced: 'Dernière synchro',
  invCapability: 'Capacité',
  invRecords: 'Enregistrements',
  invLastFetched: 'Dernier chargement',
  invHistory: 'Historique',
  invTrend: 'Tendance',
  invView: 'Voir',
  settingsUnderHood: 'Sous le capot',
  underHoodSubtitle: 'comment Butin lit ce service',
  mechHowConnects: 'Mode de connexion',
  mechAuth: 'Méthode d’auth',
  mechTransport: 'Transport',
  mechCookieDomains: 'Domaines de cookies',
  mechSignIn: 'URL de connexion',
  mechPlugin: 'Plugin',
  requiresBrowserEngineLabel: 'Moteur navigateur',
  settingsLedgerDebug: 'Journal (débogage)',
  ledgerDebugSubtitle: 'historique brut des changements quotidiens',
  ledgerLoading: 'Chargement…',
  ledgerNoData: 'Aucun journal enregistré',
  ledgerDatasetsTitle: 'Jeux de données',
  ledgerSeriesTitle: 'Séries',
  ledgerColRow: 'Ligne',
  ledgerColFirstSeen: 'Première vue',
  ledgerColLastSeen: 'Dernière vue',
  ledgerColVersions: 'Versions',
  ledgerRows: 'lignes',
  ledgerPoints: 'points',
  ledgerDerivedDaily: 'quotidien dérivé',
  settingsManage: 'Gérer et zone sensible',

  profileSwitchTo: (name) => `Basculer vers ${name}`,
  profileCurrent: 'Actuel',
  profileActionsAria: (name) => `Actions pour ${name}`,
  profileRename: 'Renommer',
  profileDuplicate: 'Dupliquer',
  profileDuplicateLockedHint: 'Déverrouillez ce profil pour le dupliquer.',
  profileColor: 'Couleur',
  profileColorAria: (name) => `Couleur de ${name}`,
  profileManageEncryption: 'Chiffrement',
  profileExport: 'Exporter…',
  profileExportLockedHint: 'Déverrouillez ce profil pour l’exporter.',
  profileDelete: 'Supprimer',
  profileDeleteConfirm: 'Confirmer la suppression',
  profileNew: 'Nouveau profil',
  profileNewName: 'Nom du profil',
  profileAdd: 'Créer',
  profileSave: 'Enregistrer',
  profileActive: 'Actif',
  profileNameAria: 'Nom du profil',
  archiveExportTitle: 'Exporter ce profil',
  archiveExportBlurb:
    'Un seul fichier scellé contenant les sessions, les données en cache et tous les documents téléchargés de ce profil — pour le transférer vers un autre ordinateur.',
  archivePassphrase: 'Phrase de passe',
  archivePassphraseConfirm: 'Confirmer la phrase de passe',
  archivePassphraseMismatch: 'Les phrases de passe ne correspondent pas.',
  archiveExportSubmit: 'Exporter',
  archiveExporting: 'Archivage…',
  archiveRecoveryTitle: 'Conservez ce code de récupération',
  archiveRecoveryBlurb: 'Il ouvre l’archive si la phrase de passe est perdue. Il n’est affiché qu’une fois.',
  archiveImport: 'Importer un profil…',
  archiveImportTitle: 'Importer un profil',
  archiveImportBlurb: 'Il arrive comme un nouveau profil. Rien de ce que vous avez déjà n’est modifié.',
  archiveChooseFile: 'Choisir un fichier…',
  archiveImportAs: 'Importer sous le nom',
  archiveImportSubmit: 'Importer',
  archiveImporting: 'Restauration…',
  archiveWrongPassphrase: 'Cette phrase de passe n’ouvre pas cette archive.',
  archiveContents: (services, files, size) =>
    `${services} service${services === 1 ? '' : 's'}, ${files} fichier${files === 1 ? '' : 's'}, ${size}`,
  archivePackedAt: (app, when) => `Archivé le ${when} par Butin ${app}`,
  archiveReHomedNote: (services) => `Les documents conservés hors du profil y ont été ramenés : ${services}.`,
  archiveUnreadableNote: (count) =>
    `${count} secret${count === 1 ? '' : 's'} enregistré${count === 1 ? '' : 's'} n’a pas pu être lu sur la machine source — reconnectez-vous à ces services.`,
  archiveSourceEncryptedNote:
    'Le profil source était chiffré ; cette copie ne l’est pas. Activez le chiffrement ici au besoin.',
  archiveImported: (name) => `${name} importé`,
  archiveDone: 'Terminé',
  profilesDialogTitle: 'Profils',
  profilesDialogBlurb: 'Chaque profil est un espace isolé — connexions, réglages et données distincts.',

  encStateOff: 'Non chiffré',
  encStateLocked: 'Verrouillé',
  encStateUnlocked: 'Chiffré',
  encBadgeLockedAria: 'Profil verrouillé',
  encBadgeUnlockedAria: 'Profil chiffré',
  sessionsUnprotectedBanner:
    'Les connexions enregistrées sont stockées sans chiffrement du système sur cette machine — aucun trousseau utilisable. Chiffrez ce profil depuis le menu de profil pour les sceller.',
  encryptProfile: 'Chiffrer ce profil',
  encryptProfileHint:
    'Protégez les sessions et données de ce profil avec un mot de passe maître. Il sera requis pour déverrouiller le profil à chaque lancement.',
  encMasterPassword: 'Mot de passe maître',
  encConfirmPassword: 'Confirmer le mot de passe',
  encPasswordMismatch: 'Les mots de passe ne correspondent pas.',
  encEnable: 'Chiffrer le profil',
  encEnabling: 'Chiffrement…',
  encRecoveryTitle: 'Enregistrez votre clé de récupération',
  encRecoveryBlurb:
    'C’est le seul moyen de revenir si vous oubliez votre mot de passe. Elle s’affiche une seule fois — conservez-la en lieu sûr. Butin ne peut pas la récupérer pour vous.',
  encRecoveryKey: 'Clé de récupération',
  encCopy: 'Copier',
  encCopied: 'Copié',
  encSavedRecovery: 'J’ai enregistré ma clé de récupération',
  encDone: 'Terminé',
  encLock: 'Verrouiller',
  encUnlockToManage: 'Passez à ce profil et déverrouillez-le pour modifier son chiffrement.',
  encChangePassword: 'Changer le mot de passe',
  encChangePasswordTitle: 'Changer le mot de passe maître',
  encOldPassword: 'Mot de passe actuel',
  encNewPassword: 'Nouveau mot de passe',
  encChangeSaved: 'Mot de passe modifié',
  encWrongPassword: 'Le mot de passe actuel est incorrect.',
  encResetTitle: 'Réinitialiser avec la clé de récupération',
  encResetBlurb: 'Saisissez votre clé de récupération et choisissez un nouveau mot de passe maître.',
  encReset: 'Réinitialiser le mot de passe',
  encWrongRecovery: 'La clé de récupération est incorrecte.',
  encDisable: 'Désactiver le chiffrement',
  encDisableTitle: 'Désactiver le chiffrement',
  encDisableBlurb:
    'Cela réécrit en clair sur le disque les sessions et données de ce profil. Le mot de passe maître est supprimé.',
  encDisableConfirm: 'Désactiver le chiffrement',
  encDisabled: 'Chiffrement désactivé',
  encDuplicatePlaintext: 'La copie n’est pas chiffrée — activez le chiffrement dessus au besoin.',

  lockGateTitle: 'Ce profil est verrouillé',
  lockGateBlurb: 'Saisissez le mot de passe maître de ce profil pour déverrouiller ses sessions et données.',
  lockGatePassword: 'Mot de passe maître',
  lockGateUnlock: 'Déverrouiller',
  lockGateUnlocking: 'Déverrouillage…',
  lockGateUseRecovery: 'Utiliser plutôt la clé de récupération',
  lockGateUsePassword: 'Utiliser plutôt le mot de passe',
  lockGateBadSecret: 'Mot de passe ou clé de récupération incorrect.',
  lockGateSwitchProfile: 'Ou passez à un autre profil',
  lockGateForgot: 'Mot de passe oublié ?',
  notifications: {
    title: 'Notifications',
    empty: 'Rien à signaler',
    markAll: 'Tout marquer comme lu',
    windowDod: 'jour sur jour',
    windowWow: 'semaine sur semaine',
    windowMom: 'mois sur mois',
    facetSpend: 'dépenses',
    facetUsage: 'utilisation',
    allServices: 'Tous les services',
    up: 'en hausse de',
    down: 'en baisse de',
    newActivity: 'a démarré',
    fxMissingTitle: 'Taux de change manquant',
    fxMissingBody: (currency, base, service) =>
      `Aucun taux ${currency}→${base} — ${service} est exclu des totaux multi-services. Réglez-le dans les Réglages.`,
    dismiss: 'Ignorer',
    unread: (count) => `${count} non lus`,
    settingsChangeTitle: 'Alertes de variation',
    settingsHealthTitle: 'Santé des données',
    settingsFxMissing: 'Avertir lorsqu’un service utilise une devise sans taux de change',
    settingsHint: 'Variation en pourcentage qui déclenche une alerte. Vide = désactivé.'
  }
}

// All dictionaries, keyed by locale. Typed so a missing key in any locale fails the build.
export const butinLabels: Record<Locale, ButinLabels> = { en, fr }
