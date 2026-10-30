import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import type { AppConfig, ChatMessage, FileMeta } from '@shared/types'
import { dayStamp, savePastedImage } from './services/assets'
import { loadEditorState, saveEditorState, type SavedEditorState } from './services/editorState'
import { loadConfig, patchConfig } from './services/config'
import { runAgent, type AgentMessage } from './services/agent'
import { listModels, modelInfo } from './services/llm'
import { deleteSession, listSessions, loadSession, saveSession, type StoredSession } from './services/sessions'
import { listFiles, replaceInFiles, searchInFiles, type SearchOptions } from './services/search'
import {
  assertInside,
  createEntry,
  ensureDir,
  listTree,
  nextAvailablePath,
  readFileContent,
  removeEntry,
  renameEntry,
  statFile,
  writeFileContent,
} from './services/files'

export interface IpcDeps {
  getWindow(): BrowserWindow | null
  getScheduler(): { runNow(id: string): Promise<void>; isRunning(id: string): boolean; describe(task: AppConfig['tasks'][number]): string } | null
  /** 取走启动参数里的文件路径（取一次就清空） */
  takePendingFile(): string | null
}

export function registerIpc(deps: IpcDeps): void {
  /* ---------- 配置 ---------- */
  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) => patchConfig(patch))

  ipcMain.handle('config:pickDirectory', async () => {
    const win = deps.getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  /* ---------- 文件 ---------- */
  ipcMain.handle('fs:tree', async (_e, root: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, root)
    return listTree(root)
  })

  ipcMain.handle('fs:read', async (_e, path: string, options?: { maxBytes?: number }) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    return readFileContent(path, options)
  })

  ipcMain.handle('fs:stat', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    return statFile(path)
  })

  ipcMain.handle('fs:files', async () => {
    const cfg = loadConfig()
    return listFiles(cfg.workspaceRoot)
  })

  ipcMain.handle('search:files', async (_e, options: SearchOptions) => {
    const cfg = loadConfig()
    return searchInFiles(cfg.workspaceRoot, options)
  })

  ipcMain.handle(
    'search:replace',
    async (_e, paths: string[], options: SearchOptions, replacement: string) => {
      const cfg = loadConfig()
      return replaceInFiles(cfg.workspaceRoot, paths, options, replacement)
    }
  )

  ipcMain.handle('fs:write', async (_e, path: string, text: string, meta: FileMeta, dryRun = false) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    return writeFileContent(path, text, meta, dryRun)
  })

  ipcMain.handle('fs:create', async (_e, parent: string, name: string, isDir: boolean) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, parent)
    return createEntry(parent, name, isDir)
  })

  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, from)
    assertInside(cfg.workspaceRoot, dirname(to))
    return renameEntry(from, to)
  })

  ipcMain.handle('fs:remove', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await removeEntry(path)
  })

  ipcMain.handle('fs:reveal', async (_e, path: string) => {
    const cfg = loadConfig()
    const abs = assertInside(cfg.workspaceRoot, path)

    try {
      shell.showItemInFolder(abs)
      return { ok: true }
    } catch (err) {
      // 兜底：至少把所在目录打开
      const message = await shell.openPath(dirname(abs))
      return { ok: !message, error: message || String(err) }
    }
  })

  ipcMain.handle('fs:trash', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await shell.trashItem(path)
  })

  ipcMain.handle('app:copyText', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('app:readText', () => clipboard.readText())

  // 启动时命令行带进来的文件，由渲染进程启动完成后取走
  ipcMain.handle('app:takePendingFile', () => deps.takePendingFile())

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('fs:openDir', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await ensureDir(path)
    return shell.openPath(path)
  })

  ipcMain.handle('assets:info', () => {
    const cfg = loadConfig()
    const dir = join(cfg.workspaceRoot, cfg.assetsDir || '.assets', 'img')
    return { dir, today: join(dir, dayStamp()) }
  })

  ipcMain.handle('state:load', () => loadEditorState())
  ipcMain.handle('state:save', (_e, state: SavedEditorState) => saveEditorState({ ...state, cleanExit: false }))

  ipcMain.handle('fs:exists', (_e, path: string) => existsSync(path))

  ipcMain.handle('fs:ensureDir', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await ensureDir(path)
  })

  ipcMain.handle('fs:nextPath', async (_e, dir: string, name: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, dir)
    return nextAvailablePath(dir, name)
  })

  ipcMain.handle('fs:pickOpen', async () => {
    const win = deps.getWindow()
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [
        { name: '文本', extensions: ['txt', 'md', 'sql', 'json', 'log', 'yml', 'yaml', 'ini', 'csv'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:pickImage', async () => {
    const win = deps.getWindow()
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  /** 把用户选的图片复制进工作区 .assets/bg/，配置里只存相对路径 */
  ipcMain.handle('fs:importImage', async (_e, sourcePath: string) => {
    const cfg = loadConfig()
    if (!existsSync(sourcePath)) return null
    const dir = join(cfg.workspaceRoot, cfg.assetsDir, 'bg')
    await mkdir(dir, { recursive: true })

    const original = basename(sourcePath)
    const ext = extname(original)
    const stem = original.slice(0, original.length - ext.length)
    let target = join(dir, original)
    let index = 1
    while (existsSync(target)) {
      target = join(dir, `${stem}-${index}${ext}`)
      index += 1
    }
    await copyFile(sourcePath, target)
    return {
      path: relative(cfg.workspaceRoot, target).split(sep).join('/'),
      name: basename(target),
    }
  })

  const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  }

  /** 把图片读成 data URL（裁剪对话框要用，th-asset 只允许工作区内路径） */
  ipcMain.handle('fs:readImageData', async (_e, sourcePath: string) => {
    if (!existsSync(sourcePath)) return null
    const data = await readFile(sourcePath)
    if (data.byteLength > 40 * 1024 * 1024) throw new Error('图片太大（超过 40 MB）')
    const type = IMAGE_MIME[extname(sourcePath).toLowerCase()] ?? 'image/png'
    return {
      dataUrl: `data:${type};base64,${data.toString('base64')}`,
      name: basename(sourcePath),
    }
  })

  /** 保存裁剪结果到 .assets/bg/ */
  ipcMain.handle('fs:writeImage', async (_e, dataUrl: string, originalName: string) => {
    const match = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(dataUrl)
    if (!match) throw new Error('图片数据格式不对')
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length < 1024) throw new Error('图片数据不完整，请重新选取')
    // 至少校验一下文件头，避免把半截数据写进工作区
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50
    const isWebp = buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    if (!isJpeg && !isPng && !isWebp) throw new Error('图片数据格式无法识别')
    const cfg = loadConfig()
    const dir = join(cfg.workspaceRoot, cfg.assetsDir, 'bg')
    await mkdir(dir, { recursive: true })

    const stem = (originalName.replace(/\.[^.]+$/, '') || 'background').slice(0, 40)
    const stamp = Date.now().toString(36)
    let target = join(dir, `${stem}-${stamp}.${ext}`)
    let index = 1
    while (existsSync(target)) {
      target = join(dir, `${stem}-${stamp}-${index}.${ext}`)
      index += 1
    }
    await writeFile(target, buffer)
    return {
      path: relative(cfg.workspaceRoot, target).split(sep).join('/'),
      name: basename(target),
    }
  })

  ipcMain.handle('fs:pickSave', async (_e, defaultPath: string) => {
    const win = deps.getWindow()
    const cfg = loadConfig()
    const options = {
      defaultPath,
      filters: [
        { name: '文本', extensions: ['txt', 'md', 'sql', 'json', 'log', 'yml', 'yaml', 'ini', 'csv'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    // 只允许存到工作目录内，保证后续 fs:write 的越界校验不会误伤
    assertInside(cfg.workspaceRoot, result.filePath)
    return result.filePath
  })

  /* ---------- 图库 ---------- */
  ipcMain.handle('assets:save', (_e, input: { docPath: string | null; mime: string; bytes: Uint8Array }) => {
    const cfg = loadConfig()
    if (input.docPath) assertInside(cfg.workspaceRoot, input.docPath)
    return savePastedImage(cfg.workspaceRoot, cfg.assetsDir, input.docPath, input.mime, Buffer.from(input.bytes))
  })

  /* ---------- 内置对话（直连模型） ---------- */
  const controllers = new Map<string, AbortController>()

  /* 写入确认：主进程发起 → 渲染进程弹 diff → 回结果 */
  const pendingApprovals = new Map<string, (ok: boolean) => void>()

  ipcMain.on('ai:approval:result', (_e, payload: { id: string; ok: boolean }) => {
    const resolve = pendingApprovals.get(payload.id)
    if (!resolve) return
    pendingApprovals.delete(payload.id)
    resolve(Boolean(payload.ok))
  })

  ipcMain.handle('ai:model', () => modelInfo(loadConfig()))
  ipcMain.handle('ai:models', () => listModels(loadConfig()))

  ipcMain.handle('ai:chat', (event, payload: { id: string; messages: ChatMessage[] }) => {
    const cfg = loadConfig()
    const controller = new AbortController()
    controllers.set(payload.id, controller)
    const sender = event.sender
    const send = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }

    void runAgent({
      cfg,
      messages: payload.messages.filter((m) => m.role !== 'system') as AgentMessage[],
      signal: controller.signal,
      toolContext: {
        root: cfg.workspaceRoot,
        assetsDir: cfg.assetsDir,
        openInEditor: (path: string) => send('file:open', path),
        approve: (request) =>
          new Promise<boolean>((resolve) => {
            const approvalId = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
            const timer = setTimeout(() => {
              if (pendingApprovals.delete(approvalId)) resolve(false)
            }, 120_000)
            pendingApprovals.set(approvalId, (ok) => {
              clearTimeout(timer)
              resolve(ok)
            })
            send('ai:approval', { id: approvalId, ...request })
          }),
      },
      events: {
        onDelta: (kind, text) => send('ai:delta', { id: payload.id, kind, text }),
        onTool: (toolEvent) => send('ai:tool', { id: payload.id, ...toolEvent }),
      },
    })
      .then(({ steps }) => send('ai:done', { id: payload.id, steps }))
      .catch((err: unknown) => {
        const aborted = controller.signal.aborted
        send('ai:done', {
          id: payload.id,
          aborted,
          error: aborted ? undefined : err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => controllers.delete(payload.id))

    return { id: payload.id }
  })

  ipcMain.on('ai:abort', (_e, id: string) => {
    controllers.get(id)?.abort()
    controllers.delete(id)
  })

  /* ---------- 定时任务 ---------- */
  ipcMain.handle('tasks:list', () => {
    const cfg = loadConfig()
    const scheduler = deps.getScheduler()
    return cfg.tasks.map((task) => ({
      ...task,
      running: scheduler?.isRunning(task.id) ?? false,
      next: scheduler?.describe(task) ?? '',
    }))
  })

  ipcMain.handle('tasks:toggle', (_e, id: string, enabled: boolean) => {
    const cfg = loadConfig()
    patchConfig({ tasks: cfg.tasks.map((task) => (task.id === id ? { ...task, enabled } : task)) })
    return true
  })

  ipcMain.handle('tasks:run', async (_e, id: string) => {
    const scheduler = deps.getScheduler()
    if (!scheduler) throw new Error('调度器未启动')
    await scheduler.runNow(id)
  })

  ipcMain.on('app:activity', () => deps.getScheduler()?.touch())

  /* ---------- 会话 ---------- */
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:load', (_e, id: string) => loadSession(id))
  ipcMain.handle('sessions:save', (_e, session: StoredSession) => saveSession(session))
  ipcMain.handle('sessions:delete', (_e, id: string) => deleteSession(id))
}
