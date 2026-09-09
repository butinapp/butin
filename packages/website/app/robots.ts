import type { MetadataRoute } from 'next'

// `output: 'export'` refuses a metadata route that has not said whether it is static — there is no server to
// regenerate it on, so the intent has to be explicit rather than inferred.
export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/'
    },
    sitemap: 'https://butin.app/sitemap.xml'
  }
}
