// Launches poke under Xvfb and drives its own UI over CDP.
// Verifies the two things a DevTools snippet cannot do, plus the editor loop.
import puppeteer from 'puppeteer-core'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT_CDP = 9600
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, actual, expected) => {
  const ok = String(actual) === String(expected)
  results.push({ name, ok, actual, expected })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (기대 ${expected}, 실제 ${actual})`}`)
}

// React 19 ships no UMD build, so the framework fixtures are bundled here as
// development builds, which is what a dev server would serve.
const built = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'poke-built-'))
await build({
  entryPoints: ['react-app.jsx', 'vue-app.js', 'ssr-client.jsx'].map((f) => path.join(HERE, 'fixtures/src', f)),
  bundle: true,
  outdir: built,
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"development"',
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  logLevel: 'error',
})

await build({
  entryPoints: [path.join(HERE, 'fixtures/src/ssr-server.jsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(built, 'ssr-server.mjs'),
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  external: ['react', 'react-dom'],
  logLevel: 'error',
})
// Bundled into a temp dir, so react has to be resolved from here.
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(built, 'node_modules'))
const { render: renderSsr } = await import(path.join(built, 'ssr-server.mjs'))

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/ssr.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SSR</title></head>
<body><div id="root">${renderSsr()}</div><script src="/built/ssr-client.js"></script></body></html>`)
    return
  }
  if (req.url.startsWith('/built/')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    res.end(fs.readFileSync(path.join(built, path.basename(req.url))))
    return
  }
  if (req.url.startsWith('/api/')) {
    const status = req.url === '/api/save' ? 500 : 200
    const delay = req.url === '/api/slow' ? 800 : req.url === '/api/last' ? 300 : 0
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end('{}')
    }, delay)
    return
  }
  const file = path.join(HERE, 'fixtures', path.basename(req.url.split('?')[0]))
  if (fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(fs.readFileSync(file))
  } else { res.writeHead(404); res.end('x') }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const site = `http://127.0.0.1:${server.address().port}`

const portTaken = await new Promise((resolve) => {
  const probe = http.get(`http://127.0.0.1:${PORT_CDP}/json/version`, () => resolve(true))
  probe.on('error', () => resolve(false))
})
if (portTaken) {
  console.error(`FAIL: port ${PORT_CDP} is already in use, probably by an electron left from an earlier run`)
  process.exit(1)
}

const userData = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'poke-smoke-'))
const electronArgs = [
  path.join(ROOT, 'node_modules/.bin/electron'), ROOT,
  `--remote-debugging-port=${PORT_CDP}`, '--no-sandbox', `--user-data-dir=${userData}`,
]
// Xvfb only exists on Linux; elsewhere the window simply opens on screen.
const [cmd, ...args] = process.platform === 'linux'
  ? ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24', ...electronArgs]
  : electronArgs
const proc = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
proc.stderr.on('data', (d) => { const s = String(d); if (/Error/.test(s)) process.stderr.write('[electron] ' + s.slice(0, 300)) })

let lastCode = ''
const bail = (msg) => {
  console.error('FAIL:', msg)
  if (lastCode) console.error('last buffer:', lastCode.trim().split('\n').slice(0, 3).join(' | '))
  shutdown()
  process.exit(1)
}
function shutdown() {
  try { process.kill(-proc.pid, 'SIGKILL') } catch {}
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(built, { recursive: true, force: true })
}

// A smoke run that throws must still kill its electron. One left behind keeps
// port 9600, and the next run silently drives that old app instead.
process.on('uncaughtException', (err) => bail(err.stack ?? String(err)))
process.on('unhandledRejection', (err) => bail(err?.stack ?? String(err)))

