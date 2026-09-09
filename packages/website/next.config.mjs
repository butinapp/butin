import { createMDX } from 'fumadocs-mdx/next'

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Every route prerenders, so the whole site ships as files and is served by an assets-only Cloudflare Worker with
  // no server behind it. The one thing that used to need a server was docs search; it is an exported index now
  // (app/static.json) that the browser downloads and queries itself.
  output: 'export'
}

const withMDX = createMDX()

export default withMDX(config)
