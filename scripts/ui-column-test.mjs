// 验证：① 未命名文档 Ctrl+S 直接落到当日目录 ② 列选择 + 多光标复制
const PORT = process.env.CDP_PORT ?? '9345'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result)
    pending.delete(msg.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))

function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, { resolve }))
}
async function evalJs(expression, awaitPromise = true) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) return { error: r.exceptionDetails.text }
  return r.result?.value
}

// ① 新建 + 输入 + 保存
await call('Page.bringToFront')
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true})); 'ok'`)
await new Promise((r) => setTimeout(r, 300))
await evalJs(`document.querySelector('.cm-content')?.focus(); 'focused'`)
await call('Input.insertText', { text: 'AAAA\nBBBB\nCCCC\nDDDD' })
await new Promise((r) => setTimeout(r, 300))
console.log('行数:', await evalJs(`document.querySelectorAll('.cm-line').length`))
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true})); 'ok'`)
await new Promise((r) => setTimeout(r, 1500))

console.log('保存后的状态栏:', await evalJs(`document.getElementById('st-path').textContent`))
console.log('标签标题:', await evalJs(`document.querySelector('.tab.active .title').textContent`))

// ② 列选择
await evalJs(`document.getElementById('st-column').click(); 'ok'`)
await new Promise((r) => setTimeout(r, 300))
console.log('列模式按钮:', await evalJs(`document.getElementById('st-column').textContent`))

const box = await evalJs(`(() => {
  const lines = [...document.querySelectorAll('.cm-line')];
  if (lines.length < 3) return { error: 'lines=' + lines.length };
  const a = lines[0].getBoundingClientRect();
  const c = lines[2].getBoundingClientRect();
  return { x1: a.left + 3, y1: a.top + a.height / 2, x2: c.left + 32, y2: c.top + c.height / 2 };
})()`)
console.log('拖拽坐标:', JSON.stringify(box))
if (box?.error) {
  console.log('无法测试列选择')
  ws.close()
  process.exit(1)
}

const mouse = (type, x, y) =>
  call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await mouse('mousePressed', box.x1, box.y1)
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', box.x1 + ((box.x2 - box.x1) * i) / 6, box.y1 + ((box.y2 - box.y1) * i) / 6)
  await new Promise((r) => setTimeout(r, 40))
}
await mouse('mouseReleased', box.x2, box.y2)
await new Promise((r) => setTimeout(r, 300))

const selCount = await evalJs(`document.querySelectorAll('.cm-selectionBackground').length`)
console.log('选区矩形数量:', selCount)

// 复制：直接派发 copy 事件，看 CM6 是否把多段内容写进剪贴板
const copied = await evalJs(`(() => {
  const dt = new DataTransfer();
  const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector('.cm-content').dispatchEvent(ev);
  return dt.getData('text/plain');
})()`)
console.log('复制到的内容:', JSON.stringify(copied))

// 粘贴回去，看是否按列插入
await evalJs(`(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', 'XX\\nYY\\nZZ');
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector('.cm-content').dispatchEvent(ev);
  return 'pasted';
})()`)
await new Promise((r) => setTimeout(r, 400))
console.log('粘贴后全文:\n' + (await evalJs(`document.querySelector('.cm-content').innerText`)))

ws.close()
