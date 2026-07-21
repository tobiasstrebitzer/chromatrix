import { glob } from 'astro/loaders'
import { defineCollection, z } from 'astro:content'

// One collection: every docs page is a markdown file under src/content/docs. Sidebar placement and
// ordering are NOT frontmatter concerns - they live in src/nav.ts, so reordering the sidebar never
// touches content files.
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
})

export const collections = { docs }
