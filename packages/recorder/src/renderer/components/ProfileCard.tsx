import type { AuthKind } from '@butinapp/sdk'
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@butinapp/ui/primitives'
import type { ComponentProps } from 'react'

import type {
  Confidence,
  DomainProfile,
  EndpointCategory,
  EndpointHint,
  Guess,
  LoginMode,
  RenderGuess,
  TransportLabel
} from '../../detect/types.js'

type BadgeVariant = ComponentProps<typeof Badge>['variant']

// Confidence reads as a certainty scale, not a sentiment — so it climbs in visual weight (outline → muted
// fill → cyan soft-fill) without borrowing the solid action-cyan, which is reserved for things you can act on.
const confidenceBadge = (c: Confidence): BadgeVariant =>
  c === 'high' ? 'cyan' : c === 'medium' ? 'neutral' : 'outline'

interface GuessRowProps<T> {
  label: string
  guess: Guess<T>
  formatValue: (v: T) => string
}

// Renders one classifier axis: the label, value, confidence badge, and the collapsible evidence list.
const GuessRow = <T,>({ label, guess, formatValue }: GuessRowProps<T>) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words font-mono text-sm font-semibold">{formatValue(guess.value)}</span>
      <Badge variant={confidenceBadge(guess.confidence)} className="shrink-0 self-center">
        {guess.confidence}
      </Badge>
    </div>
    {guess.evidence.length > 0 && (
      <ul className={cn('ml-[6.5rem] flex flex-col gap-0.5', 'list-disc list-inside')}>
        {guess.evidence.map((e, i) => (
          <li key={i} className="break-words text-xs text-muted-foreground">
            {e}
          </li>
        ))}
      </ul>
    )}
  </div>
)

const formatAuth = (kind: AuthKind): string => kind

const formatTransport = (t: TransportLabel): string => (t.requiresBrowserEngine ? `${t.engine} (browser)` : t.engine)

const formatLogin = (mode: LoginMode): string => mode

// Summarises the render shapes found across all hosts in one run or across runs.
const formatRender = (guesses: RenderGuess[]): string =>
  guesses.length === 0 ? '—' : [...new Set(guesses.map((g) => g.shape))].join(', ')

const ENDPOINT_LABELS: Record<EndpointCategory, string> = {
  members: 'Members',
  'api-keys': 'API keys',
  invoices: 'Invoices',
  usage: 'Usage',
  totals: 'Totals'
}
const ENDPOINT_ORDER: EndpointCategory[] = ['members', 'api-keys', 'invoices', 'usage', 'totals']

// Drop scheme/host/query for a compact `METHOD /path` line — the host is shown once on the category header.
const shortEndpoint = (e: EndpointHint): string => {
  try {
    return `${e.method} ${new URL(e.url).pathname}`
  } catch {
    return `${e.method} ${e.url}`
  }
}

interface Props {
  profile: DomainProfile
}

export const ProfileCard = ({ profile }: Props) => {
  // A surface with zero runs has undefined auth/transport — guard before rendering the axis rows.
  const hasData = profile.runCount > 0 && profile.auth != null && profile.transport != null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="font-display text-base">Detected profile</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="text-sm text-muted-foreground">No runs yet — start a recording to populate the profile.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <GuessRow label="Auth" guess={profile.auth} formatValue={formatAuth} />
              {profile.authAlternatives.length > 0 && (
                <p className="ml-[6.5rem] text-xs text-muted-foreground">
                  also detected:{' '}
                  {profile.authAlternatives.map((k) => (
                    <Badge key={k} variant="outline" className="mr-1 font-mono">
                      {k}
                    </Badge>
                  ))}
                </p>
              )}
            </div>
            <GuessRow label="Transport" guess={profile.transport} formatValue={formatTransport} />
            <GuessRow label="Login" guess={profile.login} formatValue={formatLogin} />
            {profile.clearBeforeCapture.value.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">Clear cookies</span>
                  <span className="min-w-0 flex-1 break-words font-mono text-sm font-semibold">
                    {profile.clearBeforeCapture.value.join(', ')}
                  </span>
                  <Badge
                    variant={confidenceBadge(profile.clearBeforeCapture.confidence)}
                    className="shrink-0 self-center"
                  >
                    {profile.clearBeforeCapture.confidence}
                  </Badge>
                </div>
                <ul className="ml-[6.5rem] flex list-inside list-disc flex-col gap-0.5">
                  {profile.clearBeforeCapture.evidence.map((e, i) => (
                    <li key={i} className="break-words text-xs text-muted-foreground">
                      {e}
                    </li>
                  ))}
                </ul>
                <p className="ml-[6.5rem] text-[11px] text-muted-foreground">
                  → review, then list in <span className="font-mono">session.clearCookiesBeforeCapture</span>
                </p>
              </div>
            )}
            {profile.render.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">Render</span>
                  <span className="min-w-0 flex-1 break-words font-mono text-sm font-semibold">
                    {formatRender(profile.render)}
                  </span>
                </div>
                <ul className="ml-[6.5rem] flex flex-col gap-0.5">
                  {profile.render.map((rg, i) => (
                    <li key={i} className="min-w-0 text-xs text-muted-foreground">
                      <span className="font-mono text-foreground">{rg.host}</span>
                      <span className="text-muted-foreground"> — {rg.shape}</span>
                      {rg.sampleUrls.length > 0 && (
                        <span
                          className="block truncate font-mono text-[11px] text-muted-foreground"
                          title={rg.sampleUrls[0]}
                        >
                          {rg.sampleUrls[0]}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {profile.endpoints.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">Endpoints</span>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    paths that look like data worth gathering — a clue, not a contract
                  </span>
                </div>
                <div className="ml-[6.5rem] flex flex-col gap-2">
                  {ENDPOINT_ORDER.filter((cat) => profile.endpoints.some((e) => e.category === cat)).map((cat) => (
                    <div key={cat} className="flex flex-col gap-0.5">
                      <Badge variant="secondary" className="self-start">
                        {ENDPOINT_LABELS[cat]}
                      </Badge>
                      <ul className="flex flex-col gap-0.5">
                        {profile.endpoints
                          .filter((e) => e.category === cat)
                          .map((e, i) => (
                            <li
                              key={i}
                              className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                              title={e.url}
                            >
                              {shortEndpoint(e)}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
