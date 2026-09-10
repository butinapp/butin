import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@butinapp/ui/primitives'
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

// App-level last-resort boundary: a render/throw anywhere in the tree lands here as a styled fallback with a
// Reload, instead of a blank #root. It wraps the providers too, so the fallback can't depend on i18n/theme
// context — copy stays plain English.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error:', error, info.componentStack)
  }

  private reload = (): void => {
    // Hash history under file:// — reload re-runs the bundle and remounts a clean tree.
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Something broke</CardTitle>
            <CardDescription>
              The view hit an unexpected error and stopped rendering. Your captured data is safe — this is a display
              error only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre className="bg-muted text-muted-foreground max-h-40 overflow-auto rounded-md p-3 text-xs">
              {error.message}
            </pre>
            <Button onClick={this.reload}>Reload</Button>
          </CardContent>
        </Card>
      </div>
    )
  }
}
