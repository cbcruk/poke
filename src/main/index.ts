import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createApi } from './api'
import { Buffers } from './buffers'
import { runBuffer, stackOffset } from './runner'
import type { BufferMeta, LogLine, RunResult } from '../shared/types'

const PANEL_W = 480

let win: BrowserWindow | null = null
let view: WebContentsView | null = null
let buffers: Buffers

const emit = (line: LogLine): void => {
  if (win && !win.isDestroyed()) win.webContents.send('log', line)
}

const wc = (): Electron.WebContents => {
  if (!view) throw new Error('page view is not ready')
  return view.webContents
}

function layout(): void {
  if (!win || !view) return
  const [w, h] = win.getContentSize()
  view.setBounds({ x: PANEL_W, y: 0, width: Math.max(0, w - PANEL_W), height: h })
}

app.whenReady().then(() => {
  stackOffset() // measure once, before any buffer runs
  buffers = new Buffers(path.join(app.getPath('userData'), 'buffers'))

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#15171c',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js') },
  })
  win.loadFile(path.join(__dirname, '../renderer/index.html'))

  view = new WebContentsView()
  win.contentView.addChildView(view)
  layout()
  win.on('resize', layout)

  const { api, onDidFinishLoad, onDidNavigateInPage } = createApi(wc, emit)

  view.webContents.loadURL('about:blank')
  view.webContents.on('did-finish-load', onDidFinishLoad)
  view.webContents.on('did-navigate-in-page', onDidNavigateInPage)
  const sendUrl = (_e: unknown, url: string): void => {
    if (win && !win.isDestroyed()) win.webContents.send('url', url)
  }
  view.webContents.on('did-navigate', sendUrl)
  view.webContents.on('did-navigate-in-page', sendUrl)

  ipcMain.handle('run', async (_e, code: string): Promise<RunResult> => {
    const result = await runBuffer(code, api)
    // The final line is emitted here rather than in the renderer so it cannot
    // overtake assertion lines still in flight on the log channel.
    emit(
      result.ok
        ? { kind: 'ok', message: `done (${result.durationMs}ms)` }
        : {
            kind: 'error',
            message: result.line
              ? `line ${result.line}: ${result.error}`
              : `error: ${result.error}`,
          }
    )
    return result
  })
  ipcMain.handle('goto', async (_e, url: string): Promise<string> => {
    await api.goto(url)
    return wc().getURL()
  })

  ipcMain.handle('buffers:list', (): BufferMeta[] => buffers.list())
  ipcMain.handle('buffers:read', (_e, id: string): string => buffers.read(id))
  ipcMain.handle('buffers:write', (_e, id: string, code: string): void => buffers.write(id, code))
  ipcMain.handle('buffers:create', (_e, name: string): BufferMeta => buffers.create(name))
  ipcMain.handle('buffers:rename', (_e, id: string, name: string): void => buffers.rename(id, name))
  ipcMain.handle('buffers:delete', (_e, id: string): void => buffers.delete(id))

  // Used by the smoke test to capture what the page view is showing.
  ipcMain.handle('shot', async (_e, out: string): Promise<string> => {
    const img = await wc().capturePage()
    fs.writeFileSync(out, img.toPNG())
    return out
  })
})

app.on('window-all-closed', () => app.quit())
