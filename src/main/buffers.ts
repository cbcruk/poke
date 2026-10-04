import fs from 'node:fs'
import path from 'node:path'
import type { BufferMeta } from '../shared/types'

// The seed must not navigate. Run is supposed to leave the page exactly where
// it is; a goto here would throw that away on every click, which is the one
// thing this tool exists to avoid.
const SEED = `// poke — 지금 보고 있는 화면에 그대로 코드를 쏜다.
// 주소는 위 URL 칸에서 옮긴다. Run 은 페이지를 건드리지 않는다.

log('주소:', await url())
log('제목:', await title())

// 클릭과 입력은 신뢰된 이벤트로 나간다.
// await click('button[type=submit]')
// await type('#email', 'a@b.co')

expect(await title()).toBeTruthy()
`

/** Buffers are plain .js files so they can be opened in any editor. */
export class Buffers {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    if (this.list().length === 0) this.create('scratch', SEED)
  }

  private file(id: string): string {
    // Ids come from our own listing, but never let one escape the directory.
    const safe = path.basename(id)
    return path.join(this.dir, `${safe}.js`)
  }

  list(): BufferMeta[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.slice(0, -3))
      .sort()
      .map((id) => ({ id, name: id }))
  }

  read(id: string): string {
    const f = this.file(id)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  }

  write(id: string, code: string): void {
    fs.writeFileSync(this.file(id), code, 'utf8')
  }

  create(name: string, code = '// \n'): BufferMeta {
    const id = this.unique(name)
    this.write(id, code)
    return { id, name: id }
  }

  rename(id: string, name: string): void {
    const next = this.unique(name)
    fs.renameSync(this.file(id), this.file(next))
  }

  delete(id: string): void {
    const f = this.file(id)
    if (fs.existsSync(f)) fs.unlinkSync(f)
    if (this.list().length === 0) this.create('scratch', SEED)
  }

  private unique(name: string): string {
    // \w is ASCII-only, which turned every Korean name into "buffer".
    const base = name.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '') || 'buffer'
    if (!fs.existsSync(this.file(base))) return base
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}`
      if (!fs.existsSync(this.file(candidate))) return candidate
    }
  }
}
