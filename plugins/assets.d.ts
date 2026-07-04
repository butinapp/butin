// Asset imports inlined to a data-URI string via Vite's `?inline` query — how a plugin ships its
// `meta.icon` (the bundler base64-encodes the icon at build time, so it travels over IPC and into a
// snapshot embed as a plain string). vite/client doesn't declare the bare `*?inline` form, and the
// plugin tsconfigs don't reference vite/client, so the declaration lives here and each plugin's
// tsconfig adds it to `include`.
declare module '*?inline' {
  const src: string

  export default src
}
