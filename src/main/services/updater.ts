import { app } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { join } from 'node:path'
import { trace } from './logger'

/**
 * 自动更新。
 *
 * Windows：electron-updater + generic 源（我们自己的服务器 /updates）。
 *   - 启动后延迟几秒检查，之后每 6 小时一次
 *   - 后台自动下载，下完提示「重启安装」
 *   - 装的是 NSIS 包，用户数据（config/工作区）不受影响
 *
 * macOS：未签名/未公证的包 Squirrel 不认，无法自动更新。
 *   这里改成「检查版本号 + 提示去下载页」，用户手动换包。
 *
 * 所有网络失败都静默（离线用户不该看到报错）。
 */

// TH_UPDATE_URL 只在本地验证更新链路时用（指向临时服务器）
const UPDATE_URL = process.env['TH_UPDATE_URL'] ?? 'http://47.109.100.9/updates'
const FIRST_DELAY_MS = 15_000
const INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'none' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'manual'; version: string; url: string }
  | { kind: 'error'; message: string }

type Sender = (event: UpdateEvent) => void

let sender: Sender | null = null
let timer: NodeJS.Timeout | null = null
let started = false
let manualPrompted = false

function emit(event: UpdateEvent): void {
  trace(`update: ${event.kind}${'version' in event ? ` ${event.version}` : ''}`)
  sender?.(event)
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
  }
  return 0
}

/** macOS / 任何拿不到 Squirrel 的场景：查一份静态清单，只提示下载 */
async function checkManifest(): Promise<void> {
  emit({ kind: 'checking' })
  const url = `${UPDATE_URL}/latest.json?t=${Date.now()}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      emit({ kind: 'none' })
      return
    }
    const data = (await res.json()) as { version?: string; macUrl?: string; notes?: string }
    const latest = String(data.version ?? '').trim()
    if (!latest || compare(latest, app.getVersion()) <= 0) {
      emit({ kind: 'none' })
      return
    }
    emit({ kind: 'manual', version: latest, url: data.macUrl ?? 'http://47.109.100.9/#download' })
  } catch {
    // 离线 / 服务器挂了：静默
    emit({ kind: 'none' })
  }
}

/**
 * Windows 用 electron-updater 真自动更新。
 *
 * 注意：主进程是 CJS 产物，这里必须用 require 拿模块。
 * 用 `await import('electron-updater')` 时，Node 的命名导出探测认不出
 * electron-updater 用 Object.defineProperty 定义的 getter，
 * 结果 autoUpdater 是 undefined（踩过一次）。
 */
function getAutoUpdater(): AppUpdater {
  const mod = require('electron-updater') as { autoUpdater: AppUpdater }
  return mod.autoUpdater
}

async function setupElectronUpdater(): Promise<void> {
  const autoUpdater = getAutoUpdater()
  // 本地验证用：临时指向自建服务器，免得每次都往生产地址发请求
  if (process.env['TH_UPDATE_URL']) {
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL })
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => emit({ kind: 'checking' }))
  autoUpdater.on('update-not-available', () => emit({ kind: 'none' }))
  autoUpdater.on('update-available', (info) => emit({ kind: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) => emit({ kind: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => emit({ kind: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => emit({ kind: 'error', message: err?.message ?? String(err) }))

  const run = async (): Promise<void> => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      trace(`update check failed: ${String(err)}`)
    }
  }

  setTimeout(run, FIRST_DELAY_MS)
  timer = setInterval(run, INTERVAL_MS)
  timer.unref?.()
}

export function initUpdater(send: Sender): void {
  sender = send
  // 开发环境不做更新检查：没有 app-update.yml，检查只会报错
  if (!app.isPackaged) {
    trace('update: skipped (dev build)')
    return
  }
  if (started) return
  started = true

  if (process.platform === 'darwin') {
    void checkManifest()
    timer = setInterval(() => void checkManifest(), INTERVAL_MS)
    timer.unref?.()
    return
  }

  void setupElectronUpdater()
}

export async function checkNow(): Promise<void> {
  if (!app.isPackaged) {
    emit({ kind: 'error', message: '开发环境不检查更新' })
    return
  }
  if (process.platform === 'darwin') {
    manualPrompted = false
    await checkManifest()
    return
  }
  const autoUpdater = getAutoUpdater()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

export interface InstallResult {
  ok: boolean
  reason?: string
}

export function quitAndInstall(): InstallResult {
  if (process.platform === 'darwin') {
    return { ok: false, reason: 'macOS 需要手动下载安装包' }
  }
  try {
    // isSilent=false：让安装器显示进度；isForceRunAfter=true：装完自动打开
    getAutoUpdater().quitAndInstall(false, true)
    return { ok: true }
  } catch (err) {
    trace(`update install failed: ${String(err)}`)
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 供 UI 显示：更新包会下载到哪里（排查用） */
export function updateFeedUrl(): string {
  return UPDATE_URL
}

export function updaterLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'updater.log')
}

export { manualPrompted }
