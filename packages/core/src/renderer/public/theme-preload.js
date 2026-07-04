// Apply the persisted in-app theme to <html> before anything paints — the splash + window chrome key off the
// `dark` class, so the loading screen follows the user's choice instead of the OS scheme. A profile switch
// reloads the window, so without this a light-mode app on a dark desktop flashes a dark splash every switch.
// Render-blocking classic script (CSP allows same-origin scripts, not inline), mirroring next-themes' storage
// semantics: the `theme` key holds 'light' | 'dark' | 'system'; 'system' follows the OS; missing → the
// provider default ('dark').
;(function () {
  try {
    const stored = localStorage.getItem('theme') || 'dark'
    const isDark =
      stored === 'dark' || (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    document.documentElement.classList.toggle('dark', isDark)
  } catch (e) {
    /* localStorage unavailable — fall through to the splash's default (dark). */
  }
})()
