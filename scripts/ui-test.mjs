// 通过 CDP 在真实渲染进程里发一条消息，验证 IPC + 流式渲染
const PORT = process.env.CDP_PORT ?? '9333'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
if (!page) {
  console.log('没找到页面 target:', list.map((t) => `${t.type} ${t.url}`).join('\n'))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()

function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => reject(new Error(`${method} 超时`)), 30000)
  })
}

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})

await new Promise((resolve) => ws.addEventListener('open', resolve))
await call('Runtime.enable')

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value
}

const before = await evaluate(`document.getElementById('ai-model').textContent`)
console.log('面板模型徽标:', before)

await evaluate(`(() => {
  const input = document.getElementById('ai-input');
  input.value = '用一句话说明数据库索引的作用，不要超过 30 字。';
  document.getElementById('ai-send').click();
  return 'sent';
})()`)
console.log('已点击发送，等待流式返回…')

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const busy = await evaluate(`document.getElementById('ai-stop').hidden === false`)
  if (!busy) break
}

const transcript = await evaluate(`document.getElementById('ai-messages').innerText`)
console.log('--- 聊天记录 ---')
console.log(transcript)
console.log('----------------')

const dotClass = await evaluate(`document.getElementById('ai-dot').className`)
console.log('连接状态点:', dotClass)
ws.close()
