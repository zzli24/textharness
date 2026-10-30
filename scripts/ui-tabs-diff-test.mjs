const PORT = process.env.CDP_PORT ?? '9710'
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
await sleep(900)

/* ① 关标签：点 × 应该真的关掉 */
const before = await ev(`document.querySelectorAll('.tab').length`)
await ev(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('未命名-2.md')) || document.querySelector('.tab');
  const x = tab.querySelector('.close');
  x.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  x.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 1;
})()`)
await sleep(700)
const after = await ev(`document.querySelectorAll('.tab').length`)
console.log(`标签数: ${before} → ${after}`, before === after ? '❌ 没关掉' : '✅ 关掉了')

/* ② Tab 溢出时的箭头 */
const overflow = await ev(`(() => {
  const t = document.getElementById('tabs');
  return { scrollW: t.scrollWidth, clientW: t.clientWidth, hasClass: document.getElementById('tabbar').classList.contains('has-overflow'), prevW: Math.round(document.getElementById('tabs-prev').getBoundingClientRect().width) };
})()`)
console.log('标签栏溢出状态:', JSON.stringify(overflow))

/* ③ 文本对比窗口 */
await ev(`document.getElementById('st-diff').click()`)
await sleep(500)
console.log('窗口标题:', await ev(`[...document.querySelectorAll('.overlay .modal h2')].pop()?.textContent`))
await ev(`(() => {
  const modal = [...document.querySelectorAll('.overlay .modal')].pop();
  const areas = modal.querySelectorAll('textarea');
  areas[0].value = 'alpha\\nbravo\\ncharlie\\ndelta';
  areas[1].value = 'alpha\\nBRAVO\\ncharlie\\nzeta\\ndelta';
  const btn = [...modal.querySelectorAll('.foot .btn')].find(b => b.textContent === '开始对比');
  btn.click();
  return 1;
})()`)
await sleep(500)
console.log('统计:', await ev(`[...document.querySelectorAll('.cmp-chip')].map(c => c.textContent)`))
console.log('对比行数:', await ev(`document.querySelectorAll('.cmp-row').length`))
console.log('前 5 行:', JSON.stringify(await ev(`[...document.querySelectorAll('.cmp-row')].slice(0,5).map(r => r.className.replace('cmp-row ','') + ' | ' + [...r.querySelectorAll('.cmp-tx')].map(t => t.textContent).join(' ⇄ '))`)))
ws.close()
