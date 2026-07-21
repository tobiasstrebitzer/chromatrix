# @chromatrix/docs

The chromatrix documentation site. Astro static build, styled on the dashboard's achromatic design
system (the token file is copied from `apps/web`), deployed to GitHub Pages by
`.github/workflows/docs.yml` on every push that touches `apps/docs/**`.

```sh
pnpm --filter @chromatrix/docs run dev      # local dev server
pnpm --filter @chromatrix/docs run build    # static build to dist/
pnpm --filter @chromatrix/docs run preview  # serve the build locally
```

## Layout

```
src/
  content/docs/   the pages (markdown, one file per doc)
  nav.ts          sidebar groups + reading order (the IA lives here, not in frontmatter)
  pages/          index (landing) + docs/[...slug] (the doc template)
  components/     Nav, Sidebar, Toc, Footer, Logo (animated, vanilla port of the dashboard Logo)
  layouts/        Base (html shell + theme init)
  styles/         global.css (+ tokens.css, copied from apps/web)
  lib/url.ts      withBase() for the GitHub Pages base prefix
```

## Editing content

Add a markdown file under `src/content/docs/`, give it `title` + `description` frontmatter, then add its
slug to the right group in `src/nav.ts`. That is the only wiring; the sidebar, prev/next, and ToC all
derive from those two places.

The site is served from `/chromatrix` on GitHub Pages, so **every handwritten internal link must go
through `withBase()`** (Astro only auto-prefixes its own asset URLs). Markdown-to-markdown links use
relative slugs and are fine.
