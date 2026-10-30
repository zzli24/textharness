// 端到端验证 agent：发一条会触发工具调用的指令，检查工具卡片 + 落盘结果
const PORT = process.env.CDP_PORT ?? '9336'
const PROMPT =
  process.env.PROMPT ??
  '在工作区今天的日期目录里创建一个文件 agent-demo.md，内容写三行：标题、创建时间、以及一句说明这是 agent 写的。'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
if (!page) throw new Error('找不到页面')

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

async function evalJs(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result?.value
}

await evalJs(`(() => {
  const input = document.getElementById('ai-input');
  input.value = ${JSON.stringify(PROMPT)};
  document.getElementById('ai-send').click();
  return 'sent';
})()`)
console.log('已发送指令，等待 agent 执行…')

const started = Date.now()
let done = false
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const busy = await evalJs(`document.getElementById('ai-stop').hidden === false`)
  if (!busy) {
    done = true
    break
  }
  const hint = await evalJs(`document.getElementById('ai-hint').textContent`)
  process.stdout.write(`\r  [${Math.round((Date.now() - started) / 1000)}s] ${hint}          `)
}
console.log(done ? '\n完成' : '\n超时未结束')

const tools = await evalJs(`[...document.querySelectorAll('.tool')].map(t => ({
  name: t.querySelector('.tool-name')?.textContent,
  args: t.querySelector('.tool-args')?.textContent,
  state: t.querySelector('.tool-state')?.textContent,
  cls: t.className,
}))`)
console.log('工具调用:', JSON.stringify(tools, null, 2))

const transcript = await evalJs(`document.getElementById('ai-messages').innerText`)
console.log('--- 对话 ---')
console.log(transcript.slice(-1200))
ws.close()
