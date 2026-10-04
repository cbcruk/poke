// Bundled to an IIFE and evaluated inside an isolated world in the page, which
// is where testing-library has to run. Everything in this file executes in the
// page context; the main process only passes descriptors in and gets plain
// values back.
import { queries, configure } from '@testing-library/dom'
import { planFill, selectContents, valueOf, type FillPlan } from './fill'
import { selectOptions, type SelectResult } from './select'

// Stock testing-library errors embed a prettyDOM dump of the whole document,
// which runs to hundreds of characters and drowns the log panel. Keep the
// sentence, drop the dump.
configure({ getElementError: (message) => new Error(message ?? 'no element') })

/** How the main process names a target. */
export interface Descriptor {
  kind: string
  /** Exact string to match, or a CSS selector when kind is 'css'. */
  literal?: string
  /** A RegExp, split so it can cross the evaluation boundary. */
  source?: string
  flags?: string
  /** Extra testing-library options, e.g. `{ name: ... }` for byRole. */
  options?: Record<string, unknown>
  /** Option values that are themselves RegExps, by key. */
  regexpOptions?: Record<string, { source: string; flags: string }>
}

type Matcher = string | RegExp
type Query = (container: HTMLElement, matcher: Matcher, options?: object) => Element[]

const QUERIES: Record<string, Query> = {
  text: queries.queryAllByText as Query,
  role: queries.queryAllByRole as unknown as Query,
  label: queries.queryAllByLabelText as Query,
  placeholder: queries.queryAllByPlaceholderText as Query,
  testId: queries.queryAllByTestId as Query,
  alt: queries.queryAllByAltText as Query,
  title: queries.queryAllByTitle as Query,
  displayValue: queries.queryAllByDisplayValue as Query,
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

function matcherOf(d: Descriptor): Matcher {
  return d.source === undefined ? (d.literal as string) : new RegExp(d.source, d.flags)
}

function optionsOf(d: Descriptor): Record<string, unknown> | undefined {
  if (!d.options && !d.regexpOptions) return undefined
  const options = { ...(d.options ?? {}) }
  for (const [key, re] of Object.entries(d.regexpOptions ?? {})) {
    options[key] = new RegExp(re.source, re.flags)
  }
  return options
}

function all(d: Descriptor): Element[] {
  if (d.kind === 'css') {
    try {
      return [...document.querySelectorAll(d.literal as string)]
    } catch {
      // The browser's own message names querySelectorAll, which a buffer
      // never called.
      throw new Error(`"${d.literal}" is not a valid CSS selector`)
    }
  }
  const query = QUERIES[d.kind]
  if (!query) throw new Error(`unknown target kind: ${d.kind}`)
  return query(document.body, matcherOf(d), optionsOf(d))
}

const describe = (el: Element): string =>
  `${el.tagName.toLowerCase()} "${norm(el.textContent ?? '').slice(0, 30)}"`

/**
 * Everything the main process can ask about the page. Results are plain
 * values: elements themselves cannot cross out of the world.
 */
const api = {
  count: (d: Descriptor): number => all(d).length,

  texts: (d: Descriptor): string[] => all(d).map((el) => norm(el.textContent ?? '')),

  /** What a target matched, for error messages that name the ambiguity. */
  found: (d: Descriptor): { n: number; shown: string[] } => {
    const els = all(d)
    return { n: els.length, shown: els.slice(0, 4).map(describe) }
  },

  text: (d: Descriptor): string | null => {
    const el = all(d)[0]
    return el ? norm(el.textContent ?? '') : null
  },

  attr: (d: Descriptor, name: string): string | null => {
    const el = all(d)[0]
    return el ? el.getAttribute(name) : null
  },

  /** Centre of the first match, in viewport coordinates, after scrolling to it. */
  box: (d: Descriptor): { x: number; y: number } | null => {
    const el = all(d)[0]
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  },

  planFill: (d: Descriptor, text: string): FillPlan | null => {
    const el = all(d)[0]
    return el ? planFill(el, text) : null
  },

  selectContents: (d: Descriptor): void => {
    const el = all(d)[0]
    if (el) selectContents(el)
  },

  value: (d: Descriptor): string | null => {
    const el = all(d)[0]
    return el ? valueOf(el) : null
  },

  select: (d: Descriptor, wanted: string[]): SelectResult | null => {
    const el = all(d)[0]
    return el ? selectOptions(el, wanted) : null
  },

  /** Roles actually present, to make "nothing matched" actionable. */
  roles: (): string[] => {
    const seen = new Set<string>()
    for (const el of document.querySelectorAll('[role]')) {
      const role = el.getAttribute('role')
      if (role) seen.add(role)
    }
    for (const [selector, role] of [
      ['button', 'button'],
      ['a[href]', 'link'],
      ['input:not([type=hidden]), textarea', 'textbox'],
      ['select', 'combobox'],
      ['h1, h2, h3, h4, h5, h6', 'heading'],
      ['table', 'table'],
      ['ul, ol', 'list'],
    ] as const) {
      if (document.querySelector(selector)) seen.add(role)
    }
    return [...seen].sort()
  },
}

;(globalThis as unknown as Record<string, unknown>).__poke = api
