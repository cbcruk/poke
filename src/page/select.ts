// Page-side select(): picks options on a native <select>. Runs in the isolated
// world, so the change it makes is not a trusted user event.

/** The values selected afterwards, or why nothing was changed. */
export type SelectResult = { ok: true; selected: string[] } | { ok: false; reason: string }

/**
 * Selects the options matching `wanted` on a native `<select>`.
 *
 * Each wanted string matches an option's `value` first, then its label, like
 * Playwright. Nothing changes unless every wanted option exists.
 */
export function selectOptions(el: Element, wanted: string[]): SelectResult {
  if (!(el instanceof HTMLSelectElement)) {
    return { ok: false, reason: `${el.tagName.toLowerCase()} is not a <select>` }
  }
  if (el.matches(':disabled')) return { ok: false, reason: 'the select is disabled' }
  if (!el.multiple && wanted.length !== 1) {
    return { ok: false, reason: `a single select takes one value, got ${wanted.length}` }
  }

  const options = [...el.options]
  const picked: HTMLOptionElement[] = []
  for (const w of wanted) {
    const match = options.find((o) => o.value === w) ?? options.find((o) => o.label === w)
    if (!match) {
      const listed = options.map((o) => `${o.value} ${JSON.stringify(o.label)}`).join(', ')
      return { ok: false, reason: `no option ${JSON.stringify(w)}; options are ${listed}` }
    }
    picked.push(match)
  }

  for (const o of options) o.selected = picked.includes(o)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selected: [...el.selectedOptions].map((o) => o.value) }
}
