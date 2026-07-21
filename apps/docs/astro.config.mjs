import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

// Static docs site for GitHub Pages (project pages ⇒ everything lives under /chromatrix).
// All internal links must go through withBase() (src/lib/url.ts) so they survive the base prefix.
export default defineConfig({
  site: 'https://tobiasstrebitzer.github.io',
  base: '/chromatrix',
  output: 'static',
  trailingSlash: 'never',
  redirects: {
    '/docs': '/docs/introduction',
  },
  build: {
    format: 'file',
    assets: '_assets',
    inlineStylesheets: 'always',
  },
  markdown: {
    // Dual-theme Shiki with no default color baked in: global.css picks --shiki-light or --shiki-dark
    // off the same [data-theme] attribute the tokens swap on. min-light/min-dark are the most achromatic
    // of the bundled themes, which is the point - code should not be the most colourful thing on the page.
    shikiConfig: {
      themes: { light: 'min-light', dark: 'min-dark' },
      defaultColor: false,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
