import type { LogLine } from '../shared/types'

/** Requests of these types are what an app does on purpose; they always show. */
const ALWAYS_SHOWN = new Set(['Fetch', 'XHR', 'Document'])

/** How long the end of a run waits for requests its last action started. */
const SETTLE_MS = 2000

interface Request {
  method: string
  url: string
  type: string
  action: number
  started: number
}

interface RemoteObject {
  value?: unknown
  description?: string
}

/**
 * Streams what each buffer action makes the page do into the run log: its
 * requests, console errors and warnings, and uncaught exceptions.
 *
 * Lines appear as events arrive, indented under the latest action. A request
 * that finishes after the next action has started is marked with the number
 * of the action that sent it.
 */
export class Activity {
  private action = 0
  private active = false
  private readonly requests = new Map<string, Request>()
  private settled: (() => void) | null = null

  constructor(
    private readonly emit: (line: LogLine) => void,
    private readonly pageUrl: () => string
  ) {}

  /** Starts a run: numbering restarts and nothing from before it shows. */
  start(): void {
    this.action = 0
    this.requests.clear()
    this.active = true
  }

  /** Logs an action line and makes it the one later events belong to. */
  act(description: string): void {
    if (!this.active) return
    this.action += 1
    this.emit({ kind: 'dim', message: `#${this.action} ${description}` })
  }

  /**
   * Ends a run, first waiting briefly for requests still in flight: a buffer
   * whose last line is a click should still show what that click sent.
   */
  async finish(): Promise<void> {
    if (this.inFlight() > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, SETTLE_MS)
        function done(): void {
          clearTimeout(timer)
          resolve()
        }
        this.settled = done
      })
      this.settled = null
    }
    this.active = false
  }

  onEvent(method: string, params: unknown): void {
    if (!this.active) return
    const p = params as Record<string, any>
    switch (method) {
      case 'Network.requestWillBeSent':
        this.requests.set(p.requestId, {
          method: p.request.method,
          url: p.request.url,
          type: p.type ?? 'Other',
          action: this.action,
          started: p.timestamp,
        })
        break
      // Reported once headers arrive, which is when fetch() resolves, so the
      // line lands before whatever the app logs about the response.
      case 'Network.responseReceived':
        this.settle(p.requestId, p.timestamp, String(p.response.status), p.response.status >= 400)
        break
      case 'Network.loadingFailed':
        this.settle(p.requestId, p.timestamp, p.canceled ? 'canceled' : p.errorText, true)
        break
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'warning') {
          const text = firstLine((p.args as RemoteObject[]).map(show).join(' '))
          // Electron's own warning about an unpackaged app, not the page's.
          if (text.includes('Electron Security Warning')) break
          const name = p.type === 'warning' ? 'warn' : 'error'
          this.line(p.type === 'error' ? 'error' : 'dim', `console.${name}: ${text}`)
        }
        break
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails
        const text = d.exception?.description?.split('\n')[0] ?? d.text
        this.line('error', `uncaught ${text}`)
        break
      }
      case 'Log.entryAdded':
        // Failed loads already come from the network events above.
        if (p.entry.source !== 'network' && (p.entry.level === 'error' || p.entry.level === 'warning')) {
          this.line(p.entry.level === 'error' ? 'error' : 'dim', `${p.entry.source}: ${firstLine(p.entry.text)}`)
        }
        break
    }
  }

  private settle(id: string, at: number, outcome: string, bad: boolean): void {
    const r = this.requests.get(id)
    if (!r) return
    this.requests.delete(id)

    if (bad || ALWAYS_SHOWN.has(r.type)) {
      const ms = Math.round((at - r.started) * 1000)
      const from = r.action !== this.action && r.action > 0 ? `#${r.action} ` : ''
      this.line(bad ? 'error' : 'dim', `${from}${r.method} ${this.short(r.url)} ${outcome} (${ms}ms)`)
    }
    if (this.inFlight() === 0) this.settled?.()
  }

  private inFlight(): number {
    let n = 0
    for (const r of this.requests.values()) if (ALWAYS_SHOWN.has(r.type)) n += 1
    return n
  }

  private line(kind: LogLine['kind'], text: string): void {
    this.emit({ kind, message: `  ↳ ${text}` })
  }

  /** Same-origin URLs lose their origin; anything long is cut. */
  private short(url: string): string {
    let shown = url
    try {
      const u = new URL(url)
      if (u.origin === new URL(this.pageUrl()).origin) shown = u.pathname + u.search
    } catch {
      // Not a URL we can parse; show it as it came.
    }
    return shown.length > 100 ? `${shown.slice(0, 99)}…` : shown
  }
}

function firstLine(text: string): string {
  const [first, ...rest] = text.split('\n')
  return rest.length ? `${first} …` : first
}

function show(o: RemoteObject): string {
  if (typeof o.value === 'string') return o.value
  if (o.value !== undefined) return JSON.stringify(o.value)
  return o.description ?? ''
}
