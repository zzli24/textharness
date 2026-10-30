import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dsh = join(homedir(), '.dsh')

function maskFile(file) {
  console.log(`\n===== ${file} =====`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    console.log('  (读取失败)', e.message)
    return
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      console.log(`  (非 key:value，${line.length} 字符)`)
      continue
    }
    const [, indent, key, value] = m
    const v = value.trim()
    if (!v) {
      console.log(`${indent}${key}:`)
    } else if (/^(url|baseurl|base_url|endpoint|host|port|model|provider)$/i.test(key)) {
      console.log(`${indent}${key}: ${v}`) // 地址类可以打印
    } else {
      console.log(`${indent}${key}: <${v.length} chars, 前缀 ${v.slice(0, 4)}…>`)
    }
  }
}

maskFile(join(dsh, '.credentials.yaml'))
maskFile(join(dsh, 'settings.yaml.imported'))

console.log('\n===== 扫描含 49827 / token 的配置 =====')
const hits = []
function walk(dir, depth) {
  if (depth > 3) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (/dsh-runtimes|node_modules|\.git/.test(e.name)) continue
      walk(full, depth + 1)
      continue
    }
    if (!/\.(ya?ml|json|txt|conf)$/i.test(e.name)) continue
    try {
      if (statSync(full).size > 200_000) continue
      const content = readFileSync(full, 'utf8')
      if (/49827/.test(content)) hits.push([full, '49827'])
      else if (/token/i.test(content)) hits.push([full, 'token'])
    } catch {
      /* ignore */
    }
  }
}
walk(dsh, 0)
for (const [f, why] of hits.slice(0, 20)) console.log(`  ${why.padEnd(6)} ${f}`)
if (!hits.length) console.log('  (没有匹配)')
