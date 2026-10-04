import { createEditor } from './editor'
import type { BufferMeta, LogLine, PokeBridge } from '../shared/types'
import './styles.css'

declare global {
  interface Window { poke: PokeBridge }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const panel = { tabs: el('tabs'), url: el<HTMLInputElement>('url'), run: el<HTMLButtonElement>('run'), log: el('log') }

let current: string | null = null
let running = false
/** The buffer whose tab is a name field; survives re-rendering the tabs. */
let editing: string | null = null

function put(message: string, kind: LogLine['kind'] = 'info'): void {
  const div = document.createElement('div')
  if (kind !== 'info') div.className = kind === 'ok' ? 'ok' : kind === 'error' ? 'err' : 'dim'
  div.textContent = message
  panel.log.appendChild(div)
  panel.log.scrollTop = panel.log.scrollHeight
}

const editor = createEditor(el('editor'), {
  onRun: () => void run(),
  onChange: (code) => { if (current) void window.poke.writeBuffer(current, code) },
})

async function renderTabs(select?: string): Promise<void> {
  const list = await window.poke.listBuffers()
  if (select) current = select
  if (!current || !list.some((b) => b.id === current)) current = list[0]?.id ?? null

  panel.tabs.textContent = ''
  for (const buf of list) {
    const tab = document.createElement('button')
    tab.className = buf.id === current ? 'tab active' : 'tab'
    tab.textContent = buf.name
    tab.title = '더블클릭: 이름 변경 · 가운데 클릭: 삭제'
    tab.addEventListener('click', () => { if (buf.id !== current) void open(buf.id) })
    tab.addEventListener('dblclick', () => { editing = buf.id; editName(tab, buf) })
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) void remove(buf) })
    panel.tabs.appendChild(tab)
    if (buf.id === editing) editName(tab, buf)
  }
  if (current) editor.setValue(await window.poke.readBuffer(current))
}

async function open(id: string): Promise<void> {
  current = id
  await renderTabs(id)
  editor.focus()
}

/**
 * Turns a tab into a name field. Electron does not support `prompt()`, so
 * names are edited in place: Enter or leaving the field keeps it, Escape
 * drops it.
 */
function editName(tab: HTMLElement, buf: BufferMeta): void {
  const input = document.createElement('input')
  input.className = 'tab-name'
  input.value = buf.name
  input.spellcheck = false
  tab.replaceWith(input)
  input.focus()
  input.select()

  let settled = false
  const settle = async (keep: boolean): Promise<void> => {
    if (settled) return
    settled = true
    editing = null
    const name = input.value.trim()
    if (keep && name && name !== buf.name) await window.poke.renameBuffer(buf.id, name)
    await renderTabs()
    editor.focus()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void settle(true)
    else if (e.key === 'Escape') void settle(false)
  })
  input.addEventListener('blur', () => void settle(true))
}

async function remove(buf: BufferMeta): Promise<void> {
  if (!confirm(`"${buf.name}" 버퍼를 삭제할까요?`)) return
  await window.poke.deleteBuffer(buf.id)
  current = null
  await renderTabs()
}

async function run(): Promise<void> {
  if (running || !current) return
  running = true
  panel.run.disabled = true
  panel.log.textContent = ''
  editor.markError(null)
  put('running…', 'dim')

  const code = editor.getValue()
  await window.poke.writeBuffer(current, code)
  // The closing status line comes back over the log channel, in order with
  // any assertion lines; here we only need the failing line to mark.
  const result = await window.poke.run(code)
  if (!result.ok) editor.markError(result.line ?? null)

  running = false
  panel.run.disabled = false
}

panel.run.addEventListener('click', () => void run())
el('add').addEventListener('click', async () => {
  const buf = await window.poke.createBuffer('scratch')
  editing = buf.id
  await renderTabs(buf.id)
})
panel.url.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const raw = panel.url.value.trim()
  if (!raw) return
  void window.poke.goto(/^[a-z]+:/i.test(raw) ? raw : `https://${raw}`)
})

window.poke.onLog((line) => put(line.message, line.kind))
window.poke.onUrl((url) => { panel.url.value = url })
void renderTabs()

// Hook for the smoke test, which cannot type into CodeMirror reliably.
;(window as unknown as Record<string, unknown>).__pokeTest = {
  setCode: (code: string) => editor.setValue(code),
  getCode: () => editor.getValue(),
  run,
  log: () => panel.log.innerText,
  activeTab: () => current,
  openBuffer: open,
  errorLines: () => document.querySelectorAll('.cm-errorLine').length,
}
