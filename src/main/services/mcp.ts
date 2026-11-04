import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '@shared/types'

/**
 * 外部 MCP 服务器（stdio）客户端。
 *
 * 约定：
 *  - 配置与 Claude Desktop 的 mcpServers 兼容（command / args / env）
 *  - 工具名加命名空间前缀 `<server>__<tool>`，避免和内置工具撞名
 *  - 连接和调用都在主进程，渲染层只拿状态
 *  - 服务器挂了不影响主程序：连不上就把错误记在状态里
 */

export interface McpToolInfo {
  /** 给模型看的完整名字：server__tool */
  name: string
  server: string
  original: string
  description: string
  inputSchema: unknown
  /** 服务器声明的行为提示（MCP annotations） */
  readOnly: boolean
  destructive: boolean
}

export interface McpServerStatus {
  name: string
  enabled: boolean
  command: string
  connected: boolean
  tools: number
  error?: string
}

interface LiveServer {
  config: McpServerConfig
  client: Client
  tools: McpToolInfo[]
}

const live = new Map<string, LiveServer>()
const status = new Map<string, { connected: boolean; error?: string; tools: number }>()

function statusOf(name: string): { connected: boolean; error?: string; tools: number } {
  return status.get(name) ?? { connected: false, tools: 0 }
}

/**
 * Windows 上 npx / uvx / python 这些是 .cmd 或需要 shell 解析，
 * 直接 spawn 会 "Connection closed"。统一用 cmd /c 包一层。
 */
function resolveLaunch(config: McpServerConfig): { command: string; args: string[] } {
  const raw = (config.command ?? '').trim()
  const args = config.args ?? []
  if (process.platform !== 'win32') return { command: raw, args }
  if (/\.(exe|cmd|bat|com)$/i.test(raw)) return { command: raw, args }
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return { command: raw, args }
  return { command: 'cmd.exe', args: ['/c', raw, ...args] }
}

function isRemote(config: McpServerConfig): boolean {
  return typeof config.url === 'string' && config.url.trim().length > 0
}

/** 远程传输：默认 streamable http；地址以 /sse 结尾或显式声明时用 SSE */
function buildRemoteTransport(config: McpServerConfig): unknown {
  const url = new URL(config.url!.trim())
  const headers = config.headers && Object.keys(config.headers).length > 0 ? { requestInit: { headers: config.headers } } : undefined
  const wantSse = config.transport === 'sse' || /\/sse\/?$/i.test(url.pathname)
  return wantSse ? new SSEClientTransport(url, headers as never) : new StreamableHTTPClientTransport(url, headers as never)
}

async function connectOne(config: McpServerConfig): Promise<LiveServer> {
  const remote = isRemote(config)
  const launch = remote ? null : resolveLaunch(config)
  const transport = remote
    ? (buildRemoteTransport(config) as Parameters<Client['connect']>[0])
    : new StdioClientTransport({
        command: launch!.command,
        args: launch!.args,
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
        stderr: 'pipe',
      })
  // 子进程崩了要把 stderr 带出来，否则只看到 "Connection closed"
  let stderrText = ''
  const child = (transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr ?? null
  if (child && typeof child.on === 'function') {
    child.on('data', (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString()).slice(-800)
    })
  }

  const client = new Client({ name: 'textharness', version: '0.4.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
  } catch (err) {
    const reason = stderrText.trim().split('\n').slice(-3).join(' / ')
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}${reason ? `（服务器输出：${reason}）` : ''}`
    )
  }
  const listed = await client.listTools()
  const tools: McpToolInfo[] = (listed.tools ?? []).map((tool) => {
    const annotations = (tool.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean }
    return {
      name: `${config.name}__${tool.name}`,
      server: config.name,
      original: tool.name,
      description: tool.description ?? `${config.name} 提供的工具`,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      readOnly: annotations.readOnlyHint === true,
      destructive: annotations.destructiveHint === true,
    }
  })
  const entry: LiveServer = { config, client, tools }
  live.set(config.name, entry)
  status.set(config.name, { connected: true, tools: tools.length })
  return entry
}

/** 连接所有启用的服务器（幂等；已连的跳过） */
export async function connectMcpServers(servers: McpServerConfig[]): Promise<McpServerStatus[]> {
  for (const config of servers) {
    if (!config.enabled) {
      status.set(config.name, { connected: false, tools: 0 })
      continue
    }
    if (!isRemote(config) && !(config.command ?? '').trim()) {
      status.set(config.name, { connected: false, tools: 0, error: '既没有 command 也没有 url' })
      continue
    }
    if (live.has(config.name)) continue
    try {
      await connectOne(config)
    } catch (err) {
      status.set(config.name, {
        connected: false,
        tools: 0,
        error: err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err),
      })
    }
  }
  return mcpStatus(servers)
}

/** 断开并清理（重启用） */
export async function disconnectMcpServer(name: string): Promise<void> {
  const entry = live.get(name)
  if (!entry) return
  live.delete(name)
  status.delete(name)
  try {
    await entry.client.close()
  } catch {
    /* ignore */
  }
}

export async function disconnectAll(): Promise<void> {
  for (const name of [...live.keys()]) await disconnectMcpServer(name)
}

export function mcpStatus(servers: McpServerConfig[]): McpServerStatus[] {
  return servers.map((config) => {
    const state = statusOf(config.name)
    return {
      name: config.name,
      enabled: config.enabled,
      command: config.url
        ? `${config.transport === 'sse' || /\/sse\/?$/i.test(config.url) ? 'SSE' : 'HTTP'} ${config.url}`
        : [config.command, ...(config.args ?? [])].join(' ').trim(),
      connected: state.connected,
      tools: state.tools,
      error: state.error,
    }
  })
}

/** 所有已连服务器的工具定义（OpenAI function 格式；parameters 是外部 schema，类型放宽） */
export function mcpToolDefs(): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  const out: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> = []
  for (const entry of live.values()) {
    for (const tool of entry.tools) {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          description: `[${tool.server}] ${tool.description}`.slice(0, 900),
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      })
    }
  }
  return out
}

/** 名字是否属于 MCP 工具 */
export function isMcpTool(name: string): boolean {
  const index = name.indexOf('__')
  if (index <= 0) return false
  return live.has(name.slice(0, index))
}

/** 转发调用 */
export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const index = name.indexOf('__')
  const serverName = index > 0 ? name.slice(0, index) : ''
  const entry = live.get(serverName)
  if (!entry) throw new Error(`MCP 服务器「${serverName}」未连接`)
  const tool = entry.tools.find((item) => item.name === name)
  if (!tool) throw new Error(`MCP 服务器「${serverName}」没有工具 ${name}`)

  const result = await entry.client.callTool({ name: tool.original, arguments: args })
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  const text = content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
    .join('\n')
    .trim()
  return text || '（工具没有返回文本内容）'
}


/**
 * 这次调用要不要先问用户。
 *  - allow-all：不问
 *  - confirm-all：一律问
 *  - confirm-write（默认）：只读工具放行，其余问
 * 没有 annotations 的服务器按「非只读」处理，宁可多问一次。
 */
export function mcpNeedsConfirm(server: McpServerConfig | undefined, name: string): boolean {
  const entry = [...live.values()].find((item) => item.tools.some((tool) => tool.name === name))
  if (!entry) return false
  const tool = entry.tools.find((item) => item.name === name)
  if (!tool) return false
  const policy = server?.policy ?? 'confirm-write'
  if (policy === 'allow-all') return false
  if (policy === 'confirm-all') return true
  return !tool.readOnly
}
