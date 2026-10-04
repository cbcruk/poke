import type { WebContents } from 'electron'
import { createExpect } from './expect'
import { parseKey, unknownPart } from './keys'
import { by, describeTarget, expectsOne, toDescriptor, type Target } from './targets'
import { World, type DialogAnswer } from './world'
import type { LogLine } from '../shared/types'

export type Emit = (line: LogLine) => void

/** Mirrors `FillPlan` in src/page/fill.ts, which crosses back as plain JSON. */
type FillPlan = { ok: true; typed: string; expected: string } | { ok: false; reason: string }

/** Mirrors `SelectResult` in src/page/select.ts. */
type SelectResult = { ok: true; selected: string[] } | { ok: false; reason: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The API injected into a buffer. It is built around two things a DevTools
 * snippet cannot do: input that the page sees as a real user (`sendInputEvent`),
 * and code that keeps running after the page navigates.
 */
export function createApi(getWc: () => WebContents, emit: Emit) {
  const wc = getWc
  // User code runs in the page itself, where the app's own globals are.
  const js = <T>(expr: string): Promise<T> => wc().executeJavaScript(expr, true) as Promise<T>
  // Element queries run beside the page, where testing-library lives.
  const world = new World(getWc)

  // Electron accepts dialogs on its own, so an unanswered confirm() would
  // quietly say yes. Each one is answered here and shows up in the log.
  let nextAnswer: DialogAnswer | null = null
  world.onDialog = (d) => {
    const fallback: DialogAnswer = { accept: d.type === 'alert' || d.type === 'beforeunload' }
    const answer = nextAnswer ?? fallback
    nextAnswer = null
    emit({
      kind: 'dim',
      message: `  · ${d.type}(${JSON.stringify(d.message)}) → ${answer.accept ? 'accepted' : 'dismissed'}`,
    })
    return answer
  }

  /** Called before each run, so nothing set up by a previous run leaks into it. */
  async function prepare(): Promise<void> {
    nextAnswer = null
    await world.emulateFocus(true)
  }

  /** Hands focus back once the run ends; the editor is where it really is. */
  async function finish(): Promise<void> {
    await world.emulateFocus(false).catch(() => {})
  }

  // Navigation bookkeeping. A click often finishes navigating before the user's
  // next line runs, so waitForNavigation() must be able to see a load that
  // already happened since the last action instead of hanging for another one.
  let navSeq = 0
  let actionSeq = 0
  const markAction = (): void => { actionSeq = navSeq }
  const navWaiters = new Set<() => void>()
  const navigated = (): void => {
    navSeq += 1
    for (const wake of navWaiters) wake()
  }
  const onDidFinishLoad = (): void => navigated()
  // A client-side router moves with pushState, which never fires
  // did-finish-load.
  const onDidNavigateInPage = (_e: unknown, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) navigated()
  }

  const boxOf = (target: Target): Promise<{ x: number; y: number } | null> =>
    world.query('box', toDescriptor(target))

  const countOf = (target: Target): Promise<number> => world.query('count', toDescriptor(target))

  async function present(target: Target, timeout: number): Promise<boolean> {
    const started = Date.now()
    for (;;) {
      if (await countOf(target)) return true
      if (Date.now() - started > timeout) return false
      await sleep(100)
    }
  }

  async function waitFor(target: Target, timeout = 5000): Promise<true> {
    if (await present(target, timeout)) return true
    throw new Error(`waitFor timeout: ${describeTarget(target)}`)
  }

  /**
   * Readers wait the same way interactions do. A dev server rendering on the
   * client finishes loading well before the DOM exists, so reading straight
   * after goto() used to return null with nothing to explain why.
   */
  async function require(target: Target, method: string, timeout: number): Promise<void> {
    if (!(await present(target, timeout))) {
      throw new Error(
        `${method}(${describeTarget(target)}): no element matched within ${timeout}ms. ` +
          `Use count() if it is expected to be absent.`
      )
    }
    // A CSS selector takes the first match, like querySelector. A text match
    // that hits several elements is almost always a mistake: silently picking
    // one is how you end up clicking the wrong button.
    if (!expectsOne(target)) return
    const m = await world.query<{ n: number; shown: string[] }>('found', toDescriptor(target))
    if (m.n > 1) {
      throw new Error(
        `${method}(${describeTarget(target)}): ${m.n} elements matched: ` +
          `${m.shown.join(', ')}${m.n > 4 ? ', …' : ''}. ` +
          `Narrow the pattern, or use a CSS selector.`
      )
    }
  }

  async function click(target: Target): Promise<void> {
    await require(target, 'click', 5000)
    markAction()
    const b = await boxOf(target)
    if (!b) throw new Error(`click(${describeTarget(target)}): matched but not visible`)
    const at = { x: Math.round(b.x), y: Math.round(b.y) }
    wc().sendInputEvent({ type: 'mouseMove', ...at })
    wc().sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    wc().sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    await sleep(60)
  }

  /** A `char` of "\n" inserts nothing; a line break is typed as Enter, as on a keyboard. */
  async function typeChars(text: string): Promise<void> {
    for (const ch of text.replace(/\r\n?/g, '\n')) {
      if (ch === '\n') {
        wc().sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        wc().sendInputEvent({ type: 'char', keyCode: '\r' })
        wc().sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      } else {
        wc().sendInputEvent({ type: 'char', keyCode: ch })
      }
      await sleep(12)
    }
  }

  async function type(target: Target, value: unknown): Promise<void> {
    await click(target)
    await typeChars(String(value))
  }

  /**
   * Replaces a field's value by typing, then checks the field took it.
   *
   * Unlike type(), a value the field would silently mangle fails before
   * anything is typed: too long for `maxlength`, letters in a number field,
   * a disabled or read-only field.
   */
  async function fill(target: Target, value: unknown): Promise<void> {
    const text = String(value)
    const fail = (why: string): Error => new Error(`fill(${describeTarget(target)}): ${why}`)
    await require(target, 'fill', 5000)
    const d = toDescriptor(target)
    const plan = await world.query<FillPlan | null>('planFill', d, text)
    if (!plan) throw fail('the element went away')
    if (!plan.ok) throw fail(plan.reason)

    await click(target)
    await world.query('selectContents', d)
    if (plan.typed === '') await press('Backspace')
    else await typeChars(plan.typed)

    const actual = await world.query<string | null>('value', d)
    if (actual !== plan.expected) {
      throw fail(`typed ${JSON.stringify(text)} but the field holds ${JSON.stringify(actual)}`)
    }
  }

  /**
   * Chromium submits a form and inserts text on the `char` event, not on
   * `keyDown`, so a key that types something needs all three.
   */
  async function press(spec: string): Promise<void> {
    const stroke = parseKey(spec)
    if (!stroke) throw new Error(`press("${spec}"): unknown key "${unknownPart(spec)}"`)
    const { keyCode, text, modifiers } = stroke
    markAction()
    wc().sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (text !== undefined) wc().sendInputEvent({ type: 'char', keyCode: text, modifiers })
    wc().sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(60)
  }

  /**
   * Picks options on a native `<select>` by value, or by label when no value
   * matches, and returns the values selected afterwards.
   *
   * The popup of a native select is not part of the page, so this sets the
   * options directly and fires `input` / `change`. Those two events are not
   * trusted, unlike everything click() and type() send.
   */
  async function select(target: Target, value: string | string[]): Promise<string[]> {
    const wanted = Array.isArray(value) ? value : [value]
    await require(target, 'select', 5000)
    markAction()
    const r = await world.query<SelectResult | null>('select', toDescriptor(target), wanted)
    if (!r) throw new Error(`select(${describeTarget(target)}): the element went away`)
    if (!r.ok) throw new Error(`select(${describeTarget(target)}): ${r.reason}`)
    return r.selected
  }

  function waitForNavigation(timeout = 15000): Promise<void> {
    // Already navigated since the last action: settle instead of hanging.
    if (navSeq > actionSeq) { actionSeq = navSeq; return sleep(120) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(
          `waitForNavigation: no page load or in-page navigation within ${timeout}ms ` +
            `since the last action (still at ${wc().getURL()})`
        ))
      }, timeout)
      const done = (): void => { cleanup(); actionSeq = navSeq; setTimeout(resolve, 120) }
      const cleanup = (): void => { clearTimeout(timer); navWaiters.delete(done) }
      navWaiters.add(done)
    })
  }

  /** Same address, ignoring differences the browser itself normalises away. */
  function sameUrl(a: string, b: string): boolean {
    try {
      return new URL(a).href === new URL(b).href
    } catch {
      return a === b
    }
  }

  /**
   * Navigating away is the one thing this tool is supposed not to do on its
   * own. A buffer that opens with goto() gets run dozens of times, and every
   * run after the first would otherwise throw the page state away. So going
   * to where you already are does nothing; ask for reload() when you mean it.
   */
  async function goto(target: string): Promise<void> {
    if (sameUrl(wc().getURL(), target)) {
      emit({ kind: 'dim', message: `  · goto: already at ${target}` })
      return
    }
    markAction()
    await wc().loadURL(target)
    actionSeq = navSeq
    await sleep(80)
  }

  async function reload(): Promise<void> {
    markAction()
    wc().reload()
    await waitForNavigation()
  }

  const log = (...args: unknown[]): void =>
    emit({
      kind: 'info',
      message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    })

  const api = {
    goto,
    reload,
    click,
    type,
    fill,
    select,
    press,
    waitFor,
    waitForNavigation,
    ...by,
    async text(target: Target, timeout = 5000): Promise<string> {
      await require(target, 'text', timeout)
      return world.query<string>('text', toDescriptor(target))
    },
    async attr(target: Target, name: string, timeout = 5000): Promise<string | null> {
      await require(target, 'attr', timeout)
      return world.query<string | null>('attr', toDescriptor(target), name)
    },
    // count/texts answer "however many there are", zero included, so they
    // never wait. They are the way to assert absence.
    texts: (target: Target) => world.query<string[]>('texts', toDescriptor(target)),
    count: countOf,
    /** Roles actually present, to make a failing byRole actionable. */
    roles: () => world.call<string[]>('roles'),
    url: async () => wc().getURL(),
    title: async () => wc().getTitle(),
    // Errors thrown in the page reach us as "Script failed to execute" with the
    // message gone, so the result is wrapped and rethrown on this side.
    async evaluate<T>(expr: string | (() => T)): Promise<T> {
      const src = typeof expr === 'function' ? `(${expr})()` : expr
      const r = await js<{ ok: true; v: T } | { ok: false; m: string }>(
        `(async () => {
          try { return { ok: true, v: await (${src}) } }
          catch (e) { return { ok: false, m: String((e && e.message) || e) } }
        })()`
      )
      if (!r.ok) throw new Error(`evaluate: ${r.m}`)
      return r.v
    },
    /** Accepts the next dialog instead of dismissing it. */
    acceptNextDialog(): void {
      nextAnswer = { accept: true }
    },
    sleep,
    log,
    expect: createExpect(emit),
  }

  return { api, prepare, finish, onDidFinishLoad, onDidNavigateInPage }
}

export type PokeApi = ReturnType<typeof createApi>['api']
