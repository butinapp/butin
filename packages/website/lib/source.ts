import { docs, docsFr } from 'collections/server'
import { loader } from 'fumadocs-core/source'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource()
})

export const sourceFr = loader({
  baseUrl: '/fr/docs',
  source: docsFr.toFumadocsSource()
})
