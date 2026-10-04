// Launches poke under Xvfb and drives its own UI over CDP.
// Verifies the two things a DevTools snippet cannot do, plus the editor loop.
import puppeteer from 'puppeteer-core'
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

const server = http.createServer((req, res) => {
  const file = path.join(HERE, 'fixtures', path.basename(req.url.split('?')[0]))
  if (fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(fs.readFileSync(file))
  } else { res.writeHead(404); res.end('x') }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const site = `http://127.0.0.1:${server.address().port}`

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

const bail = (msg) => { console.error('FAIL:', msg); shutdown(); process.exit(1) }
function shutdown() {
  try { process.kill(-proc.pid, 'SIGKILL') } catch {}
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
}

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

shutdown()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 통과`)
process.exit(failed.length ? 1 : 0)
