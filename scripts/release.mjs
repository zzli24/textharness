#!/usr/bin/env node
// 一条命令发版：
//   改版本号 → 打包 Windows → 传服务器 → 服务器提交并推 GitHub → 打 tag
//   → 等 CI 出 macOS dmg → 拉回服务器 → 生成 sha256 → 渲染官网 → 部署
//
// 用法：
//   node scripts/release.mjs 0.3.1
//   node scripts/release.mjs 0.3.1 --skip-build   # 复用已有 release/*.exe
//   node scripts/release.mjs 0.3.1 --no-site      # 不更新官网
//
// 环境变量（可选）：
//   GH_TOKEN_FILE   默认 C:\Users\lizhongzheng\Desktop\github.txt
//   DEPLOY_HOST     默认 root@47.109.100.9
//   DEPLOY_KEY      默认 deploy/keys/deploy_ed25519

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a))
const skipBuild = args.includes('--skip-build')
const noSite = args.includes('--no-site')

const TOKEN_FILE = process.env.GH_TOKEN_FILE || 'C:\\Users\\lizhongzheng\\Desktop\\github.txt'
const HOST = process.env.DEPLOY_HOST || 'root@47.109.100.9'
const KEY = join(ROOT, process.env.DEPLOY_KEY || 'deploy/keys/deploy_ed25519')

if (!version) {
  console.error('用法: node scripts/release.mjs <版本号>  例如 0.3.1')
  process.exit(1)
}
if (!existsSync(TOKEN_FILE)) {
  console.error(`找不到 GitHub token 文件: ${TOKEN_FILE}`)
  process.exit(1)
}
if (!existsSync(KEY)) {
  console.error(`找不到部署私钥: ${KEY}`)
  process.exit(1)
}

const token = readFileSync(TOKEN_FILE, 'utf8').trim()
const setup = join(ROOT, `release/TextHarness-${version}-setup.exe`)

const say = (msg) => console.log(msg)
const step = (msg) => console.log(`\n=== ${msg} ===`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
}

const run = (cmd, argv, opts = {}) => {
  const out = execFileSync(cmd, argv, {
    cwd: ROOT,
    encoding: opts.binary ? 'buffer' : 'utf8',
    stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts.extra,
  })
  return out
}

const ssh = (remoteCmd, input) =>
  run('ssh', ['-i', KEY, '-o', 'BatchMode=yes', HOST, remoteCmd], { extra: { input } })

const scp = (local, remote) => run('scp', ['-i', KEY, '-o', 'BatchMode=yes', local, `${HOST}:${remote}`])

