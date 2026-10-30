const PORT = process.env.CDP_PORT ?? '9711'
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
await call('Page.bringToFront')
await sleep(1000)

/* ① 关标签（干净文档直接关；脏文档弹我们的对话框） */
const before = await ev(`document.querySelectorAll('.tab').length`)
await ev(`(() => {
  const x = document.querySelector('.tab .close');
  x.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  x.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 1;
})()`)
await sleep(600)
const dialog = await ev(`document.querySelector('.overlay .modal h2')?.textContent ?? null`)
const after = await ev(`document.querySelectorAll('.tab').length`)
console.log(`① 标签数 ${before} → ${after}；弹出的对话框 = ${JSON.stringify(dialog)}`)

if (dialog) {
  await ev(`(() => { const b = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(x => x.textContent === '直接关闭'); b?.click(); return 1 })()`)
  await sleep(600)
  console.log('   选择「直接关闭」后标签数:', await ev(`document.querySelectorAll('.tab').length`))
}

/* ② 标签栏溢出箭头 */
const overflow = await ev(`(() => {
  const t = document.getElementById('tabs');
  return { scrollW: t.scrollWidth, clientW: t.clientWidth, hasClass: document.getElementById('tabbar').classList.contains('has-overflow'), navW: Math.round(document.getElementById('tabs-prev').getBoundingClientRect().width) };
})()`)
console.log('② 标签栏:', JSON.stringify(overflow))
await ev(`document.getElementById('tabs-next').click()`)
await sleep(500)
console.log('   点右箭头后 scrollLeft:', await ev(`Math.round(document.getElementById('tabs').scrollLeft)`))

/* ③ 文本对比 */
await ev(`document.getElementById('st-diff').click()`)
await sleep(500)
await ev(`(() => {
  const modal = [...document.querySelectorAll('.overlay .modal')].pop();
  const areas = modal.querySelectorAll('textarea');
  areas[0].value = 'alpha\\nbravo\\ncharlie\\ndelta';
  areas[1].value = 'alpha\\nBRAVO\\ncharlie\\nzeta\\ndelta';
  [...modal.querySelectorAll('.foot .btn')].find(b => b.textContent === '开始对比').click();
  return 1;
})()`)
await sleep(600)
console.log('③ 统计:', JSON.stringify(await ev(`[...document.querySelectorAll('.cmp-chip')].map(c => c.textContent)`)))
console.log('   对比行:', JSON.stringify(await ev(`[...document.querySelectorAll('.cmp-row')].map(r => r.className.replace('cmp-row ','') + '|' + [...r.querySelectorAll('.cmp-tx')].map(t => t.textContent).join('⇄'))`)))
ws.close()
