// Runs in the page's main world, sent as source text like component-page.ts,
// so it stays self-contained. Answers whether React server-rendered this page
// and whether any root has been handed to React yet.

/** Whether input may be lost: server HTML on screen, React not attached yet. */
export interface HydrationState {
  ssr: boolean
  hydrated: boolean
}

/**
 * Reports whether the document looks server-rendered by React, and whether
 * `hydrateRoot` has claimed a container yet.
 *
 * Once a container is claimed React listens on it and replays input that
 * lands mid-hydration, so only the time before that loses clicks.
 */
export function hydrationOnPage(this: Element): HydrationState {
  const doc = this.ownerDocument
  const hydrated = [...doc.querySelectorAll('*')].some((el) =>
    Object.keys(el).some((k) => k.startsWith('__reactContainer$'))
  )

  // renderToString separates adjacent text with <!-- -->; Suspense leaves <!--$-->.
  const MARKERS = [' ', '$', '/$', '$?', '$!']
  let ssr = false
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_COMMENT)
  for (let n = walker.nextNode(); n && !ssr; n = walker.nextNode()) {
    ssr = MARKERS.includes((n as Comment).data)
  }
  if (!ssr) {
    ssr =
      Boolean(doc.getElementById('__next') || doc.getElementById('__NEXT_DATA__')) ||
      [...doc.scripts].some((s) => /self\.__next_f|__reactRouterContext|__remixContext/.test(s.text))
  }
  return { ssr, hydrated }
}
