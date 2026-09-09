import { defineDocs, defineConfig } from 'fumadocs-mdx/config'

export const docs = defineDocs({
  dir: 'content/docs'
})

export const docsFr = defineDocs({
  dir: 'content/docs-fr'
})

export default defineConfig()
