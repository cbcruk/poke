/** A modifier as Electron's `sendInputEvent` names it. */
export type Modifier = 'control' | 'shift' | 'alt' | 'meta'

/** A key resolved into what `sendInputEvent` needs. */
export interface KeyStroke {
  /** Electron accelerator key code for `keyDown` / `keyUp`. */
  keyCode: string
  /** Text the key types, sent as a `char` event; absent for keys that type nothing. */
  text?: string
  modifiers: Modifier[]
}

const MODIFIERS: Record<string, Modifier> = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
}

const SPECIAL: Record<string, { keyCode: string; text?: string }> = {
  enter: { keyCode: 'Enter', text: '\r' },
  return: { keyCode: 'Enter', text: '\r' },
  tab: { keyCode: 'Tab', text: '\t' },
  space: { keyCode: 'Space', text: ' ' },
  escape: { keyCode: 'Escape' },
  esc: { keyCode: 'Escape' },
  backspace: { keyCode: 'Backspace' },
  delete: { keyCode: 'Delete' },
  home: { keyCode: 'Home' },
  end: { keyCode: 'End' },
  pageup: { keyCode: 'PageUp' },
  pagedown: { keyCode: 'PageDown' },
  arrowleft: { keyCode: 'Left' },
  arrowup: { keyCode: 'Up' },
  arrowright: { keyCode: 'Right' },
  arrowdown: { keyCode: 'Down' },
  left: { keyCode: 'Left' },
  up: { keyCode: 'Up' },
  right: { keyCode: 'Right' },
  down: { keyCode: 'Down' },
}
for (let i = 1; i <= 12; i++) SPECIAL[`f${i}`] = { keyCode: `F${i}` }

/**
 * Parses a key spec such as `Enter`, `a` or `Ctrl+Shift+K` into a keystroke.
 *
 * Modifier names are case-insensitive and accept the usual aliases
 * (`Control`, `Cmd`, `Option`). A held Ctrl, Meta or Alt suppresses the typed
 * text, so `Ctrl+A` does not also insert "a".
 *
 * @returns The keystroke, or `null` when the base key is not recognised.
 */
export function parseKey(spec: string): KeyStroke | null {
  const { base, mods } = split(spec)
  if (!base) return null

  const modifiers: Modifier[] = []
  for (const part of mods) {
    const mod = MODIFIERS[part.toLowerCase()]
    if (!mod) return null
    if (!modifiers.includes(mod)) modifiers.push(mod)
  }

  const resolved = base.length === 1 ? { keyCode: base, text: base } : SPECIAL[base.toLowerCase()]
  if (!resolved) return null

  const typesNothing = modifiers.some((m) => m !== 'shift')
  return {
    keyCode: resolved.keyCode,
    ...(resolved.text !== undefined && !typesNothing ? { text: resolved.text } : {}),
    modifiers,
  }
}

/** The part of a key spec that failed to parse, for error messages. */
export function unknownPart(spec: string): string {
  const { base, mods } = split(spec)
  return mods.find((p) => !MODIFIERS[p.toLowerCase()]) ?? base
}

/** A trailing `+` is the plus key itself, as in `Shift++`. */
function split(spec: string): { base: string; mods: string[] } {
  const plus = spec.endsWith('+')
  const parts = (plus ? spec.slice(0, -1) : spec).split('+').map((p) => p.trim())
  if (plus) return { base: '+', mods: parts.filter(Boolean) }
  const base = parts.pop() ?? ''
  return { base, mods: parts }
}
