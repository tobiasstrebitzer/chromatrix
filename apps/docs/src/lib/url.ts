// The one place the GitHub Pages base prefix is handled. Astro only auto-prefixes its own asset URLs;
// every handwritten href must come through here or it breaks the moment the site is served from
// /chromatrix instead of /.
const base = import.meta.env.BASE_URL.replace(/\/$/, '')

export function withBase(path: string): string {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}
