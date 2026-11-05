export type Encoding = 'utf8' | 'gb18030' | 'utf16le' | 'utf16be'
export type Eol = 'LF' | 'CRLF'

export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high'

export interface AppConfig {
  /** 工作根目录 */
  workspaceRoot: string
  /** 图库目录名（相对工作根） */
  assetsDir: string
  /** 新建文件的默认编码 */
  defaultEncoding: Encoding
  theme: 'dark' | 'light'
  aiWidth: number
  sideWidth: number
  /** 模型接入：显式配置，不做任何自动发现 */
  llmBaseUrl: string
  llmModel: string
  llmApiKey: string
  /** 推理等级：auto 表示不发 reasoning_effort 字段 */
  llmReasoning: ReasoningLevel
  /** 定时任务 */
  tasks: TaskConfig[]
  /** 启动时补跑错过的任务 */
  catchUpOnLaunch: boolean
  /** 并排编辑时右栏占比 0.2~0.8 */
  splitRatio: number
  /** 每个服务商各自的 Key / 模型，切服务商时自动跟着换 */
  providerProfiles: Record<string, ProviderProfile>
  /** 启用的工具名（空数组 = 用默认集合） */
  enabledTools: string[]
  /** 工具总数上限（含 MCP），默认 35 */
  toolCap: number
  /** 外部 MCP 服务器，默认空 = 未配置 */
  mcpServers: McpServerConfig[]
  /** Markdown 即时渲染（Typora 风格）：默认开启 */
  liveMarkdown: boolean
  /** 编辑器字号（Ctrl + 滚轮调整） */
  editorFontSize: number
  /** 记忆检索是否用本地向量模型（关掉就走 BM25） */
  memorySemantic: boolean
  /** 启动后自动检查新版本 */
  autoCheckUpdate: boolean
  /** 自定义背景图：工作区内的相对路径，空字符串表示没选 */
  bgImage: string
  /** 内置背景预设序号：0 表示不用预设 */
  bgPreset: number
  /** 背景不透明度 0.05 - 0.9 */
  bgOpacity: number
  /** 背景模糊半径（px） */
  bgBlur: number
  /** 背景暗化强度 0 - 0.85，用来保证文字对比度 */
  bgDim: number
}

export type TaskTrigger =
  | { kind: 'idle'; minutes: number }
  | { kind: 'daily'; time: string }

export interface TaskConfig {
  id: string
  name: string
  enabled: boolean
  trigger: TaskTrigger
  /** 上次成功运行的时间戳 */
  lastRunAt: number | null
  /** 上次运行的简要结果 */
  lastResult?: string
}

export interface TaskEvent {
  id: string
  name: string
  phase: 'start' | 'progress' | 'done' | 'error'
  message?: string
}

/** 主进程请求用户确认一次写入（界面上展示 diff） */
/** agent 申请访问工作区外文件 */
/** agent 想跑一段脚本，执行前要用户确认 */
export interface ScriptRequest {
  id: string
  code: string
  timeoutMs: number
  scriptPath: string
}

export interface AccessRequest {
  id: string
  path: string
  /** read = 只读；write = 读写 */
  mode: 'read' | 'write'
}

export interface ApprovalRequest {
  id: string
  path: string
  before: string
  after: string
  summary: string
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: MessageContent
  /** 思考模式下必须把上一轮的思考内容带回去，否则接口报 400 */
  reasoning_content?: string
}

export interface ModelInfo {
  baseURL: string
  model: string
  hasKey: boolean
  source: 'settings' | 'env' | 'none'
  /** 凭据来源说明：设置 / 环境变量 / 未配置 */
  origin: string
}

export interface ChatDelta {
  id: string
  kind: 'content' | 'reasoning'
  text: string
}

export interface ChatDone {
  id: string
  aborted?: boolean
  error?: string
  steps?: number
}

export interface ToolEventPayload {
  id: string
  toolCallId: string
  name: string
  args: string
  phase: 'start' | 'end'
  ok?: boolean
  summary?: string
  ms?: number
}

/* ---------- 会话持久化 ---------- */

