import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { registerIpc } from './ipc'
import { loadConfig } from './services/config'
import { ensureDemoImage } from './services/demoImage'
import { markCleanExit } from './services/editorState'
import { assertInside } from './services/files'
import { TaskScheduler } from './services/tasks'

const LOG_FILE = process.env['TH_LOG']
function trace(message: string): void {
  if (!LOG_FILE) return
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (err) => trace(`uncaughtException: ${err?.stack ?? String(err)}`))
process.on('unhandledRejection', (reason) => trace(`unhandledRejection: ${String(reason)}`))

trace('module loaded')

const IS_SMOKE = process.env.SMOKE === '1'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'th-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
])
trace('schemes registered')

/**
 * 从命令行里挑出"要打开的文件"。
 * 双击关联文件时 Windows 会把路径作为第一个参数传进来。
 */
function fileFromArgv(argv: string[]): string | null {
  // 打包后 argv[0] 是 exe，开发时是 electron + 脚本路径，跳过它们
  const start = app.isPackaged ? 1 : 2
  for (const arg of argv.slice(start)) {
    if (!arg || arg.startsWith('-')) continue
    try {
      if (existsSync(arg) && statSync(arg).isFile()) return arg
    } catch {
      /* 忽略非法路径 */
    }
  }
  return null
}

/** 首次启动时命令行带进来的文件：先存起来，等渲染进程启动完主动来取 */
let pendingOpenFile: string | null = null

/** 让渲染进程打开某个文件（再次双击 / 拖到图标上） */
function openFileInRenderer(path: string | null): void {
  if (!path) return
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    // 窗口还没加载完：交给渲染进程启动时来取，避免事件丢失
    pendingOpenFile = path
    return
  }
  mainWindow.webContents.send('file:open', path)
}
let mainWindow: BrowserWindow | null = null
let scheduler: TaskScheduler | null = null
let dirtyCount = 0
let forceQuit = false

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

function handleAssetProtocol(): void {
  protocol.handle('th-asset', async (request) => {
    try {
      const url = new URL(request.url)
      // th-asset://local/<encodeURIComponent(绝对路径)>
      const raw = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const cfg = loadConfig()
      const abs = assertInside(cfg.workspaceRoot, raw)
      // 直接读字节返回，比 net.fetch(file://) 更可控，也能带上 content-type
      const data = await readFile(abs)
      const type = MIME_BY_EXT[extname(abs).toLowerCase()] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': type, 'cache-control': 'no-cache' },
      })
    } catch (err) {
      console.error('[th-asset]', err)
      return new Response(`forbidden: ${String(err)}`, { status: 403 })
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1f22',
    // 带上版本号：排查问题时一眼能看出用户装的是哪一版
    title: `TextHarness ${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // 没有菜单栏时保留一个开 DevTools 的口子（F12 / Ctrl+Shift+I）
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (input.key === 'F12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools()
    }
  })

  // 调试用：把渲染进程的 console 转到主进程 stdout
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] gone:', details.reason)
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[renderer] did-fail-load ${code} ${desc}`)
    dialog.showErrorBox(
      '界面加载失败',
      `无法加载界面（${code} ${desc}）。\n\n` +
        '常见原因：安装目录被安全软件限制（如「受控文件夹访问」），或程序文件不完整。\n' +
        `当前路径：${process.execPath}\n\n` +
        '可以把程序换到另一个目录（例如 C:\\Tools\\TextHarness）再试。'
    )
  })

  // 关键：有未保存内容时拦一下退出。dirtyCount 由渲染进程持续上报。
  win.on('close', (event) => {
    if (forceQuit || dirtyCount === 0) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['取消', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      title: '有未保存的修改',
      message: `还有 ${dirtyCount} 个文件未保存，确定退出吗？`,
      detail: '退出后这些修改会丢失。',
    })
    if (choice === 0) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

// 单实例锁在部分受限环境（如嵌套沙箱）里依赖命名管道，会直接崩进程。
// 用 TH_NO_SINGLE_INSTANCE=1 可以跳过，正常桌面环境保持开启。
const USE_SINGLE_INSTANCE = process.env['TH_NO_SINGLE_INSTANCE'] !== '1'
const hasLock = USE_SINGLE_INSTANCE ? app.requestSingleInstanceLock() : true
trace(`single instance lock: ${hasLock} (enabled=${USE_SINGLE_INSTANCE})`)

if (!hasLock) {
  trace('single-instance lock denied, quitting')
  app.quit()
} else {
  // macOS：Finder 里双击文件走的是 open-file 事件，不是命令行参数
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady() && mainWindow) {
      mainWindow.webContents.send('file:open', path)
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else {
      pendingOpenFile = path
    }
  })

  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    // 已经开着一个实例时，双击关联文件会走到这里
    openFileInRenderer(fileFromArgv(argv))
  })

  app.whenReady().then(() => {
    trace('app ready')

    // Windows/Linux 上彻底移除原生菜单栏：autoHideMenuBar 的菜单会被 Alt 唤出，
    // 而 Alt 正是列选择的修饰键，两者冲突。macOS 保留（Cmd+C/V 依赖它）。
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null)
      trace('application menu removed')
    }
    handleAssetProtocol()
    trace('asset protocol handled')

    // 放一张示例图，让欢迎页的悬停预览有真实文件可指
    try {
      ensureDemoImage(loadConfig().workspaceRoot)
    } catch (err) {
      trace(`demo image failed: ${String(err)}`)
    }

    try {
      mainWindow = createWindow()
    openFileInRenderer(fileFromArgv(process.argv))
    } catch (err) {
      trace(`createWindow failed: ${String(err)}`)
      dialog.showErrorBox(
        '启动失败',
        `无法创建窗口：${String(err)}\n\n当前路径：${process.execPath}\n\n` +
          '如果路径包含中文，请把程序移动到纯英文路径后重试。'
      )
      app.quit()
      return
    }
    trace('window created')

    ipcMain.on('app:setDirty', (_event, count: number) => {
      dirtyCount = Number.isFinite(count) ? count : 0
    })

    registerIpc({
    takePendingFile: () => {
      const value = pendingOpenFile
      pendingOpenFile = null
      return value
    },
      getWindow: () => mainWindow,
      getScheduler: () => scheduler,
    })

    scheduler = new TaskScheduler((event) => {
      mainWindow?.webContents.send('task:event', event)
    })
    scheduler.start()
    trace('scheduler started')

    // 窗口获得焦点也算一次交互，避免"只在打字时才重置闲置计时"
    mainWindow.on('focus', () => scheduler?.touch())
    ipcMain.on('app:activity', () => scheduler?.touch())

    if (IS_SMOKE) {
      setTimeout(() => {
        forceQuit = true
        app.quit()
      }, 3000)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 只有真正走到退出这一步才标记「干净退出」，
  // 崩溃 / 强杀时文件里仍是 cleanExit:false，下次启动就能识别出来
  app.on('will-quit', () => {
    markCleanExit()
  })
}
