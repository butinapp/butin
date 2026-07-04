import { useTheme } from 'next-themes'
import { Toaster } from 'sonner'

// Sonner toaster that follows the app's chosen theme (not just the OS).
export const ThemedToaster = () => {
  const { resolvedTheme } = useTheme()

  return <Toaster position="bottom-right" richColors theme={resolvedTheme === 'dark' ? 'dark' : 'light'} />
}