export interface StoredTool {
  name: string
  args: string
  ok: boolean
  summary?: string
  ms?: number
}

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
  /** 图片以 th-img: 引用存在会话目录里，加载时还原成 data URL */
  images?: string[]
  reasoning?: string
  tools?: StoredTool[]
}

export interface StoredSession {
  id: string
  title: string
  updatedAt: number
  messages: StoredMessage[]
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

export interface FileMeta {
  encoding: Encoding
  bom: boolean
  eol: Eol
}

export interface FileContent extends FileMeta {
  path: string
  text: string
  size: number
  readonly: boolean
  /** 只读取了前 N 字节 */
  truncated?: boolean
}

export interface FileStat {
  exists: boolean
  size: number
  mtimeMs: number
  /** 是不是目录（打开文件前用来跳过文件夹） */
  isDirectory: boolean
}

export interface SearchOptions {
  query: string
  caseSensitive?: boolean
  regex?: boolean
  wholeWord?: boolean
  maxHits?: number
}

export interface SearchHit {
  path: string
  /** 相对工作区的路径，展示用 */
  rel: string
  line: number
  column: number
  length: number
  text: string
}

export interface SearchResult {
  hits: SearchHit[]
  scannedFiles: number
  truncated: boolean
  error?: string
}

export interface ReplaceResult {
  files: number
  replacements: number
  failed: string[]
}

export interface SavedEditorTab {
  path: string | null
  title: string
  /** 未保存内容快照（未命名文档，或改过但没存的文档） */
  text?: string
  dirty?: boolean
}

export interface SavedEditorState {
  tabs: SavedEditorTab[]
  activeIndex: number
  /** 上次是否正常退出；为 false 说明崩溃/被强杀过 */
  cleanExit: boolean
}

export interface TreeNode {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

export interface SaveResult {
  ok: boolean
  /** 目标编码无法完整表示部分字符 */
  lossy: boolean
  path: string
}

/** 自动更新事件（主进程 → 界面） */
export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'none' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'manual'; version: string; url: string }
  | { kind: 'error'; message: string }

/** 外部 MCP 服务器（stdio）配置，字段与 Claude Desktop 的 mcpServers 兼容 */
/** MCP 工具调用策略：默认写操作要确认 */
export type McpToolPolicy = 'confirm-write' | 'confirm-all' | 'allow-all'

export interface McpServerConfig {
  name: string
  /** stdio：要执行的命令；http/sse 留空 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** 远程服务器地址（streamable http 或 sse） */
  url?: string
  headers?: Record<string, string>
  /** 不填：有 url 当 http，有 command 当 stdio */
  transport?: 'stdio' | 'http' | 'sse'
  enabled: boolean
  /** 不填按 confirm-write 处理 */
  policy?: McpToolPolicy
}

/** 设置页里展示的一个工具条目 */
export interface ToolListItem {
  name: string
  label: string
  group: 'text' | 'file' | 'app' | 'memory' | 'mcp'
  summary: string
  enabled: boolean
  dangerous: boolean
}

/** 编辑器当前选区 */
export interface SelectionInfo {
  id: string
  text: string
  from: number
  to: number
  path: string | null
}

/** OpenAI 兼容的多模态内容片段 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 聊天消息的 content：纯文本或多模态片段 */
export type MessageContent = string | ContentPart[]

/** 输入框里附带的图片（只存路径 + 缩略图，不把 base64 写进会话文件） */
export interface ComposerAttachment {
  id: string
  name: string
  path: string
  /** 用于预览的 data URL（可能被降采样） */
  preview: string
}

/** 单个服务商的凭据（key 是 baseURL，自定义中转站用 __custom__） */
export interface ProviderProfile {
  apiKey: string
  model: string
}

/** 归档请求：知识库或记忆 */
export interface ArchiveRequest {
  target: 'knowledge' | 'memory'
  category?: string
  title: string
  content: string
  memoryKind?: 'fact' | 'log' | 'template'
  onConflict?: 'append' | 'overwrite' | 'rename'
  source?: string
}

/** 归档结果（undo 用于撤销） */
export interface ArchiveResult {
  ok: boolean
  path: string
  undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
  text: string
}
