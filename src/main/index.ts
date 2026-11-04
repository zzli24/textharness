import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { registerIpc } from './ipc'
import { connectMcpServers } from './services/mcp'
import { loadConfig } from './services/config'
import { ensureDemoImage } from './services/demoImage'
import { markCleanExit } from './services/editorState'
import { currentLogPath, initLogger, trace } from './services/logger'
import { pruneWorkspaceCaches } from './services/maintenance'
import { checkNow as checkUpdateNow, initUpdater, quitAndInstall as quitAndInstallUpdate, updateFeedUrl } from './services/updater'
import { assertInside } from './services/files'
import { TaskScheduler } from './services/tasks'

// 日志默认写到 <userData>/logs/main.log（超过 2MB 轮转，保留 3 个），
// 用户遇到启动失败时能直接把文件发过来排查；TH_LOG 仍可覆盖路径。
initLogger()
process.on('uncaughtException', (err) => trace(`uncaughtException: ${err?.stack ?? String(err)}`))
process.on('unhandledRejection', (reason) => trace(`unhandledRejection: ${String(reason)}`))

trace(`module loaded  log=${currentLogPath() ?? '(none)'}`)

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

/** 首次启动时命令行带进来的文件：先存起来，等渲染进程启动完主动来取（可能不止一个） */
const pendingOpenFiles: string[] = []

/** 让渲染进程打开某个文件（再次双击 / 拖到图标上） */
function openFileInRenderer(path: string | null): void {
  if (!path) return
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    // 窗口还没加载完：先排队，等加载完再送进去，避免事件丢失
    if (!pendingOpenFiles.includes(path)) pendingOpenFiles.push(path)
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

  // 加载期间排队的文件，等界面就绪后统一送进去
  win.webContents.on('did-finish-load', () => {
    while (pendingOpenFiles.length) {
      const next = pendingOpenFiles.shift()
      if (next) win.webContents.send('file:open', next)
    }
  })

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
  // 已经有一个实例在跑：Windows 文件关联把文件路径塞进 argv，
  // 那个实例会收到 second-instance 事件并打开文件，这边直接退出就行。
  // 以前这里弹「唤起已有窗口 / 强制再开一个 / 退出」，双击文件先被这个框挡住，
  // 现在只在显式传 --new-instance 时才另开一个进程。
  const wantsNewInstance = process.argv.includes('--new-instance')
  trace(`single-instance lock denied, exit (newInstance=${wantsNewInstance})`)
  if (wantsNewInstance) {
    void app.whenReady().then(async () => {
      try {
        const { spawn } = await import('node:child_process')
        spawn(process.execPath, process.argv.slice(1).filter((arg) => arg !== '--new-instance'), {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, TH_NO_SINGLE_INSTANCE: '1' },
        }).unref()
        trace('relaunched with TH_NO_SINGLE_INSTANCE=1')
      } catch (err) {
        trace(`relaunch failed: ${String(err)}`)
      }
      app.quit()
    })
  } else {
    // 不能在 ready 之前 app.quit()：Electron 33 会直接 abort（退出码 0x80000003）
    void app.whenReady().then(() => app.quit())
  }
} else {
  // macOS：Finder 里双击文件走的是 open-file 事件，不是命令行参数
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady() && mainWindow) {
      if (mainWindow.webContents.isLoading()) {
        if (!pendingOpenFiles.includes(path)) pendingOpenFiles.push(path)
      } else {
        mainWindow.webContents.send('file:open', path)
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    } else {
      if (!pendingOpenFiles.includes(path)) pendingOpenFiles.push(path)
    }
  })

  app.on('second-instance', (_event, argv) => {
    const target = fileFromArgv(argv)
    trace(`second-instance argv=${JSON.stringify(argv)} file=${target ?? '(none)'}`)
    if (!mainWindow) {
      // 窗口还没建好：先把文件排队，createWindow 的 did-finish-load 会送进去
      if (target && !pendingOpenFiles.includes(target)) pendingOpenFiles.push(target)
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    // 已经开着一个实例时，双击关联文件会走到这里：把文件送进现有窗口，不弹任何框
    openFileInRenderer(target)
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

    // 清理 .history / .tmp/agent-scripts 里的老文件，避免无限增长
    try {
      const root = loadConfig().workspaceRoot
      void pruneWorkspaceCaches(root).then((res) => {
        if (res.historyRemoved || res.scriptsRemoved) {
          trace(`prune: history-${res.historyRemoved} scripts-${res.scriptsRemoved}`)
        }
      })
    } catch (err) {
      trace(`prune failed: ${String(err)}`)
    }

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

    // 启动就在后台连一次外部服务器，别等到用户点开设置才连
  setTimeout(() => {
    try {
      void connectMcpServers(loadConfig().mcpServers)
    } catch {
      /* 连不上不影响启动 */
    }
  }, 1200)

  registerIpc({
      takePendingFile: () => pendingOpenFiles.shift() ?? null,
      getWindow: () => mainWindow,
      getScheduler: () => scheduler,
      checkUpdateNow,
      quitAndInstallUpdate,
      updateFeed: updateFeedUrl,
    })

    scheduler = new TaskScheduler((event) => {
      mainWindow?.webContents.send('task:event', event)
    })
    scheduler.start()
    trace('scheduler started')

    // 自动更新：默认启动后 15 秒检查一次，之后每 6 小时一次
    try {
      const cfg = loadConfig()
      if (cfg.autoCheckUpdate !== false) {
        initUpdater((event) => mainWindow?.webContents.send('update:event', event))
      } else {
        trace('update: disabled by config')
      }
    } catch (err) {
      trace(`update init failed: ${String(err)}`)
    }

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
