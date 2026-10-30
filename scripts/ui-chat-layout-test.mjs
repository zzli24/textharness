const PORT = process.env.CDP_PORT ?? '9540'
let page = null
for (let i = 0; i < 120; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
    if (page) break
  } catch {
    /* not ready */
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (!page) {
  console.log('页面没起来')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).resolve(m.result)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const call = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { ERROR: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const send = async (text) => {
  await ev(`(() => {
    const input = document.getElementById('ai-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 1
  })()`)
  await ev(`document.getElementById('ai-send').click()`)
}

const layout = () =>
  ev(`(() => {
    const panel = document.getElementById('ai-slot').getBoundingClientRect();
    const composer = document.getElementById('ai-composer').getBoundingClientRect();
    const stop = document.getElementById('ai-stop');
    const stopRect = stop.getBoundingClientRect();
    return {
      panelBottom: Math.round(panel.bottom),
      composerVisible: composer.height > 0 && composer.bottom <= panel.bottom + 1,
      composerHeight: Math.round(composer.height),
      stopHidden: stop.hidden,
      stopBox: stop.hidden ? null : { w: Math.round(stopRect.width), h: Math.round(stopRect.height) },
      stopText: stop.hidden ? null : stop.textContent,
      hint: document.getElementById('ai-hint').textContent,
    }
  })()`)

const lastAssistant = () =>
  ev(`(() => {
    const msgs = [...document.querySelectorAll('#ai-messages .msg.assistant')];
    const last = msgs[msgs.length - 1];
    return last ? last.innerText.slice(-160) : '';
  })()`)

await call('Page.bringToFront')
await sleep(1200)

console.log('初始布局:', JSON.stringify(await layout()))

console.log('--- 第 1 轮 ---')
await send('用一句话说明 iptables 是什么')
await sleep(2500)
console.log('流式中布局:', JSON.stringify(await layout()))
for (let i = 0; i < 40; i += 1) {
  const done = await ev(`document.getElementById('ai-stop').hidden`)
  if (done) break
  await sleep(500)
}
console.log('第 1 轮结果:', JSON.stringify((await lastAssistant()).slice(-90)))

console.log('--- 第 2 轮（验证 reasoning_content 回传）---')
await send('再说一句它的用途')
await sleep(2500)
console.log('流式中布局:', JSON.stringify(await layout()))
for (let i = 0; i < 60; i += 1) {
  const done = await ev(`document.getElementById('ai-stop').hidden`)
  if (done) break
  await sleep(500)
}
const text2 = await lastAssistant()
console.log('第 2 轮结果:', JSON.stringify(String(text2).slice(-120)))
console.log('是否出现 400 报错:', String(text2).includes('400') || String(text2).includes('reasoning_content'))
ws.close()
