const PORT = process.env.CDP_PORT ?? '9740'
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

/* ① 点「⊞ 建表」→ 对话框 → 确定 → 出现表格标签 */
await ev(`document.getElementById('st-newgrid').click()`)
await sleep(500)
console.log('① 对话框:', await ev(`document.querySelector('.overlay .modal h2')?.textContent`))
await ev(`(() => { const b = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(x => x.textContent === '确定'); b?.click(); return 1 })()`)
await sleep(700)
console.log('   新标签:', await ev(`document.querySelector('.tab.active .title')?.textContent`))
console.log('   网格可见:', await ev(`!!document.querySelector('#grid-host.active')`), ' 编辑器隐藏:', await ev(`!!document.querySelector('#editor-host.hidden-by-grid')`))
console.log('   表格尺寸:', JSON.stringify(await ev(`({ rows: document.querySelectorAll('.grid-table tbody tr').length, cols: document.querySelectorAll('.grid-table thead th.grid-col-head').length })`)))
console.log('   状态栏:', JSON.stringify(await ev(`[document.getElementById('st-pos').textContent, document.getElementById('st-lines').textContent]`)))

/* ② 填单元格 → 检查 CSV 文本与脏标记 */
await ev(`(() => {
  const cells = document.querySelectorAll('.grid-table td');
  cells[0].textContent = 'id'; cells[1].textContent = 'name'; cells[2].textContent = 'age';
  cells[0].dispatchEvent(new Event('input', { bubbles: true }));
  cells[1].dispatchEvent(new Event('input', { bubbles: true }));
  cells[2].dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()`)
await sleep(400)
console.log('② 未保存标记:', await ev(`document.getElementById('st-dirty').textContent`))
console.log('   CSV 文本:', JSON.stringify(await ev(`document.querySelector('.grid-table') && (() => {
  const rows = [...document.querySelectorAll('.grid-table tbody tr')];
  return rows.map(r => [...r.querySelectorAll('td')].map(td => td.textContent).join(',')).join('\\n');
})()`)))

/* ③ Tab 键在单元格间移动 */
await ev(`document.querySelector('.grid-table td').focus()`)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
await sleep(300)
console.log('③ Tab 后焦点格:', JSON.stringify(await ev(`(() => { const td = document.activeElement; return td?.tagName === 'TD' ? td.dataset : td?.tagName; })()`)))

/* ④ 切回文本标签，编辑器应恢复 */
await ev(`(() => { const t = [...document.querySelectorAll('.tab')].find(x => !x.textContent.includes('.csv')); t?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1 })()`)
await sleep(600)
console.log('④ 切回文本后 网格隐藏:', !(await ev(`!!document.querySelector('#grid-host.active')`)), ' 编辑器可见:', !(await ev(`!!document.querySelector('#editor-host.hidden-by-grid')`)))
ws.close()
