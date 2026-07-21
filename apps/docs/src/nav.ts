// The docs information architecture: sidebar groups, page order, and prev/next all derive from this
// single table. Slugs are content-collection ids (src/content/docs/<slug>.md).
export interface NavGroup {
  label: string
  slugs: string[]
}

export const NAV: NavGroup[] = [
  { label: 'Getting started', slugs: ['introduction', 'quickstart', 'configuration'] },
  { label: 'Concepts', slugs: ['architecture', 'identities', 'tabs', 'fidelity', 'takeover'] },
  { label: 'Guides', slugs: ['agents', 'cli', 'deployment'] },
  { label: 'Reference', slugs: ['mcp-tools', 'security', 'packages'] },
]

/** Flat reading order, for prev/next footers. */
export const ORDER: string[] = NAV.flatMap((group) => group.slugs)
