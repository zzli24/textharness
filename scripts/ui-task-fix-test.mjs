const PORT = process.env.CDP_PORT ?? '9580'
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

const openSettings = async () => {
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true,cancelable:true}))`)
  await sleep(900)
}
const taskBoxState = () =>
  ev(`(() => {
    const boxes = [...document.querySelectorAll('.overlay .modal .task-check input[type=checkbox]')];
    return boxes.map(b => b.checked);
  })()`)

await call('Page.bringToFront')
await sleep(1200)

console.log('配置里的 tasks:', JSON.stringify(await ev(`window.th.config.get().then(c => c.tasks.map(t => ({ id: t.id, enabled: t.enabled })))`)))

/* 1. 取消勾选 → 保存 → 重开 */
await openSettings()
console.log('打开时勾选:', JSON.stringify(await taskBoxState()))
await ev(`(() => {
  const boxes = [...document.querySelectorAll('.overlay .modal .task-check input[type=checkbox]')];
  boxes.forEach(b => { if (b.checked) { b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })) } });
  return 1
})()`)
await sleep(400)
await ev(`(() => {
  const btn = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(b => b.textContent === '保存');
  btn?.click(); return 1
})()`)
await sleep(1200)
console.log('保存后配置:', JSON.stringify(await ev(`window.th.config.get().then(c => c.tasks.map(t => ({ id: t.id, enabled: t.enabled })))`)))
await openSettings()
console.log('重开后勾选:', JSON.stringify(await taskBoxState()))
await ev(`(() => {
  const btn = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(b => b.textContent === '取消');
  btn?.click(); return 1
})()`)
await sleep(500)

/* 2. 立即运行 */
console.log('--- 立即运行 ---')
await ev(`window.th.config.patch({ tasks: window.th.config.get ? undefined : undefined })`)
await ev(`(async () => {
  const cfg = await window.th.config.get();
  cfg.tasks[0].enabled = true;
  await window.th.config.patch({ tasks: cfg.tasks });
  return 1
})()`)
const started = Date.now()
const result = await ev(`window.th.tasks.run('draft-kb').then(r => 'ok').catch(e => 'ERR: ' + String(e.message).slice(0, 160))`)
console.log('运行结果:', JSON.stringify(result), '耗时', Math.round((Date.now() - started) / 1000) + 's')
console.log('任务状态:', JSON.stringify(await ev(`window.th.tasks.list().then(l => l.map(t => ({ enabled: t.enabled, desc: t.desc, last: (t.lastResult||'').slice(0,80) })))`)))
ws.close()
