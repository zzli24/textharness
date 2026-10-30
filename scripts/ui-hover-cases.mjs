const PORT = process.env.CDP_PORT ?? '9430'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
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

async function hoverLineContaining(needle) {
  const box = await ev(`(() => {
    const line = [...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes(${JSON.stringify(needle)}));
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (!box) return { found: false }
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 40, y: box.y })
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await new Promise((r) => setTimeout(r, 900))
  return ev(`(() => {
    const img = document.querySelector('.th-hover img');
    const text = document.querySelector('.th-hover')?.textContent ?? '';
    if (!img) return { img: false, text: text.slice(0, 60) };
    return { img: true, ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight };
  })()`)
}

await call('Page.bringToFront')
await new Promise((r) => setTimeout(r, 600))

// 场景 A：用户真实遇到的那种链接（../.assets），未命名文档
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', { text: '![](../.assets/img/2026-10-29/094526-58bc2927.png)' })
await new Promise((r) => setTimeout(r, 300))
console.log('A 未命名+../ :', JSON.stringify(await hoverLineContaining('094526')))

// 场景 B：欢迎页那种 .assets（相对工作区根）
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 1`)
await new Promise((r) => setTimeout(r, 300))
await ev(`document.querySelector('.cm-content').focus(); 1`)
await call('Input.insertText', { text: '![](./.assets/img/2026-10-29/demo.png)' })
await new Promise((r) => setTimeout(r, 300))
console.log('B 未命名+.assets :', JSON.stringify(await hoverLineContaining('demo.png')))
ws.close()
