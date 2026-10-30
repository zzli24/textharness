const PORT = process.env.CDP_PORT ?? '9810'
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

await call('Page.bringToFront')
await sleep(400)

// 1) 新建空白会话，让右侧干净
await ev(`document.getElementById('ai-new')?.click()`)
await sleep(600)

// 2) 新建文档并写入演示内容
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await sleep(500)
await ev(`document.querySelector('.cm-content')?.focus()`)
const demo = [
  '# MySQL 慢查询排查记录',
  '',
  '## 现象',
  '- 每天 09:00 订单接口 P99 从 120ms 涨到 2.4s',
  '- 从库 CPU 打满，主库正常',
  '',
  '## 定位',
  '先看慢日志里耗时最高的语句：',
  '',
  '```sql',
  'SELECT id, user_id, amount, created_at',
  'FROM orders',
  'WHERE status = 1 AND created_at >= ?',
  'ORDER BY created_at DESC',
  'LIMIT 20;',
  '```',
  '',
  '执行计划显示 `status` 上走了全表扫描，`created_at` 排序用了 filesort。',
  '',
  '## 处理',
  '| 步骤 | 操作 | 结果 |',
  '| --- | --- | --- |',
  '| 1 | 加联合索引 (status, created_at) | P99 降到 90ms |',
  '| 2 | 把大事务拆小 | 锁等待减少 |',
  '',
  '> 结论：联合索引顺序要和 `WHERE + ORDER BY` 对齐。',
  '',
  '## 待办',
  '1. 观察一周慢日志',
  '2. 补一份索引规范到知识库',
].join('\n')
await call('Input.insertText', { text: demo })
await sleep(700)
console.log('文档行数:', await ev(`document.querySelectorAll('.cm-line').length`))

// 3) 光标停在第一行标题后
await ev(`(() => {
  const line = document.querySelectorAll('.cm-line')[0];
  const node = line?.firstChild;
  if (!node) return 0;
  const range = document.createRange();
  range.setStart(node, Math.min(4, node.textContent.length));
  range.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  return 1;
})()`)
await sleep(300)
ws.close()
