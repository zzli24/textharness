/**
 * 归档 / 记忆 / 草稿 三个服务的单元测试（不碰真实工作区）。
 *
 * 运行：node scripts/test-services.mjs
 * 做法：esbuild 把每个服务单独打成 CJS，再在临时目录里跑断言。
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const tmp = resolve(root, '.tmp')
mkdirSync(tmp, { recursive: true })

const bundles = {
  archive: 'src/main/services/archive.ts',
  memory: 'src/main/services/memory.ts',
  drafts: 'src/main/services/drafts.ts',
}

const out = {}
for (const [name, entry] of Object.entries(bundles)) {
  const outfile = resolve(tmp, `svc-${name}.cjs`)
  await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    alias: {
      '@shared': resolve(root, 'src/shared'),
      electron: resolve(root, 'scripts/electron-stub.mjs'),
    },
    external: ['@xenova/transformers', 'onnxruntime-node', 'sharp'],
    logLevel: 'error',
  })
  out[name] = outfile
}

const requireCjs = createRequire(import.meta.url)
const archive = requireCjs(out.archive)
const memory = requireCjs(out.memory)
const drafts = requireCjs(out.drafts)

let passed = 0
const failures = []
function check(name, condition, extra = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

/* ---------------- 准备临时工作区 ---------------- */
const ws = resolve(tmp, 'svc-test-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(ws, { recursive: true })
const userData = resolve(tmp, 'svc-test-userdata')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

/* ---------------- 1. markdown 标题与插入位置 ---------------- */
console.log('1) 标题解析 / 插入位置')
{
  const doc = [
    '# 顶层',
    '',
    '## 查锁',
    '内容 A',
    '',
    '```sql',
    '## 这不是标题',
    '```',
    '',
    '## 解锁',
    '内容 B',
    '',
    '### 子节',
    '内容 C',
    '',
  ].join('\n')
  const headings = archive.listHeadings(doc)
  check('识别 4 个真标题', headings.length === 4, JSON.stringify(headings.map((h) => h.text)))
  check('代码块里的 ## 被忽略', !headings.some((h) => h.text.includes('这不是标题')))

  const lockLine = headings.find((h) => h.text === '查锁').line
  const merged = archive.insertAfterHeading(doc, lockLine, '## 新增节\n新内容')
  const order = ['## 查锁', '## 新增节', '## 解锁']
  const positions = order.map((mark) => merged.indexOf(mark))
  check('插在查锁与解锁之间', positions[0] < positions[1] && positions[1] < positions[2], JSON.stringify(positions))

  const tail = archive.insertAfterHeading(doc, 999, '## 末尾新增')
  check('找不到小节就落到文末', tail.trimEnd().endsWith('## 末尾新增'))
}

/* ---------------- 2. 知识库写入 / 追加 / 撤销 ---------------- */
console.log('2) 知识库写入与撤销')
{
  const created = archive.archiveWrite(ws, {
    target: 'knowledge',
    category: 'MySQL',
    title: '测试笔记',
    content: '## 一\n内容',
    source: 'test',
  })
  check('新建返回成功', created.ok === true)
  const file = resolve(ws, created.path)
  check('文件真的写出来了', existsSync(file))
  const text = readFileSync(file, 'utf8')
  check('带 frontmatter 与标题', text.includes('title: 测试笔记') && text.includes('# 测试笔记'))
  check('撤销信息是删除', created.undo?.action === 'delete')

  const second = archive.archiveWrite(ws, {
    target: 'knowledge',
    category: 'MySQL',
    title: '测试笔记',
    content: '第二份',
  })
  check('同名不覆盖（自动改名）', second.path !== created.path && second.path.includes('测试笔记-2'))

  const appended = archive.appendToNote(ws, created.path, '## 追加\n新行')
  check('追加成功', appended.ok === true)
  check('追加后可撤销（restore）', appended.undo?.action === 'restore')
  if (appended.undo) archive.archiveUndo(ws, appended.undo)
  check('撤销追加恢复原文', !readFileSync(file, 'utf8').includes('## 追加'))

  if (created.undo) archive.archiveUndo(ws, created.undo)
  check('撤销新建删掉了文件', !existsSync(file))
}

/* ---------------- 3. 记忆三档 + BM25 检索 ---------------- */
console.log('3) 记忆写入与检索')
{
  memory.ensureMemoryDir(ws)
  memory.remember(ws, 'fact', '用户习惯用 PowerShell 写脚本')
  memory.remember(ws, 'log', '排查 PolarDB 锁等待，抓到 3 个长事务')
  memory.remember(ws, 'template', '# 华为云申请格式\n- 项目简称 okey')
  let threw = false
  try {
    memory.remember(ws, 'fact', 'x'.repeat(300))
  } catch {
    threw = true
  }
  check('超长 fact 被拒绝', threw)

  const snapshot = memory.readMemory(ws)
  check('事实里能读到偏好', snapshot.facts.includes('PowerShell'))
  check('模板被单独列出', snapshot.templates.length === 1, JSON.stringify(snapshot.templates))

  const hits1 = memory.searchMemory(ws, '脚本语言偏好', 10)
  check('BM25 能按中文命中', hits1.length > 0 && hits1[0].text.includes('PowerShell'), JSON.stringify(hits1[0] ?? null))

  const hits2 = memory.searchMemory(ws, '锁等待', 10)
  check('BM25 命中日志', hits2.some((h) => h.text.includes('锁等待')), JSON.stringify(hits2.map((h) => h.text)))

  const hits3 = memory.searchMemory(ws, '完全不存在的关键词xyz', 10)
  check('无结果时返回空数组', hits3.length === 0)
}

/* ---------------- 4. 草稿队列 ---------------- */
console.log('4) 草稿队列')
{
  const draft = drafts.createDraft(userData, {
    title: '草稿一',
    content: '内容',
    target: 'knowledge',
    category: 'test',
    source: 'test',
    status: 'pending',
    summarized: true,
  })
  check('创建草稿', drafts.getDraft(userData, draft.id)?.title === '草稿一')
  drafts.updateDraft(userData, draft.id, { status: 'written' })
  check('更新状态', drafts.getDraft(userData, draft.id)?.status === 'written')
  drafts.createDraft(userData, {
    title: '草稿二',
    content: '内容2',
    target: 'knowledge',
    source: 'test',
    status: 'running',
    summarized: false,
  })
  check('待确认计数只算 pending/running', drafts.pendingCount(userData) === 1, String(drafts.pendingCount(userData)))
}

/* ---------------- 汇总 ---------------- */
console.log('')
if (failures.length > 0) {
  console.log(`结果：${passed} 通过 / ${failures.length} 失败`)
  for (const item of failures) console.log(`  - ${item}`)
  process.exit(1)
}
console.log(`结果：${passed} 通过 / 0 失败`)
