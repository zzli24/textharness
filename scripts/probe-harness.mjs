import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dsh = join(homedir(), '.dsh')
const cred = readFileSync(join(dsh, '.credentials.yaml'), 'utf8')
const secret = /secret:\s*(\S+)/.exec(cred)?.[1]
if (!secret) {
  console.log('没找到 secret')
  process.exit(1)
}
console.log(`secret 长度 ${secret.length}，前缀 ${secret.slice(0, 3)}…`)

const base = process.env.HARNESS_BASE ?? 'http://127.0.0.1:49827'
const attempts = [
  ['query token', `${base}/?token=${secret}`, {}],
  ['query access_token', `${base}/?access_token=${secret}`, {}],
  ['bearer', `${base}/`, { authorization: `Bearer ${secret}` }],
  ['cookie token', `${base}/`, { cookie: `token=${secret}` }],
  ['cookie dsh_token', `${base}/`, { cookie: `dsh_token=${secret}` }],
  ['cookie dsh_web_token', `${base}/`, { cookie: `dsh_web_token=${secret}` }],
]

for (const [name, url, headers] of attempts) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual' })
    const body = await res.text()
    const setCookie = res.headers.getSetCookie?.() ?? []
    console.log(
      `${name.padEnd(20)} -> ${res.status}  len=${body.length}` +
        (setCookie.length ? `  set-cookie=${setCookie.map((c) => c.split('=')[0]).join(',')}` : '') +
        (res.status !== 200 ? `  body="${body.slice(0, 40)}"` : '  ✅')
    )
  } catch (e) {
    console.log(`${name.padEnd(20)} -> 失败 ${e.message}`)
  }
}

console.log('\n== 找端口线索 ==')
function walk(dir, depth) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (/dsh-runtimes|node_modules|session_projcache|attachments/.test(e.name)) continue
      walk(full, depth + 1)
      continue
    }
    if (!/\.(json|yaml|yml|txt|log|pid)$/i.test(e.name)) continue
    try {
      if (statSync(full).size > 300_000) continue
      const c = readFileSync(full, 'utf8')
      const m = /(https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)[^\s"']*)/.exec(c)
      if (m) console.log(`  ${full}\n    -> ${m[1].replace(/token=[^&"']+/, 'token=<masked>')}`)
    } catch {
      /* ignore */
    }
  }
}
walk(dsh, 0)
