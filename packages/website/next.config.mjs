import { createMDX } from 'fumadocs-mdx/next'

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true
  // NOTE: static export (`output: 'export'`) lands in the polish phase together with the static
  // search client — the dev-time /api/search route is incompatible with `export`.
}

const withMDX = createMDX()

export default withMDX(config)
