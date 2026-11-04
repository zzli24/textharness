import { app, ipcMain, shell } from 'electron'
import { loadConfig } from './services/config'
import { ensureMemoryDir, listMemoryFiles, readMemory, writeMemoryFile } from './services/memory'
import { connectMcpServers, disconnectMcpServer, mcpStatus } from './services/mcp'

/**
 * 记忆与 MCP 的 IPC 注册。
 *
 * 从 ipc.ts 拆出来：这两块只依赖 config + 各自的服务，
 * 不需要工具上下文/审批桥，放一起读起来更清楚。
 */
export function registerServiceIpc(): void {
  /* ---------- MCP ---------- */
  ipcMain.handle('mcp:status', async () => {
    const cfg = loadConfig()
    await connectMcpServers(cfg.mcpServers)
    return mcpStatus(cfg.mcpServers)
  })
  ipcMain.handle('mcp:reconnect', async (_e, name: string) => {
    const cfg = loadConfig()
    if (name) await disconnectMcpServer(name)
    await connectMcpServers(cfg.mcpServers)
    return mcpStatus(cfg.mcpServers)
  })

  /* ---------- 记忆 ---------- */
  ipcMain.handle('memory:snapshot', () => {
    const cfg = loadConfig()
    const snapshot = readMemory(cfg.workspaceRoot)
    return { ...snapshot, files: listMemoryFiles(cfg.workspaceRoot) }
  })
  ipcMain.handle('memory:save', (_e, content: string) => {
    const cfg = loadConfig()
    writeMemoryFile(cfg.workspaceRoot, String(content))
    return { ok: true }
  })
  ipcMain.handle('memory:ensure', () => {
    const cfg = loadConfig()
    ensureMemoryDir(cfg.workspaceRoot)
    return { ok: true }
  })
  ipcMain.handle('memory:buildSemantic', async () => {
    const cfg = loadConfig()
    const { buildSemanticIndex } = await import('./services/semanticIndex')
    return buildSemanticIndex(cfg.workspaceRoot, app.getPath('userData'))
  })
  ipcMain.handle('memory:semanticStatus', async () => {
    const cfg = loadConfig()
    const { semanticStatus } = await import('./services/semanticIndex')
    return { ...semanticStatus(), enabled: cfg.memorySemantic === true }
  })
  ipcMain.handle('memory:reveal', async () => {
    const cfg = loadConfig()
    const dir = ensureMemoryDir(cfg.workspaceRoot)
    await shell.openPath(dir)
    return { ok: true }
  })
}
