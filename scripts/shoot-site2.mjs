import { writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT ?? '9820'
const OUT_DIR = process.env.OUT_DIR ?? '.'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const shoot = async (file) => {
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(`${OUT_DIR}/${file}`, Buffer.from(shot.data, 'base64'))
  console.log('saved', file)
}

const setTheme = async (theme) => {
  await ev(`document.getElementById('btn-settings')?.click()`)
  await sleep(650)
  await ev(`(() => {
    const sel = [...document.querySelectorAll('.overlay .modal select')].find(s => [...s.options].some(o => o.value === 'light'));
    sel.value = '${theme}';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`)
  await sleep(250)
  await ev(`(() => { const b = [...document.querySelectorAll('.overlay .modal .foot .btn')].find(x => x.textContent.includes('保存')); b?.click(); return 1 })()`)
  await sleep(1300)
}

await call('Page.bringToFront')
await sleep(900)

// 新会话，右侧保持干净的空态
await ev(`document.getElementById('ai-new')?.click()`)
await sleep(600)

// 光标放在第一行标题末尾
await ev(`(() => {
  const line = document.querySelectorAll('.cm-line')[0];
  const node = line?.lastChild;
  if (!node) return 0;
  const range = document.createRange();
  range.setStart(node, node.textContent.length);
  range.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  return 1;
})()`)
await sleep(400)

await setTheme('light')
await shoot('app-light.png')
await setTheme('dark')
await shoot('app-dark.png')

// 表格截图：新开一个 7×5 的表格，填一份干净的订单样例
await ev(`document.getElementById('st-newgrid')?.click()`)
await sleep(600)
await ev(`(() => {
  const m = document.querySelector('.overlay .modal');
  if (!m) return 0;
  const i = m.querySelectorAll('input[type=number]');
  i[0].value = '7'; i[1].value = '5';
  [...m.querySelectorAll('.foot .btn')].find(b => b.textContent === '确定').click();
  return 1;
})()`)
await sleep(1000)
await ev(`(() => {
  const vals = [
    'order_id','user','amount','status','created_at',
    '20261029001','alice','128.00','已支付','2026-10-29 09:12',
    '20261029002','bob','56.50','待支付','2026-10-29 09:18',
    '20261029003','carol','980.00','已发货','2026-10-29 09:31',
    '20261029004','dave','12.90','已退款','2026-10-29 10:02',
    '20261029005','erin','420.00','已支付','2026-10-29 10:15',
    '20261029006','frank','75.00','待支付','2026-10-29 10:44'
  ];
  const cells = document.querySelectorAll('.grid-table td');
  cells.forEach((td, i) => { td.textContent = vals[i] ?? ''; td.dispatchEvent(new Event('input', { bubbles: true })); });
  return cells.length;
})()`)
await sleep(900)
await shoot('app-grid.png')
ws.close()
