#!/usr/bin/env node
// 「补完发版」：当 release.mjs 在服务器推 tag 那步因为网络失败中断时用。
//
// 服务器到 github.com 的连接不稳（实测 main 推成功、tag 推超时），
// 这个脚本改走本机：用 GitHub API 建 tag → 轮询 CI → 本机下载 macOS 产物
// → 传到服务器 → 重算 sha256 → 重新渲染并部署官网。
//
// 用法：
//   node scripts/finish-release.mjs 0.3.7
//
// 前置：本机能访问 api.github.com（有 token 文件），已 scp 过 Windows 安装包到
//       /var/www/textharness/downloads/（release.mjs 第 4 步做过）。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = process.argv[2]
if (!VERSION) {
  console.error('用法：node scripts/finish-release.mjs 0.3.7')
  process.exit(1)
}

const HOST = process.env.DEPLOY_HOST ?? 'root@47.109.100.9'
const KEY = join(ROOT, process.env.DEPLOY_KEY ?? 'deploy/keys/deploy_ed25519')
const TOKEN_FILE = process.env.GH_TOKEN_FILE ?? join(homedir(), 'Desktop', 'github.txt')
const REPO = 'zzli24/textharness'
const API = `https://api.github.com/repos/${REPO}`
const TAG = `v${VERSION}`

const token = readFileSync(TOKEN_FILE, 'utf8').trim()

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const curl = (args) => run('curl.exe', ['-s', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json', ...args])

const step = (msg) => console.log(`\n=== ${msg} ===`)
const ok = (msg) => console.log(`  ✓ ${msg}`)

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const mb = (file) => (readFileSync(file).length / 1048576).toFixed(1)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 1. tag */
step(`1/5 确保 ${TAG} 存在`)
const tags = curl([`${API}/git/refs/tags/${TAG}`])
if (tags.includes('"ref"')) {
  ok('tag 已存在')
} else {
  const sha = curl(['-H', 'Accept: application/vnd.github.sha', `${API}/commits/main`]).trim()
  const body = join(ROOT, '.tmp/finish-tag.json')
  writeFileSync(body, JSON.stringify({ ref: `refs/tags/${TAG}`, sha }), 'utf8')
  const res = run('curl.exe', [
    '-s',
    '-X',
    'POST',
    '-H',
    `Authorization: Bearer ${token}`,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'Content-Type: application/json',
    '--data-binary',
    `@${body}`,
    `${API}/git/refs`,
  ])
  if (!res.includes('"ref"')) {
    console.error(res.slice(0, 400))
    throw new Error('建 tag 失败')
  }
  ok(`tag 已创建 → ${sha.slice(0, 7)}`)
}

/* 2. 等 CI */
step('2/5 等待 CI（macOS + Windows，约 6–10 分钟）')
let runId = null
for (let i = 0; i < 60; i += 1) {
  const list = JSON.parse(curl([`${API}/actions/runs?per_page=15`]))
  const match = list.workflow_runs.find((r) => r.head_branch === TAG)
  if (match) {
    runId = match.id
    if (match.status === 'completed') {
      if (match.conclusion !== 'success') throw new Error(`CI 失败：${match.conclusion}`)
      ok(`CI 通过（run ${runId}）`)
      break
    }
    process.stdout.write(`\r  构建中… (${match.status})`)
  }
  await sleep(20000)
}
if (!runId) throw new Error('没找到 CI 运行记录')
if (!existsSync(join(ROOT, '.tmp'))) mkdirSync(join(ROOT, '.tmp'), { recursive: true })

/* 3. 下载 macOS 产物 */
step('3/5 下载 macOS 产物')
const arts = JSON.parse(curl([`${API}/actions/runs/${runId}/artifacts`]))
const macArt = arts.artifacts.find((a) => /mac/i.test(a.name))
if (!macArt) throw new Error('没有 macOS 产物')
const zip = join(ROOT, '.tmp', `mac-${VERSION}.zip`)
const outDir = join(ROOT, '.tmp', `mac-${VERSION}`)
rmSync(outDir, { recursive: true, force: true })
run('curl.exe', ['-sL', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json', `${API}/actions/artifacts/${macArt.id}/zip`, '-o', zip])
run('python', ['-c', `import zipfile;zipfile.ZipFile(r"${zip}").extractall(r"${outDir}")`])
const dmgs = readdirSync(outDir).filter((f) => f.endsWith('.dmg'))
if (dmgs.length < 2) throw new Error(`解压出的 dmg 数量不对：${dmgs.join(', ')}`)
ok(dmgs.join(' / '))

/* 4. 传到服务器 + 重算校验值 */
step('4/5 上传到服务器并清理旧版本')
for (const name of dmgs) {
  run('scp', ['-i', KEY, '-o', 'BatchMode=yes', join(outDir, name), `${HOST}:/var/www/textharness/downloads/`])
  ok(`${name}（${mb(join(outDir, name))} MB）`)
}
const keep = [`TextHarness-${VERSION}-setup.exe`, ...dmgs]
run('ssh', [
  '-n',
  '-i',
  KEY,
  '-o',
  'BatchMode=yes',
  HOST,
  `cd /var/www/textharness/downloads && ls -1 | grep -E '^TextHarness-' | grep -v -F -e ${keep.map((k) => `'${k}'`).join(' -e ')} | xargs -r rm -f; sha256sum ${keep.map((k) => `'${k}'`).join(' ')} > sha256.txt; cat sha256.txt`,
])
ok('旧版本已清理，sha256.txt 已更新')

/* 5. 官网 */
step('5/5 渲染并部署官网')
const serverSums = run('ssh', ['-n', '-i', KEY, '-o', 'BatchMode=yes', HOST, 'cd /var/www/textharness/downloads && ls -l TextHarness-* | awk \'{print $9, $5}\''])
const sizeOf = (name) => {
  const row = serverSums.split('\n').find((l) => l.startsWith(name))
  if (!row) throw new Error(`服务器上找不到 ${name}`)
  return (Number(row.split(/\s+/)[1]) / 1048576).toFixed(1)
}
const sums = run('ssh', ['-n', '-i', KEY, '-o', 'BatchMode=yes', HOST, 'cat /var/www/textharness/downloads/sha256.txt'])
const shaOf = (name) => {
  const row = sums.split('\n').find((l) => l.endsWith(name))
  if (!row) throw new Error(`sha256.txt 里没有 ${name}`)
  return row.split(/\s+/)[0]
}

const meta = {
  version: VERSION,
  exe: { size: sizeOf(`TextHarness-${VERSION}-setup.exe`), sha: shaOf(`TextHarness-${VERSION}-setup.exe`) },
  arm: { size: sizeOf(`TextHarness-${VERSION}-arm64.dmg`), sha: shaOf(`TextHarness-${VERSION}-arm64.dmg`) },
  x64: { size: sizeOf(`TextHarness-${VERSION}-x64.dmg`), sha: shaOf(`TextHarness-${VERSION}-x64.dmg`) },
}
writeFileSync(join(ROOT, 'site/downloads/meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
run('node', [join(ROOT, 'scripts/render-site.mjs'), '--deploy'], { stdio: 'inherit' })
ok('官网已更新')

console.log(`\n补完发版：v${VERSION}`)
console.log(`  Windows  ${keep[0]}  ${meta.exe.size} MB`)
console.log(`  macOS    ${keep[1]}  ${meta.arm.size} MB`)
console.log(`  macOS    ${keep[2]}  ${meta.x64.size} MB`)
console.log(`  官网     http://47.109.100.9/`)
