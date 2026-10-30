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
export interface ApprovalRequest {
  id: string
  path: string
  before: string
  after: string
  summary: string
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
