/** Hash routes for the content-page screen. The markdown editor stays the default. */

export type ContentRoute =
  | { screen: 'editor' }
  | { screen: 'pages'; slug: string | null }

export function parseContentRoute(hash: string): ContentRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw === 'create' || raw === 'pages') return { screen: 'pages', slug: null }
  if (raw.startsWith('page/')) {
    let slug = raw.slice('page/'.length)
    try {
      slug = decodeURIComponent(slug)
    } catch {
      /* keep the raw segment */
    }
    slug = slug.trim()
    return { screen: 'pages', slug: slug || null }
  }
  return { screen: 'editor' }
}

export function contentRouteHash(route: ContentRoute): string {
  if (route.screen === 'editor') return '#editor'
  if (!route.slug) return '#create'
  return `#page/${encodeURIComponent(route.slug)}`
}

export function contentScreenTitle(route: ContentRoute): string {
  if (route.screen === 'editor') return 'Markdown + preview'
  return route.slug ? 'Content page' : 'Create page'
}

export function sameContentRoute(a: ContentRoute, b: ContentRoute): boolean {
  if (a.screen === 'editor' && b.screen === 'editor') return true
  if (a.screen === 'pages' && b.screen === 'pages') return a.slug === b.slug
  return false
}