let browser
for (let i = 0; i < 50; i++) {
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT_CDP}` }); break }
  catch { await wait(500) }
}
if (!browser) bail('electron never exposed CDP')

let panel = null
for (let i = 0; i < 40; i++) {
  panel = (await browser.pages()).find((p) => p.url().includes('index.html'))
  if (panel) break
  await wait(500)
}
if (!panel) bail('control panel not found')
for (let i = 0; i < 40; i++) {
  if (await panel.evaluate(() => Boolean(window.__pokeTest))) break
  await wait(250)
}

// ---- 0. 기본 버퍼를 진짜 버튼으로 돌려도 페이지가 그대로여야 한다 ----
// 기본 버퍼가 goto 로 시작하는 바람에 Run 을 누를 때마다 페이지가 다시 뜨던 적이 있다.
// runCode 는 버퍼를 덮어쓰므로, 반드시 그 전에 확인해야 한다.
const seed = await panel.evaluate(() => window.__pokeTest.getCode())
check('기본 버퍼에 goto 없음', /\bgoto\(/.test(seed.replace(/^\s*\/\/.*$/gm, '')), false)

await panel.evaluate((u) => window.poke.goto(u), `${site}/page2.html`)
await wait(1200)
const viewBefore = (await browser.pages()).find((p) => !p.url().includes('index.html'))
await viewBefore.evaluate(() => { window.__kept = 'STILL-HERE' })

await panel.click('#run') // 합성 호출이 아니라 실제 버튼 클릭
for (let i = 0; i < 60; i++) {
  const log = await panel.evaluate(() => window.__pokeTest.log())
  if (/done \(|error:|line \d+:/.test(log)) break
  await wait(250)
}
const seedLog = await panel.evaluate(() => window.__pokeTest.log())
const viewAfter = (await browser.pages()).find((p) => !p.url().includes('index.html'))
check('버튼 클릭으로 실행됨', /done \(/.test(seedLog), true)
check('기본 버퍼 실행이 페이지를 유지', viewAfter.url().endsWith('/page2.html'), true)
check(
  '기본 버퍼 실행이 페이지 상태를 유지',
  await viewAfter.evaluate(() => window.__kept ?? '(날아감)').catch(() => '(컨텍스트 파괴됨)'),
  'STILL-HERE'
)

const runCode = async (code) => {
  lastCode = code
  await panel.evaluate((c) => window.__pokeTest.setCode(c), code)
  await panel.evaluate(() => window.__pokeTest.run())
  for (let i = 0; i < 80; i++) {
    const log = await panel.evaluate(() => window.__pokeTest.log())
    if (/done \(|error:|line \d+:/.test(log)) return log
    await wait(250)
  }
  return await panel.evaluate(() => window.__pokeTest.log())
}

// ---- 1. 신뢰된 입력과 내비게이션 생존 ----
const log1 = await runCode(`
await goto('${site}/page1.html')
log('T:' + await title())
await click('#probe')
log('TRUSTED:' + String(await evaluate('window.__trusted')))
await click('#link')
await waitForNavigation()
log('URL:' + await url())
log('H1:' + await text('h1'))
await type('#name', 'poked')
log('INPUT:' + await evaluate('document.querySelector("#name").value'))
expect(await text('h1')).toEqual('Page Two')
`)
check('제목 읽기', /T:Page One/.test(log1), true)
check('신뢰된 입력 (isTrusted)', /TRUSTED:true/.test(log1), true)
check('내비게이션 생존', /URL:.*page2\.html/.test(log1), true)
check('이동 후 DOM 읽기', /H1:Page Two/.test(log1), true)
check('신뢰된 키 입력', /INPUT:poked/.test(log1), true)
check('단언 통과 표시', /✓ toEqual/.test(log1), true)
check('실행 성공 보고', /done \(/.test(log1), true)

// 로그 채널과 실행 결과가 경쟁해 마지막 단언이 done 뒤로 밀린 적이 있다.
const lines1 = log1.split('\n').map((l) => l.trim()).filter(Boolean)
check('done 이 로그의 마지막 줄', /^done \(/.test(lines1[lines1.length - 1] ?? ''), true)

// ---- 1b. 손수 짠 deepEqual 이 틀렸던 것들 + vitest 가 주는 것 ----
const logEq = await runCode(`
expect(new Set([{ x: 1 }])).toEqual(new Set([{ x: 1 }]))
expect({ b: 2, a: 1 }).toEqual({ a: 1, b: 2 })
expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } })
expect([1, 2, 3]).toEqual(expect.arrayContaining([3, 2]))
expect({ id: 7 }).toEqual({ id: expect.any(Number) })
expect(0.1 + 0.2).toBeCloseTo(0.3)
`)
check('Set 객체원소 동등성', /✓ toEqual Set \{\{"x": 1\}\}/.test(logEq), true)
check('키 순서 무관', /✓ toEqual \{"a": 1, "b": 2\}/.test(logEq), true)
check('toMatchObject', /✓ toMatchObject/.test(logEq), true)
check('arrayContaining', /✓ toEqual ArrayContaining/.test(logEq), true)
check('expect.any', /✓ toEqual \{"id": Any<Number>\}/.test(logEq), true)
check('toBeCloseTo', /✓ toBeCloseTo/.test(logEq), true)
check('동등성 전부 통과', /done \(/.test(logEq), true)

// 희소 배열은 명시적 undefined 와 달라야 한다 (예전 구현은 같다고 했다)
const logSparse = await runCode(`expect([1, , 3]).toStrictEqual([1, undefined, 3])`)
check('희소배열 구분', /✗ toStrictEqual/.test(logSparse), true)

// 실패하면 diff 가 붙는다
const logDiff = await runCode(`expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 3 })`)
check('실패 시 diff 출력', /- Expected[\s\S]*\+ Received[\s\S]*"b"/.test(logDiff), true)
check('diff 에 ANSI 없음', /\u001B\[/.test(logDiff), false)

// ---- 2. 에러 줄 번호 ----
// throw 는 아래 배열의 4번째 줄에 있다.
const errCode = ['const a = 1', 'const b = 2', '', "throw new Error('boom')"].join('\n')
const log2 = await runCode(errCode)
const reported = /line (\d+): boom/.exec(log2)
check('에러 줄 번호', reported ? reported[1] : `없음 (${log2.replace(/\n/g, ' | ')})`, 4)
check('에디터 에러 줄 표시', await panel.evaluate(() => window.__pokeTest.errorLines()), 1)

// API 내부에서 던져도 사용자 줄을 가리키는가
const log3 = await runCode(`await goto('${site}/page1.html')
await waitFor('#nope', 300)
`)
check('API 실패도 사용자 줄로', /line 2: waitFor timeout/.test(log3), true)

// ---- 2c. 읽기도 상호작용처럼 요소를 기다린다 ----
// 클라이언트 렌더링 앱에서 goto 직후 text() 가 조용히 null 을 내던 문제.
const logSpa = await runCode(`
await goto('${site}/spa.html')
log('바로 읽기:', await text('h1'))
`)
check('늦게 그려지는 요소를 기다림', /바로 읽기: 진료실 관리/.test(logSpa), true)

// pushState 이동은 did-finish-load 를 내지 않는다. 그것만 세면 15초를 기다리다 실패한다.
const logRouter = await runCode(`
await goto('${site}/router.html')
await click('#to-detail')
await waitForNavigation(2000)
log('라우터 이동:', await url(), await text('h1'))
`)
check('pushState 이동도 waitForNavigation 이 잡음', /라우터 이동: .*\?view=detail 상세/.test(logRouter), true)

const logNoNav = await runCode(`await waitForNavigation(300)`)
check('이동 없음은 어디 머물러 있는지 말함', /no page load or in-page navigation within 300ms .*still at .*\?view=detail/.test(logNoNav), true)

const logMissing = await runCode(`await goto('${site}/page2.html')\nawait text('h9', 400)`)
check('없는 요소는 이유를 말하며 실패', /text\("h9"\): no element matched within 400ms/.test(logMissing), true)
check('없는 요소 실패도 사용자 줄로', /line 2:/.test(logMissing), true)

const logAbsent = await runCode(`await goto('${site}/page2.html')\nlog('count:', String(await count('h9')))\nlog('texts:', JSON.stringify(await texts('h9')))`)
check('count 는 기다리지 않고 0', /count: 0/.test(logAbsent), true)
check('texts 는 기다리지 않고 빈 배열', /texts: \[\]/.test(logAbsent), true)

// ---- 2d. goto 를 반복해도 페이지가 유지된다 ----
// goto 로 시작하는 버퍼를 여러 번 돌리는 것이 기본 사용 방식이다. 두 번째 실행부터는
// 이미 그 주소에 있으므로 페이지를 버리면 안 된다.
await runCode(`await goto('${site}/page2.html')`)
let v = (await browser.pages()).find((p) => !p.url().includes('index.html'))
await v.evaluate(() => { window.__survives = 'YES' })

const logAgain = await runCode(`await goto('${site}/page2.html')\nlog('title:', await title())`)
v = (await browser.pages()).find((p) => !p.url().includes('index.html'))
check('같은 주소로 goto 는 그대로 둠', /already at/.test(logAgain), true)
check('반복 goto 후 페이지 상태 유지', await v.evaluate(() => window.__survives ?? '(날아감)').catch(() => '(파괴됨)'), 'YES')

// 다른 주소로는 당연히 이동한다
await runCode(`await goto('${site}/page1.html')`)
v = (await browser.pages()).find((p) => !p.url().includes('index.html'))
check('다른 주소로는 이동', v.url().endsWith('/page1.html'), true)

// 진짜로 다시 불러오고 싶으면 reload()
await v.evaluate(() => { window.__survives = 'YES' })
await runCode(`await reload()`)
v = (await browser.pages()).find((p) => !p.url().includes('index.html'))
check('reload 는 실제로 다시 불러옴', await v.evaluate(() => window.__survives ?? '(날아감)').catch(() => '(파괴됨)'), '(날아감)')

// ---- 2e. 텍스트로 찾기 (testing-library 의 getNodeText 방식) ----
const logText = await runCode(`
await goto('${site}/rooms.html')
log('찾기:', await text(/3진료실/))
log('개수:', String(await count(/3진료실/)))
log('줄바꿈 정규화:', await text(/여러 줄에 걸친/))
log('없는 것:', String(await count(/없는텍스트/)))
await click(/저장/)
log('클릭 결과:', await title())
`)
check('텍스트로 요소 찾기', /찾기: 3진료실/.test(logText), true)
// 직계 텍스트 노드만 세므로 감싸는 div, body 까지 걸리지 않는다
check('조상은 걸리지 않음', /개수: 1/.test(logText), true)
check('줄바꿈 공백 정규화', /줄바꿈 정규화: 여러 줄에 걸친 텍스트/.test(logText), true)
check('없는 텍스트는 0', /없는 것: 0/.test(logText), true)
check('텍스트로 클릭', /클릭 결과: SAVED/.test(logText), true)

const logDup = await runCode(`await goto('${site}/rooms.html')\nawait text(/중복/)`)
check('중복 매치는 무엇이 걸렸는지 말함', /2 elements matched: p "중복", p "중복"/.test(logDup), true)

const logNoText = await runCode(`await text(/없는텍스트/, 400)`)
check('없는 텍스트는 이유를 말하며 실패', /text\(\/없는텍스트\/\): no element matched/.test(logNoText), true)

// 페이지 안에서 던진 오류는 Electron 이 메시지를 삼킨다. Node 쪽에서 다시 던져야 한다.
const logEvalErr = await runCode(`await evaluate('nope.nope')`)
check('evaluate 오류 메시지 보존', /evaluate: nope is not defined/.test(logEvalErr), true)

// ---- 2f. testing-library 쿼리 (격리 월드에서) ----
const logTL = await runCode(`
await goto('${site}/rooms.html')
log('role+name  :', await text(byRole('button', { name: /저장/ })))
log('role 전체  :', JSON.stringify(await texts(byRole('button'))))
log('label      :', await attr(byLabel('이메일'), 'id'))
log('placeholder:', await attr(byPlaceholder('검색어'), 'id'))
log('testId     :', await text(byTestId('room-list')))
log('alt        :', await attr(byAlt('로고'), 'alt'))
log('byText exact:', await text(byText('3진료실')))
log('roles      :', JSON.stringify(await roles()))
await click(byRole('button', { name: /취소/ }))
log('클릭       :', await title())
`)
check('byRole + name', /role\+name  : 저장/.test(logTL), true)
check('byRole 전체', /role 전체  : \["저장","취소"\]/.test(logTL), true)
check('byLabel', /label      : email/.test(logTL), true)
check('byPlaceholder', /placeholder: q/.test(logTL), true)
check('byTestId', /testId     : 목록/.test(logTL), true)
check('byAlt', /alt        : 로고/.test(logTL), true)
check('byText 정확 일치', /byText exact: 3진료실/.test(logTL), true)
check('roles 목록', /"button".*"link"/.test(logTL), true)
check('byRole 로 클릭', /클릭       : CANCELLED/.test(logTL), true)

// 격리 월드를 쓰는 이유: 앱의 전역을 건드리지 않는다
const viewNow = (await browser.pages()).find((p) => !p.url().includes('index.html'))
check('메인 월드 오염 없음', await viewNow.evaluate(() => typeof window.__poke), 'undefined')

// 이동하면 월드가 사라지므로 다시 만들어야 한다
const logAfterNav = await runCode(`
await goto('${site}/page2.html')
log('이동 후:', await text('h1'))
await goto('${site}/rooms.html')
log('다시 이동 후:', await text(byRole('heading')))
`)
check('이동 후 월드 재생성', /이동 후: Page Two/.test(logAfterNav), true)
check('재이동 후에도 동작', /다시 이동 후: 진료실 관리/.test(logAfterNav), true)

// ---- 2g. 잘못된 선택자를 poke 의 말로 설명한다 ----
// '/3진료실/' 은 정규식처럼 보이지만 문자열이라 CSS 선택자 자리로 간다.
const logQuoted = await runCode(`await text('/3진료실/')`)
check('따옴표 친 정규식을 짚어줌', /is a string, so it is used as a CSS selector/.test(logQuoted), true)
check('고치는 법을 알려줌', /Drop the quotes to match by text instead: \/3진료실\//.test(logQuoted), true)
check('querySelectorAll 을 들먹이지 않음', /querySelectorAll/.test(logQuoted), false)

const logBadCss = await runCode(`await goto('${site}/rooms.html')\nawait text('div[')`)
check('잘못된 선택자도 poke 의 말로', /"div\[" is not a valid CSS selector/.test(logBadCss), true)

// ---- 2h0. 키 입력 ----
const logKeys = await runCode(`
await goto('${site}/keys.html')
await click('#q')
await press('Enter')
log('제출:', await title())
await type('#q', 'xy')
await press('Control+a')
log('Ctrl+a 는 글자를 넣지 않음:', await evaluate('document.querySelector("#q").value'))
await press('ctrl+shift+K')
await press('Escape')
await press('ArrowDown')
await press('Space')
log('키:', JSON.stringify(await evaluate('window.__keys')))
`)
check('Enter 로 폼 제출', /제출: SUBMITTED/.test(logKeys), true)
check('수식키 조합은 글자를 넣지 않음', /Ctrl\+a 는 글자를 넣지 않음: xy$/m.test(logKeys), true)
check('수식키가 실린 keydown', /"C-a"/.test(logKeys) && /"C-S-K"/.test(logKeys), true)
check('특수 키 이름', /"Escape","ArrowDown"," "/.test(logKeys), true)
check('키 입력은 전부 신뢰됨', /untrusted/.test(logKeys), false)

const logBadKey = await runCode(`await press('Ctrl+Foo')`)
check('모르는 키는 이유를 말하며 실패', /press\("Ctrl\+Foo"\): unknown key "Foo"/.test(logBadKey), true)

// ---- 2g2. 대화상자 ----
// Electron 은 confirm() 을 말없이 수락한다. 답하지 않으면 확인 창 없이 삭제가 진행된다.
const logDialog = await runCode(`
await goto('${site}/dialogs.html')
await click('#del')
log('기본:', await text('#out'))
acceptNextDialog()
await click('#del')
log('수락:', await text('#out'))
await click('#del')
log('일회성:', await text('#out'))
acceptNextDialog()
await click('#note')
log('alert:', await text('#out'))
await click('#del')
log('alert 가 수락을 소비:', await text('#out'))
`)
check('confirm 은 기본으로 닫힘', /기본: 취소됨/.test(logDialog), true)
check('acceptNextDialog 로 수락', /수락: 삭제됨/.test(logDialog), true)
check('수락은 한 번만', /일회성: 취소됨/.test(logDialog), true)
check('대화상자를 로그에 남김', /confirm\("정말 삭제할까요\?"\) → dismissed/.test(logDialog), true)
check('alert 는 닫히고 이어서 실행', /alert: 알림 닫힘/.test(logDialog), true)
check('alert 도 로그에 남김', /alert\("저장했습니다"\) → accepted/.test(logDialog), true)
check('걸어둔 수락은 다음 대화상자가 가져감', /alert 가 수락을 소비: 취소됨/.test(logDialog), true)

await runCode(`acceptNextDialog()`)
const logNextRun = await runCode(`await click('#del')\nlog('다음 실행:', await text('#out'))`)
check('걸어둔 수락은 다음 실행으로 새지 않음', /다음 실행: 취소됨/.test(logNextRun), true)

// ---- 2g3. 포커스 ----
// 실제 사용은 에디터에서 Ctrl+Enter 를 누르는 것이라, 실행 순간 포커스는 에디터에 있다.
await runCode(`await goto('${site}/focus.html')`)
await panel.bringToFront()
await panel.click('.cm-content')
const logFocus = await runCode(`
log('에디터 포커스:', String(await evaluate('document.hasFocus()')))
await click('#a')
log('클릭 후:', String(await evaluate('document.hasFocus()')), await evaluate('document.activeElement.id'))
await click('#b')
log('이벤트:', await evaluate('JSON.stringify(window.__ev)'))
`)
check('실행 중엔 페이지가 포커스를 가진 것처럼', /에디터 포커스: true/.test(logFocus), true)
check('클릭한 입력란이 포커스', /클릭 후: true a/.test(logFocus), true)
check('focus/blur 이벤트가 남', /"focus:a","blur:a","focus:b"/.test(logFocus), true)
const viewFocus = (await browser.pages()).find((p) => !p.url().includes('index.html'))
check('실행이 끝나면 흉내를 끔', await viewFocus.evaluate(() => document.hasFocus()), false)

// ---- 2g4. fill ----
const logFill = await runCode(`
const v = (sel) => evaluate('document.querySelector("' + sel + '").' + (sel === '#rich' ? 'textContent' : 'value'))
const why = async (fn) => { try { await fn(); return 'ok' } catch (e) { return e.message } }
await goto('${site}/input.html')
await fill('#name', '새값')
log('교체:', await v('#name'))
log('신뢰:', await evaluate('JSON.stringify(__ev.filter((e) => e.startsWith("name:")).map((e) => e.endsWith(":true")))'))
await fill('#name', '')
log('비우기:', JSON.stringify(await v('#name')))
await fill('#memo', '첫줄\\n둘째줄')
log('여러 줄:', JSON.stringify(await v('#memo')))
await fill('#name', '가\\n나')
log('한 줄 input:', await v('#name'))
await fill('#rich', '서식 없는 글')
log('contenteditable:', await v('#rich'))
log('maxlength:', await why(() => fill('#short', '12345')))
log('maxlength 그대로:', JSON.stringify(await v('#short')))
log('number:', await why(() => fill('#num', 'abc')))
log('disabled:', await why(() => fill('#off', 'x')))
log('readonly:', await why(() => fill('#ro', 'x')))
log('type 은 덧붙임:', await (async () => { await type('#name', '끝'); return v('#name') })())
`)
check('fill 은 기존 값을 바꿈', /교체: 새값$/m.test(logFill), true)
check('fill 입력은 신뢰됨', /신뢰: \[true(,true)*\]/.test(logFill), true)
check('빈 값으로 비우기', /비우기: ""/.test(logFill), true)
check('textarea 여러 줄', /여러 줄: "첫줄\\n둘째줄"/.test(logFill), true)
check('한 줄 input 의 줄바꿈은 공백', /한 줄 input: 가 나$/m.test(logFill), true)
check('contenteditable', /contenteditable: 서식 없는 글$/m.test(logFill), true)
check('maxlength 초과는 입력 전에 실패', /maxlength: fill\("#short"\): 5 characters exceed maxlength 3/.test(logFill), true)
check('실패하면 아무것도 치지 않음', /maxlength 그대로: ""/.test(logFill), true)
check('number 에 글자', /number: fill\("#num"\): "abc" is not a valid number/.test(logFill), true)
check('disabled', /disabled: fill\("#off"\): the field is disabled/.test(logFill), true)
check('readonly', /readonly: fill\("#ro"\): the field is read-only/.test(logFill), true)
check('type 은 그대로 덧붙임', /type 은 덧붙임: 가 나끝$/m.test(logFill), true)

// ---- 2g5. select ----
const logSelect = await runCode(`
const why = async (fn) => { try { await fn(); return 'ok' } catch (e) { return e.message } }
await goto('${site}/select.html')
log('값으로:', JSON.stringify(await select('#room', 'r2')), await text('#out'))
log('라벨로:', JSON.stringify(await select(byLabel('진료실'), '3진료실')), await text('#out'))
log('여러 개:', JSON.stringify(await select('#multi', ['a', 'c'])))
log('이벤트:', await evaluate('JSON.stringify(__ev)'))
log('단일에 여러 개:', await why(() => select('#room', ['r1', 'r2'])))
log('없는 옵션:', await why(() => select('#room', '없음')))
log('disabled:', await why(() => select('#off', 'x')))
log('select 아님:', await why(() => select('h1', 'x')))
`)
check('value 로 고르기', /값으로: \["r2"\] 2진료실/.test(logSelect), true)
check('라벨로 고르기', /라벨로: \["r3"\] 3진료실/.test(logSelect), true)
check('multiple', /여러 개: \["a","c"\]/.test(logSelect), true)
check('input 과 change 를 냄', /"input:room","change:room"/.test(logSelect), true)
check('단일 select 에 여러 값', /단일에 여러 개: select\("#room"\): a single select takes one value, got 2/.test(logSelect), true)
check('없는 옵션은 있는 옵션을 보여줌', /없는 옵션: select\("#room"\): no option "없음"; options are r1 "1진료실", r2 "2진료실", r3 "3진료실"/.test(logSelect), true)
check('disabled select', /disabled: select\("#off"\): the select is disabled/.test(logSelect), true)
check('select 가 아닌 대상', /select 아님: select\("h1"\): h1 is not a <select>/.test(logSelect), true)

// ---- 2g6. 동작이 일으킨 요청과 콘솔 ----
const logAct = await runCode(`
await goto('${site}/activity.html')
await click('#save')
await sleep(300)
await click('#slow')
await click('#list')
await sleep(1000)
await click('#boom')
await sleep(200)
await click('#img')
await sleep(300)
await click('#last')
`)
const actLines = logAct.split('\n').map((l) => l.trim()).filter(Boolean)
check('동작 줄에 번호', /^#2 click\("#save"\)$/m.test(actLines.join('\n')), true)
check('동작 아래 요청', /#2 click\("#save"\)\n↳ POST \/api\/save 500 \(\d+ms\)/.test(actLines.join('\n')), true)
check('console.error', /↳ console\.error: Validation failed/.test(logAct), true)
check('console.log 은 숨김', /hidden-log/.test(logAct), false)
check('Electron 자체 경고는 거름', /Electron Security Warning/.test(logAct), false)
check('늦게 끝난 요청은 동작 번호를 붙임', /↳ #3 GET \/api\/slow 200 \(\d+ms\)/.test(logAct), true)
check('제때 끝난 요청엔 번호 없음', /↳ GET \/api\/list 200/.test(logAct), true)
check('잡히지 않은 예외', /↳ uncaught Error: boom/.test(logAct), true)
check('실패한 리소스는 보임', /↳ GET \/missing\.png 404/.test(logAct), true)
check('마지막 동작의 요청을 기다려 보여줌', /↳ GET \/api\/last 200/.test(logAct), true)
check('그래도 done 이 마지막', /^done \(/.test(actLines[actLines.length - 1]), true)

// ---- 2g7. log 가 값을 찍는 방식 ----
// JSON.stringify 로 찍으면 Map 은 {} 가 되고 BigInt 와 순환 참조는 예외를 낸다.
const logValues = await runCode(`
log('map:', new Map([['a', 1]]))
log('set:', new Set([1, 2]))
log('bigint:', 10n)
const o = { name: 'o' }
o.self = o
log('cycle:', o)
log('undef:', undefined)
log('nested:', { a: [1, { b: 2 }] })
log('page:', await evaluate('({ n: 1, list: [1, 2] })'))
log('page map:', await evaluate('new Map([["k", 1]])'))
`)
check('Map 내용', /map: Map\(1\) \{ 'a' => 1 \}/.test(logValues), true)
check('Set 내용', /set: Set\(2\) \{ 1, 2 \}/.test(logValues), true)
check('BigInt', /bigint: 10n/.test(logValues), true)
check('순환 참조', /cycle: <ref \*1> \{ name: 'o', self: \[Circular \*1\] \}/.test(logValues), true)
check('undefined', /undef: undefined/.test(logValues), true)
check('중첩 객체는 한 줄', /nested: \{ a: \[ 1, \{ b: 2 \} \] \}/.test(logValues), true)
check('evaluate 결과 객체', /page: \{ n: 1, list: \[ 1, 2 \] \}/.test(logValues), true)
check('페이지의 Map 도 Map 으로 넘어옴', /page map: Map\(1\) \{ 'k' => 1 \}/.test(logValues), true)
check('log 때문에 실패하지 않음', /done \(/.test(logValues), true)

// ---- 2g8. 컴포넌트 상태 ----
// 개발 빌드가 DOM 노드에 남기는 속성만 읽는다. 페이지에 전역을 놓지 않는다.
const logReact = await runCode(`
const why = async (fn) => { try { await fn(); return 'ok' } catch (e) { return e.message } }
await goto('${site}/react.html')
const c = await component('#counter')
log('react:', c.framework, c.name, JSON.stringify(c.props), JSON.stringify(c.state))
log('위로:', (await component('#counter', 'App')).name)
log('h1 의 주인:', (await component('h1')).name)
await setState('#counter', 0, 41)
log('useState:', await text('#counter'))
await setState('#counter', 1, { done: true })
log('useReducer:', await text('#counter'))
await click('#counter')
log('그 뒤 클릭:', await text('#counter'))
log('렌더 뒤 읽기:', JSON.stringify((await component('#counter')).state[0].value))
log('없는 인덱스:', await why(() => setState('#counter', 5, 1)))
log('없는 이름:', await why(() => component('#counter', 'Nope')))
log('전역:', await evaluate('typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__'))
`)
check('React 컴포넌트 읽기', /react: react Counter \{"label":"클릭"\} \[\{"key":0,"kind":"useState","value":0\},\{"key":1,"kind":"useReducer","value":\{"done":false\}\}\]/.test(logReact), true)
check('이름으로 조상 찾기', /위로: App/.test(logReact), true)
check('요소를 그린 컴포넌트', /h1 의 주인: App/.test(logReact), true)
check('useState 쓰기', /useState: 클릭: 41 todo/.test(logReact), true)
check('useReducer 는 action 으로', /useReducer: 클릭: 41 done/.test(logReact), true)
check('쓴 값에서 이어짐', /그 뒤 클릭: 클릭: 42 done/.test(logReact), true)
check('다시 렌더링된 뒤에도 현재 값', /렌더 뒤 읽기: 42/.test(logReact), true)
check('없는 hook 인덱스', /없는 인덱스: setState\("#counter"\): no useState\/useReducer at index 5; it has 2/.test(logReact), true)
check('없는 이름은 찾은 조상을 보여줌', /없는 이름: component\("#counter"\): no React component named "Nope" above this element; found Counter < App/.test(logReact), true)
check('React 전역 훅 없음', /전역: undefined/.test(logReact), true)

const logVue = await runCode(`
const why = async (fn) => { try { await fn(); return 'ok' } catch (e) { return e.message } }
await goto('${site}/vue.html')
const v = await component('#counter')
log('vue:', v.framework, v.name, JSON.stringify(v.props), JSON.stringify(v.state))
await setState('#counter', 'count', 5)
log('쓰기:', await text('#counter'))
log('computed:', await why(() => setState('#counter', 'double', 3)))
log('없는 키:', await why(() => setState('#counter', 'nope', 1)))
log('전역:', await evaluate('typeof window.__VUE_DEVTOOLS_GLOBAL_HOOK__'))
await goto('${site}/page1.html')
log('프레임워크 없음:', await why(() => component('h1')))
`)
check('Vue 컴포넌트 읽기', /vue: vue Counter \{"label":"클릭"\} \[\{"key":"count","kind":"setup","value":0\},\{"key":"double","kind":"setup","value":0\}\]/.test(logVue), true)
check('Vue 쓰기', /쓰기: 클릭: 5 10/.test(logVue), true)
check('computed 는 읽기 전용', /computed: setState\("#counter"\): "double" did not take the value; it is read-only/.test(logVue), true)
check('없는 키는 있는 키를 보여줌', /없는 키: setState\("#counter"\): no state "nope"; it has count, double/.test(logVue), true)
check('Vue 전역 훅 없음', /전역: undefined/.test(logVue), true)
check('프레임워크 없는 페이지', /프레임워크 없음: component\("h1"\): no React or Vue component owns this element/.test(logVue), true)

// ---- 2g9. hydration 전 입력 ----
// hydrateRoot 가 불리기 전의 클릭은 리스너가 없어 사라지고, 나중에 재생되지도 않는다.
const logSsr = await runCode(`
await goto('${site}/ssr.html?delay=0')
await click('#inc')
log('바로 hydrate:', await text('#inc'))
await goto('${site}/ssr.html?delay=1500')
await click('#inc')
log('늦은 hydrate:', await text('#inc'))
await goto('${site}/ssr.html?delay=-1')
await click('#inc')
await goto('${site}/page1.html')
const t = Date.now()
await click('#probe')
log('React 아닌 페이지는 기다리지 않음:', String(Date.now() - t < 500))
`)
check('hydrate 된 페이지 클릭', /바로 hydrate: count: 1/.test(logSsr), true)
check('hydrate 를 기다렸다 클릭', /늦은 hydrate: count: 1/.test(logSsr), true)
check('기다렸다고 말함', /· waited \d+ms for React to hydrate/.test(logSsr), true)
check('끝내 hydrate 안 되면 말하고 진행', /· click: the page looks server-rendered by React but did not hydrate within 5000ms; going ahead/.test(logSsr), true)
check('React 아닌 페이지는 바로', /React 아닌 페이지는 기다리지 않음: true/.test(logSsr), true)

// ---- 2h. 응답하지 않는 페이지 ----
// 메인 스레드가 막히면 CDP 평가가 돌아오지 않는다. 버퍼가 말없이 멈추면 안 된다.
const logBusy = await runCode(`
await goto('${site}/busy.html')
await click('#block')
const started = Date.now()
try { await text('h1') } catch (e) { log('첫 호출:', e.message) }
log('첫 호출 시간:', String(Date.now() - started < 6500))
const again = Date.now()
try { await text('h1') } catch (e) { log('두번째:', e.message) }
log('두번째 즉시:', String(Date.now() - again < 500))
await sleep(3000)
log('회복:', await text('h1'))
`)
check('막힌 페이지는 데드라인으로 실패', /첫 호출: .*did not answer within 5000ms/.test(logBusy), true)
check('데드라인은 7초 블록보다 먼저', /첫 호출 시간: true/.test(logBusy), true)
check('걸린 호출 뒤엔 바로 거절', /두번째: .*still waiting/.test(logBusy), true)
check('거절은 기다리지 않음', /두번째 즉시: true/.test(logBusy), true)
check('풀리면 회복', /회복: 멈추는 페이지/.test(logBusy), true)

// ---- 2i. 격리 월드는 문서와 함께 생긴다 ----
// 생존 확인 왕복 없이, 새 문서마다 번들이 미리 설치돼 있어야 한다.
const logPre = await runCode(`
await goto('${site}/page1.html')
await click('#link')
await waitForNavigation()
log('미리 설치:', await text('h1'))
`)
check('이동 직후 쿼리', /미리 설치: Page Two/.test(logPre), true)
check('메인 월드 오염 없음 (이동 후)', await (await browser.pages()).find((p) => !p.url().includes('index.html')).evaluate(() => typeof window.__poke), 'undefined')

// ---- 3. 버퍼 전환 ----
const a = await panel.evaluate(() => window.poke.createBuffer('alpha'))
await panel.evaluate((id) => window.__pokeTest.openBuffer(id), a.id)
await panel.evaluate(() => window.__pokeTest.setCode('// ALPHA\n'))
await wait(400)
const b = await panel.evaluate(() => window.poke.createBuffer('beta'))
await panel.evaluate((id) => window.__pokeTest.openBuffer(id), b.id)
await panel.evaluate(() => window.__pokeTest.setCode('// BETA\n'))
await wait(400)
await panel.evaluate((id) => window.__pokeTest.openBuffer(id), a.id)
await wait(400)
check('버퍼 전환 후 내용 유지', (await panel.evaluate(() => window.__pokeTest.getCode())).trim(), '// ALPHA')
check('활성 버퍼 추적', await panel.evaluate(() => window.__pokeTest.activeTab()), a.id)

// ---- 4. 버퍼 이름 (Electron 은 prompt() 를 지원하지 않는다) ----
const tabNamed = async (name) => {
  for (const t of await panel.$$('.tab')) {
    if ((await t.evaluate((n) => n.textContent)) === name) return t
  }
  return null
}
const names = async () => (await panel.evaluate(() => window.poke.listBuffers())).map((b) => b.name)

const r = await panel.evaluate(() => window.poke.createBuffer('rename-me'))
await panel.evaluate((id) => window.__pokeTest.openBuffer(id), r.id)
await (await tabNamed('rename-me')).click({ count: 2 })
check('더블클릭하면 이름 입력란', await panel.evaluate(() => document.activeElement?.className), 'tab-name')
await panel.keyboard.type('새이름')
await panel.keyboard.press('Enter')
await wait(300)
check('Enter 로 이름 변경', (await names()).includes('새이름'), true)
check('탭에도 반영', Boolean(await tabNamed('새이름')), true)

await (await tabNamed('새이름')).click({ count: 2 })
await panel.keyboard.type('버릴이름')
await panel.keyboard.press('Escape')
await wait(300)
check('Escape 는 취소', (await names()).includes('새이름') && !(await names()).includes('버릴이름'), true)

await panel.click('#add')
await wait(300)
check('+ 는 바로 이름 입력란', await panel.evaluate(() => document.activeElement?.className), 'tab-name')
await panel.keyboard.type('added')
await panel.keyboard.press('Enter')
await wait(300)
check('+ 로 이름 붙여 만들기', (await names()).includes('added'), true)
check('만든 버퍼가 활성', await panel.evaluate(() => document.querySelector('.tab.active')?.textContent), 'added')

shutdown()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 통과`)
process.exit(failed.length ? 1 : 0)
