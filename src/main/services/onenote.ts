import { app } from 'electron'
import { createWriteStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import AdmZip from 'adm-zip'

/**
 * OneNote 导出：调用第三方工具 OneNoteMdExporter（GPL-3.0）。
 *
 * - 不打包进安装包，也不随应用分发；首次使用时从我们自己的服务器下载官方 release 压缩包
 * - 只支持 Windows 桌面版 OneNote + Word
 * - 导出目录在工具自己的 runs/<时间>/Exports 下，导出完直接走通用 Markdown 导入
 */

const TOOL_VERSION = '1.6.0'
const TOOL_URL = `http://47.109.100.9/tools/OneNoteMdExporter-${TOOL_VERSION}.zip`
// 官方 v1.6.0 release 压缩包的 SHA256，防止下载被篡改
const TOOL_SHA256 = 'a7d4aef91fd578c8bf8637aa15a8a184ef47b59402f3c2988d30cc5a3f0ff4a4'

export interface OneNoteProgress {
  phase: 'download' | 'extract' | 'export' | 'import'
  percent?: number
  message?: string
}

export interface OneNoteStatus {
  platform: string
  oneNoteFound: boolean
  wordFound: boolean
  toolInstalled: boolean
  toolExe: string | null
  ready: boolean
  reason?: string
}

function firstExisting(paths: string[]): string | null {
  const fsSync = require('node:fs') as typeof import('node:fs')
  for (const path of paths) {
    if (fsSync.existsSync(path)) return path
  }
  return null
}

function findOfficeExe(name: string): string | null {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const candidates = [
    join(pf, 'Microsoft Office', 'root', 'Office16', name),
    join(pf86, 'Microsoft Office', 'root', 'Office16', name),
    join(pf, 'Microsoft Office', 'Office16', name),
    join(pf86, 'Microsoft Office', 'Office16', name),
  ]
  return firstExisting(candidates)
}

function toolRoot(): string {
  return join(app.getPath('userData'), 'tools', 'onenote-md-exporter')
}

function findExeSync(root: string): string | null {
  const fsSync = require('node:fs') as typeof import('node:fs')
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.toLowerCase() === 'onenotemdexporter.exe') return full
    }
  }
  return null
}

export function getOneNoteStatus(): OneNoteStatus {
  const platform = process.platform
  const oneNoteFound = findOfficeExe('ONENOTE.EXE') !== null
  const wordFound = findOfficeExe('WINWORD.EXE') !== null
  const toolExe = platform === 'win32' ? findExeSync(toolRoot()) : null
  const toolInstalled = Boolean(toolExe)
  let reason: string | undefined
  if (platform !== 'win32') reason = 'OneNote 导出只支持 Windows'
  else if (!oneNoteFound) reason = '没有找到 OneNote 桌面版（商店版不支持）'
  else if (!wordFound) reason = '没有找到 Word 桌面版'
  else if (!toolInstalled) reason = '首次使用需要下载导出工具（约 75MB）'
  return {
    platform,
    oneNoteFound,
    wordFound,
    toolInstalled,
    toolExe,
    ready: platform === 'win32' && oneNoteFound && wordFound,
    reason,
  }
}

export async function installOneNoteTool(
  onProgress: (progress: OneNoteProgress) => void
): Promise<{ ok: boolean; exe?: string; error?: string }> {
  try {
    await fs.mkdir(toolRoot(), { recursive: true })
    const zipPath = join(toolRoot(), 'tool.zip')
    onProgress({ phase: 'download', percent: 0, message: '正在下载导出工具…' })

    const response = await fetch(TOOL_URL)
    if (!response.ok || !response.body) {
      return { ok: false, error: `下载失败：HTTP ${response.status}` }
    }
    const total = Number(response.headers.get('content-length') ?? 0)
    const writer = createWriteStream(zipPath)
    const reader = response.body.getReader()
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        writer.write(Buffer.from(value))
        if (total > 0) {
          onProgress({
            phase: 'download',
            percent: Math.round((received / total) * 100),
            message: `正在下载导出工具 ${Math.round((received / total) * 100)}%`,
          })
        }
      }
    }
    await new Promise<void>((resolve) => writer.end(resolve))

    const digest = createHash('sha256').update(await fs.readFile(zipPath)).digest('hex')
    if (digest !== TOOL_SHA256) {
      await fs.rm(zipPath, { force: true })
      return { ok: false, error: '导出工具校验失败，请重试' }
    }

    onProgress({ phase: 'extract', message: '正在解压…' })
    const zip = new AdmZip(zipPath)
    zip.extractAllTo(toolRoot(), true)
    await fs.rm(zipPath, { force: true })
    const exe = findExeSync(toolRoot())
    if (!exe) return { ok: false, error: '解压后没有找到 OneNoteMdExporter.exe' }
    return { ok: true, exe }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runOneNoteExport(
  onProgress: (progress: OneNoteProgress) => void
): Promise<{ ok: boolean; dir?: string; count?: number; error?: string }> {
  const status = getOneNoteStatus()
  if (!status.ready) return { ok: false, error: status.reason ?? '环境不满足' }

  let exe = status.toolExe
  if (!exe) {
    const installed = await installOneNoteTool(onProgress)
    if (!installed.ok || !installed.exe) return { ok: false, error: installed.error ?? '工具安装失败' }
    exe = installed.exe
  }

  const runDir = join(toolRoot(), 'runs', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'))
  await fs.mkdir(runDir, { recursive: true })
  onProgress({ phase: 'export', message: '正在调用 OneNote 导出，第一次会比较慢…' })

  const result = await new Promise<{ code: number | null; output: string[] }>((resolve) => {
    const child = spawn(exe as string, ['--all-notebooks', '-f', '1', '--no-input', '--ignore-errors'], {
      cwd: runDir,
      windowsHide: true,
    })
    const output: string[] = []
    const handle = (data: Buffer): void => {
      const text = data.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        output.push(trimmed)
        onProgress({ phase: 'export', message: trimmed.slice(0, 160) })
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    child.on('error', (err) => {
      output.push(String(err))
      resolve({ code: -1, output })
    })
    child.on('close', (code) => resolve({ code, output }))
  })

  const exportsDir = join(runDir, 'Exports')
  const exists = await fs.stat(exportsDir).then(() => true).catch(() => false)
  if (!exists) {
    return {
      ok: false,
      error: result.code === 0 ? '导出完成但没有找到 Exports 目录' : `导出失败（退出码 ${result.code}）`,
    }
  }

  let count = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.toLowerCase().endsWith('.md')) count += 1
    }
  }
  await walk(exportsDir)
  return { ok: true, dir: exportsDir, count }
}
