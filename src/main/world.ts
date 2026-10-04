import type { WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Descriptor } from './targets'

const WORLD_NAME = 'poke'

/**
 * How long a single query may take. Queries finish in milliseconds; one that
 * runs this long means the page's main thread is stuck.
 */
const DEADLINE_MS = 5000

const MISSING = '__pokeMissing'

interface PageEvent {
  context?: { id: number; name: string; auxData?: { frameId?: string } }
  executionContextId?: number
  frame?: { id: string; parentId?: string }
  type?: Dialog['type']
  message?: string
}

/**
 * A JavaScript dialog the page opened.
 *
 * Electron does not support `prompt()`: it throws in the page and never
 * reaches here.
 */
export interface Dialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
}

/** How to close a {@linkcode Dialog}. */
export interface DialogAnswer {
  accept: boolean
}

/**
 * Element queries run in a CDP isolated world rather than in the page itself.
 * testing-library has to live in the DOM, and dropping 180kB plus a global
 * into someone's app to get it there is rude. An isolated world shares the DOM
 * and nothing else, so the app's own globals are untouched.
 *
 * The bundle is registered to run in every new document, so after navigation
 * the world is already there and is found through context events instead of
 * a round trip per query.
 */
export class World {
  private contextId: number | null = null
  private mainFrameId: string | null = null
  private attaching: Promise<void> | null = null
  private pending: { method: string; since: number } | null = null
  private readonly bundle: string

  /**
   * Decides how each dialog is closed. Without an answer the page would hold
   * whatever the embedder chose, which in Electron is to accept silently.
   */
  onDialog: (dialog: Dialog) => DialogAnswer = (d) => ({ accept: d.type !== 'confirm' })

  constructor(private readonly getWc: () => WebContents) {
    this.bundle = fs.readFileSync(path.join(__dirname, '../page/queries.js'), 'utf8')
  }

  detach(): void {
    const wc = this.getWc()
    if (wc.debugger.isAttached()) wc.debugger.detach()
  }

  /** Attaches the debugger, so dialogs are answered from the first action on. */
  async ready(): Promise<void> {
    this.attaching ??= this.attach().catch((err) => {
      this.attaching = null
      throw err
    })
    await this.attaching
  }

  /**
   * Makes the page behave as if it had focus, without taking it.
   *
   * A buffer runs from the editor, so the page view never has real focus:
   * `document.hasFocus()` is false and inputs fire no `focus` / `blur`.
   */
  async emulateFocus(enabled: boolean): Promise<void> {
    await this.ready()
    await this.send('Emulation.setFocusEmulationEnabled', { enabled })
  }

  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const expression =
      `globalThis.__poke ? __poke.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})` +
      ` : ${JSON.stringify(MISSING)}`

    for (let attempt = 0; ; attempt++) {
      const contextId = await this.ensure()
      try {
        const value = await this.evaluate<T | typeof MISSING>(expression, contextId)
        if (value !== MISSING) return value
        // A world we created by hand, or one whose script has not run yet.
        return (await this.evaluate<T>(`${this.bundle};\n${expression}`, contextId)) as T
      } catch (err) {
        // The document went away between finding the context and using it.
        if (attempt === 0 && /Cannot find context/.test(String(err))) {
          if (this.contextId === contextId) this.contextId = null
          continue
        }
        throw err
      }
    }
  }

  /** Convenience for the common shape: one descriptor in, a value out. */
  query<T>(method: string, descriptor: Descriptor, ...rest: unknown[]): Promise<T> {
    return this.call<T>(method, descriptor, ...rest)
  }

  private async ensure(): Promise<number> {
    await this.ready()
    if (this.contextId !== null) return this.contextId

    // The document predates the script registration, or its world has not
    // been reported yet. Make one by hand; call() installs the bundle.
    const { executionContextId } = await this.send<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      { frameId: this.mainFrameId, worldName: WORLD_NAME }
    )
    this.contextId = executionContextId
    return executionContextId
  }

  private async attach(): Promise<void> {
    const wc = this.getWc()
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    wc.debugger.on('message', (_e, method, params) => this.onEvent(method, params as PageEvent))
    wc.debugger.on('detach', () => {
      this.attaching = null
      this.contextId = null
      this.pending = null
    })

    await this.send('Page.enable')
    await this.send('Runtime.enable')
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree'
    )
    this.mainFrameId = frameTree.frame.id
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: this.bundle,
      worldName: WORLD_NAME,
    })
  }

  private onEvent(method: string, params: PageEvent): void {
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const ctx = params.context
        // Chrome can report more than one context under the same world name,
        // including the ones we create by hand. The newest one in the main
        // frame belongs to the current document; call() installs the bundle
        // if it is not there yet.
        if (ctx?.name === WORLD_NAME && ctx.auxData?.frameId === this.mainFrameId) {
          this.contextId = ctx.id
        }
        break
      }
      case 'Runtime.executionContextDestroyed':
        if (params.executionContextId === this.contextId) this.contextId = null
        break
      case 'Runtime.executionContextsCleared':
        this.contextId = null
        break
      case 'Page.frameNavigated':
        if (params.frame && !params.frame.parentId) this.mainFrameId = params.frame.id
        break
      case 'Page.javascriptDialogOpening': {
        const answer = this.onDialog({
          type: params.type ?? 'alert',
          message: params.message ?? '',
        })
        // Bypasses the pending gate: a query stuck behind this dialog is
        // exactly what the answer releases.
        void this.getWc()
          .debugger.sendCommand('Page.handleJavaScriptDialog', answer)
          .catch(() => {})
        break
      }
    }
  }

  private async evaluate<T>(expression: string, contextId: number): Promise<T> {
    const result = await this.send<{
      result: { value: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })

    if (result.exceptionDetails) {
      const { exception, text } = result.exceptionDetails
      // Strip the stack that V8 prepends to `description`.
      const message = (exception?.description ?? text).split('\n')[0]
      throw new Error(message)
    }
    return result.result.value
  }

  /**
   * A command already sent cannot be cancelled, so the deadline only ends the
   * wait. While that reply is still outstanding, further commands would queue
   * behind it in the same stuck renderer, so they are refused at once.
   */
  private send<T = unknown>(method: string, params?: object): Promise<T> {
    if (this.pending) {
      const waited = Date.now() - this.pending.since
      return Promise.reject(
        new Error(
          `the page is still waiting on an earlier ${this.pending.method} (${waited}ms). ` +
            `Its main thread is busy; try again once it settles.`
        )
      )
    }

    const sent = this.getWc().debugger.sendCommand(method, params) as Promise<T>
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = { method, since: Date.now() - DEADLINE_MS }
        this.pending = pending
        const clear = (): void => {
          if (this.pending === pending) this.pending = null
        }
        sent.then(clear, clear)
        reject(
          new Error(
            `the page did not answer within ${DEADLINE_MS}ms: ${method}. ` +
              `Its main thread may be stuck in a loop, or held by a dialog.`
          )
        )
      }, DEADLINE_MS)
      sent.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (err) => { clearTimeout(timer); reject(err) }
      )
    })
  }
}
