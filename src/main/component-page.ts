// Runs in the page's main world, called on an element through CDP. It is sent
// as source text (`.toString()`), so it must stay self-contained: no imports,
// no names from outside the function. It reads the properties React and Vue
// development builds put on DOM nodes, and adds nothing to the page.

/** One piece of component state, addressed by `key` in setState(). */
export interface StateEntry {
  key: string | number
  kind: string
  value: unknown
}

/** A component as a buffer sees it. */
export interface ComponentInfo {
  framework: 'react' | 'vue'
  name: string
  props: unknown
  state: StateEntry[]
}

/** What the page function returns: a value, or why there is none. */
export type ComponentReply<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * Reads, or with `write` set changes, the component that owns `this`.
 *
 * Without `name`, the nearest component is used; with it, the nearest
 * ancestor component of that name.
 */
export function componentOnElement(
  this: Element,
  name: string | null,
  write: { key: string | number; value: unknown } | null
): ComponentReply<ComponentInfo> {
  const el = this as Element & Record<string, any>

  const plain = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
    if (value === null || value === undefined) return value
    const t = typeof value
    if (t === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`
    if (t === 'symbol') return String(value)
    if (t !== 'object') return value
    const o = value as Record<string, any>
    if (o.$$typeof) {
      const type = o.type
      const tag = typeof type === 'string' ? type : type?.displayName || type?.name || 'Component'
      return `<${tag} />`
    }
    if (o instanceof Node) return `<${o.nodeName.toLowerCase()}>`
    if (seen.has(o)) return '[Circular]'
    if (depth >= 5) return Array.isArray(o) ? '[Array]' : '[Object]'
    seen.add(o)
    try {
      if (Array.isArray(o)) return o.map((v) => plain(v, depth + 1, seen))
      // returnByValue flattens these to {}, so they cross as plain data.
      if (o instanceof Map) return Object.fromEntries([...o].map(([k, v]) => [String(k), plain(v, depth + 1, seen)]))
      if (o instanceof Set) return [...o].map((v) => plain(v, depth + 1, seen))
      if (o instanceof Date) return o.toISOString()
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(o)) out[k] = plain(o[k], depth + 1, seen)
      return out
    } finally {
      seen.delete(o)
    }
  }

  const same = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }

  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  if (fiberKey) {
    // function, class, forwardRef, memo, simple memo
    const COMPONENT_TAGS = [0, 1, 11, 14, 15]
    const nameOf = (f: any): string => {
      const type = f.type?.render ?? f.type?.type ?? f.type
      return f.type?.displayName || type?.displayName || type?.name || 'Anonymous'
    }
    const seenNames: string[] = []
    let fiber = el[fiberKey]
    for (; fiber; fiber = fiber.return) {
      if (!COMPONENT_TAGS.includes(fiber.tag)) continue
      seenNames.push(nameOf(fiber))
      if (name === null || nameOf(fiber) === name) break
    }
    if (!fiber) {
      return {
        ok: false,
        reason: name === null
          ? 'no React component owns this element'
          : `no React component named ${JSON.stringify(name)} above this element; found ${seenNames.join(' < ') || 'none'}`,
      }
    }

    // A DOM node keeps the fiber it was created with, which after an update
    // may belong to the old tree. The root says which side is current.
    let root = fiber
    while (root.return) root = root.return
    if (root.tag === 3 && root.stateNode?.current !== root && fiber.alternate) fiber = fiber.alternate

    const isClass = fiber.tag === 1
    const hooks: any[] = []
    if (!isClass) for (let h = fiber.memoizedState; h; h = h.next) if (h.queue?.dispatch) hooks.push(h)
    const kindOf = (h: any): string =>
      h.queue.lastRenderedReducer?.name === 'basicStateReducer' ? 'useState' : 'useReducer'

    if (write) {
      if (isClass) {
        fiber.stateNode.setState({ [write.key]: write.value })
      } else {
        const hook = hooks[write.key as number]
        if (typeof write.key !== 'number' || !hook) {
          return { ok: false, reason: `no useState/useReducer at index ${JSON.stringify(write.key)}; it has ${hooks.length}` }
        }
        hook.queue.dispatch(write.value)
      }
    }

    const state: StateEntry[] = isClass
      ? Object.keys(fiber.stateNode.state ?? {}).map((k) => ({ key: k, kind: 'state', value: plain(fiber.stateNode.state[k]) }))
      // The queue is shared by both trees, so its last rendered state is current either way.
      : hooks.map((h, i) => ({ key: i, kind: kindOf(h), value: plain(h.queue.lastRenderedState) }))
    return { ok: true, value: { framework: 'react', name: nameOf(fiber), props: plain(fiber.memoizedProps), state } }
  }

  let instance = el.__vueParentComponent
  if (instance) {
    const nameOf = (i: any): string => i.type?.name || i.type?.__name || 'Anonymous'
    const seenNames: string[] = []
    for (; instance; instance = instance.parent) {
      seenNames.push(nameOf(instance))
      if (name === null || nameOf(instance) === name) break
    }
    if (!instance) {
      return { ok: false, reason: `no Vue component named ${JSON.stringify(name)} above this element; found ${seenNames.join(' < ')}` }
    }

    const sections: Array<[string, Record<string, any>]> = [
      ['setup', instance.setupState ?? {}],
      ['data', instance.data ?? {}],
    ]
    if (write) {
      const key = String(write.key)
      const section = sections.find(([, s]) => Object.prototype.hasOwnProperty.call(s, key))
      if (!section) {
        const keys = sections.flatMap(([, s]) => Object.keys(s))
        return { ok: false, reason: `no state ${JSON.stringify(key)}; it has ${keys.join(', ') || 'none'}` }
      }
      section[1][key] = write.value
      // A computed without a setter ignores the write with only a console warning.
      if (!same(section[1][key], write.value)) {
        return { ok: false, reason: `${JSON.stringify(key)} did not take the value; it is read-only, like a computed without a setter` }
      }
    }

    const state: StateEntry[] = sections.flatMap(([kind, s]) =>
      Object.keys(s)
        .filter((k) => typeof s[k] !== 'function')
        .map((k) => ({ key: k, kind, value: plain(s[k]) }))
    )
    return { ok: true, value: { framework: 'vue', name: nameOf(instance), props: plain({ ...instance.props }), state } }
  }

  return {
    ok: false,
    reason: 'no React or Vue component owns this element. Only development builds mark their elements',
  }
}