const mb = (path) => (statSync(path).size / 1048576).toFixed(1)
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/* ---------- 1. 版本号 ---------- */
step(`1/7 改版本号 → ${version}`)
const pkgPath = join(ROOT, 'package.json')
const pkgRaw = readFileSync(pkgPath, 'utf8')
const oldVersion = /"version":\s*"([^"]+)"/.exec(pkgRaw)?.[1]
const pkgNext = pkgRaw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`)
writeFileSync(pkgPath, pkgNext, 'utf8')
ok(`package.json: ${oldVersion} → ${version}`)

/* ---------- 2. 打包 Windows ---------- */
step('2/7 打包 Windows')
if (skipBuild && existsSync(setup)) {
  ok(`跳过构建，复用 ${setup}`)
} else {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  delete process.env.ELECTRON_RUN_AS_NODE
  try {
    // Windows 上 node 不能直接 exec .cmd，交给 cmd 跑
    run('cmd.exe', ['/c', 'npm', 'run', 'dist'], { inherit: true })
  } catch (err) {
    console.error(String(err.stdout ?? '').slice(-2000))
    console.error(String(err.stderr ?? '').slice(-2000))
    fail('npm run dist 失败')
  }
  if (!existsSync(setup)) fail(`安装包没生成: ${setup}`)
}
const exeSize = mb(setup)
const exeSha = sha256(setup)
ok(`${setup}  ${exeSize} MB`)
ok(`sha256 ${exeSha}`)

/* ---------- 3. 提交本地 + 打 tar ---------- */
step('3/7 提交并打包源码')
try {
  run('git', ['add', '-A'])
  run('git', ['-c', 'user.name=TextHarness', '-c', 'user.email=dev@textharness.local', 'commit', '-q', '-m', `release: v${version}`])
  ok('已提交')
} catch {
  ok('没有文件变化，沿用当前提交')
}
const tarPath = join(ROOT, '.tmp/release.tar')
run('git', ['archive', '--format=tar', 'HEAD', '-o', tarPath])
ok(`tar ${(statSync(tarPath).size / 1024).toFixed(0)} KB`)

/* ---------- 4. 上传 ---------- */
step(`4/7 上传到 ${HOST}`)
scp(tarPath, '/tmp/release.tar')
scp(setup, '/var/www/textharness/downloads/')
scp(join(ROOT, 'scripts/release-server.sh'), '/root/release-server.sh')
ok('tar + 安装包 + 服务端脚本')

/* ---------- 5. 服务器推送 + 等 CI ---------- */
// 服务端任务可能跑 30 分钟以上，长连接 ssh 容易被中途掐断，
// 所以：先落 token，再 nohup 后台跑，客户端轮询结果文件。
step('5/7 服务器推送 GitHub 并等待 CI（约 10–25 分钟）')
ssh('cat > /tmp/.ghtok && chmod 600 /tmp/.ghtok && rm -f /root/release-result.txt', token)
ssh(`nohup setsid bash /root/release-server.sh ${version} < /dev/null > /root/release-run.log 2>&1 & echo started`)

const deadline = Date.now() + 45 * 60 * 1000
let resultRaw = ''
let lastLogLine = ''
for (;;) {
  if (Date.now() > deadline) fail('等待 CI 超时（45 分钟）')
  try {
    resultRaw = ssh('cat /root/release-result.txt 2>/dev/null')
  } catch {
    resultRaw = ''
  }
  // 把服务端日志的新行打出来，避免看起来卡死
  try {
    const last = ssh('tail -1 /root/release.log 2>/dev/null').trim()
    if (last && last !== lastLogLine) {
      lastLogLine = last
      console.log(`  ${last}`)
    }
  } catch {
    /* 忽略 */
  }
  if (/^OK=yes/m.test(resultRaw) || /^CI_FAILED=/m.test(resultRaw)) break
  await new Promise((r) => setTimeout(r, 20000))
}
const map = {}
for (const line of resultRaw.split(/\r?\n/)) {
  const idx = line.indexOf('=')
  if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1)
}
if (map.OK !== 'yes') fail(`服务器发版失败，细节见 ${HOST}:/root/release.log`)
ok(`macOS 产物就位: ${map.ARM_NAME} / ${map.X64_NAME}`)

/* ---------- 6. sha256 ---------- */
step('6/7 生成 sha256.txt')
const shaText = [
  `${exeSha}  TextHarness-${version}-setup.exe`,
  `${map.ARM_SHA}  ${map.ARM_NAME}`,
  `${map.X64_SHA}  ${map.X64_NAME}`,
].join('\n')
writeFileSync(join(ROOT, 'site/downloads/sha256.txt'), `${shaText}\n`, 'utf8')
ok('三行校验值')

// 供 scripts/render-site.mjs 单独重渲染官网文案用
writeFileSync(
  join(ROOT, 'site/downloads/meta.json'),
  `${JSON.stringify(
    {
      version,
      exe: { size: exeSize, sha: exeSha },
      arm: { size: map.ARM_SIZE, sha: map.ARM_SHA },
      x64: { size: map.X64_SIZE, sha: map.X64_SHA },
    },
    null,
    2
  )}\n`,
  'utf8'
)

/* ---------- 7. 官网 ---------- */
step('7/7 更新官网')
if (noSite) {
  ok('跳过（--no-site）')
} else {
  const tpl = readFileSync(join(ROOT, 'site/index.html'), 'utf8')
  const rendered = tpl
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{EXE_SIZE}}', exeSize)
    .replaceAll('{{EXE_SHA}}', exeSha)
    .replaceAll('{{ARM_SIZE}}', map.ARM_SIZE)
    .replaceAll('{{ARM_SHA}}', map.ARM_SHA)
    .replaceAll('{{X64_SIZE}}', map.X64_SIZE)
    .replaceAll('{{X64_SHA}}', map.X64_SHA)
  const leftover = /\{\{[A-Z_]+\}\}/.exec(rendered)
  if (leftover) fail(`官网还有没替换的占位符: ${leftover[0]}`)
  const renderedPath = join(ROOT, '.tmp/site-rendered.html')
  writeFileSync(renderedPath, rendered, 'utf8')
  scp(renderedPath, '/var/www/textharness/index.html')
  scp(join(ROOT, 'site/downloads/sha256.txt'), '/var/www/textharness/downloads/sha256.txt')
  ok('已部署 http://47.109.100.9/')
}

console.log(`\n发版完成：v${version}`)
console.log(`  Windows  TextHarness-${version}-setup.exe  ${exeSize} MB`)
console.log(`  macOS    ${map.ARM_NAME}  ${map.ARM_SIZE} MB`)
console.log(`  macOS    ${map.X64_NAME}  ${map.X64_SIZE} MB`)
console.log('  官网     http://47.109.100.9/')
