// Page-side half of fill(): decide whether an element takes typed text, and
// what its value should be afterwards. Runs in the isolated world.

/** Input types that hold free text a keyboard can type into. */
const TYPABLE = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/** What fill() should type, or why it cannot. */
export type FillPlan =
  | { ok: true; typed: string; expected: string }
  | { ok: false; reason: string }

const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TYPABLE.has(el.type))

/**
 * Works out what typing `text` into `el` should leave behind.
 *
 * The expected value comes from a detached element of the same kind, so the
 * browser's own sanitising decides it: line breaks in a single-line input,
 * a number field rejecting letters, `maxlength`.
 */
export function planFill(el: Element, text: string): FillPlan {
  if (el instanceof HTMLElement && el.isContentEditable) {
    return { ok: true, typed: text, expected: text }
  }
  if (!isField(el)) {
    const kind = el instanceof HTMLInputElement ? `input[type=${el.type}]` : el.tagName.toLowerCase()
    return { ok: false, reason: `${kind} does not take typed text` }
  }
  if (el.matches(':disabled')) return { ok: false, reason: 'the field is disabled' }
  if (el.readOnly) return { ok: false, reason: 'the field is read-only' }

  // A typed line break in a single-line input is Enter, which submits.
  const typed = el instanceof HTMLInputElement ? text.replace(/\r\n|\r|\n/g, ' ') : text
  const probe = el.ownerDocument.createElement(el.tagName.toLowerCase()) as typeof el
  if (probe instanceof HTMLInputElement) probe.type = (el as HTMLInputElement).type
  probe.value = typed

  if (typed !== '' && probe.value === '') {
    return { ok: false, reason: `${JSON.stringify(text)} is not a valid ${(el as HTMLInputElement).type}` }
  }
  if (el.maxLength >= 0 && probe.value.length > el.maxLength) {
    return { ok: false, reason: `${probe.value.length} characters exceed maxlength ${el.maxLength}` }
  }
  return { ok: true, typed, expected: probe.value }
}

/** Selects everything in a field so the next typed text replaces it. */
export function selectContents(el: Element): void {
  if (isField(el)) {
    el.select()
    return
  }
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  const selection = el.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** The value a field holds, or the text of an editable element. */
export function valueOf(el: Element): string {
  return isField(el) ? el.value : (el.textContent ?? '')
}
