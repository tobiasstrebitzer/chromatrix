// The one place the GitHub Pages base prefix is handled. Astro only auto-prefixes its own asset URLs;
// every handwritten href must come through here or it breaks the moment the site is served from
// /chromatrix instead of /.
const base = import.meta.env.BASE_URL.replace(/\/$/, '')

export function withBase(path: string): string {
  // Root must resolve to the bare base (`/chromatrix`), never `/chromatrix/` - a trailing slash 404s under
  // `trailingSlash: 'never'` + `format: 'file'`. Non-root paths get a single leading slash.
  const suffix = path === '/' || path === '' ? '' : path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}` || '/'
}
