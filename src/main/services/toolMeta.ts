/**
 * 内置工具的元数据。
 *
 * TOOL_DEFS 只管「给模型看的 schema」，这里管「给人看的」和「策略」：
 *  - group/label：设置页和工具面板的分组
 *  - defaultOn：默认是否启用
 *  - dangerous：是否需要用户确认（写入类）
 *
 * 新增工具时两处都要加，dev 下会校验是否漏了（见 assertToolMeta）。
 */

export type ToolGroup = 'text' | 'file' | 'app' | 'memory' | 'mcp'

export interface ToolMeta {
  /** 设置页/工具面板的显示名 */
  label: string
  group: ToolGroup
  /** 一句话说明，给设置页用（模型看的是 schema 里的 description） */
  summary: string
  defaultOn: boolean
  dangerous: boolean
}

export const TOOL_GROUP_LABEL: Record<ToolGroup, string> = {
  text: '文本处理',
  file: '文件操作',
  app: '应用控制',
  memory: '记忆',
  mcp: 'MCP 外部工具',
}

export const TOOL_META: Record<string, ToolMeta> = {
  transform_selection: {
    label: '选区变换',
    group: 'text',
    summary: '对选中的文本跑一段代码，出 diff 让你确认后再替换（可撤销）',
    defaultOn: true,
    dangerous: true,
  },
  replace_in_file: {
    label: '批量替换',
    group: 'text',
    summary: '按正则批量替换文件内容，落盘前给预览',
    defaultOn: true,
    dangerous: true,
  },
  run_script: {
    label: '脚本执行',
    group: 'text',
    summary: '写一段 Node 脚本处理大文件/多文件，执行前看源码',
    defaultOn: true,
    dangerous: true,
  },
  count_in_file: {
    label: '统计匹配',
    group: 'text',
    summary: '数一个文件里有多少处匹配、多少行，不读全文',
    defaultOn: true,
    dangerous: false,
  },
  list_images: {
    label: '列出图片',
    group: 'text',
    summary: '列出工作区里的图片，配合 set_appearance 换背景',
    defaultOn: true,
    dangerous: false,
  },
  text_stats: {
    label: '文本统计',
    group: 'text',
    summary: '行数/词数/字符数/中文数/去重行数/最长行',
    defaultOn: true,
    dangerous: false,
  },
  apply_patch: {
    label: '精准补丁',
    group: 'file',
    summary: '按上下文精确替换几行（比整篇重写安全）',
    defaultOn: true,
    dangerous: true,
  },
  read_file: {
    label: '读文件',
    group: 'file',
    summary: '读取文件内容，大文件分段返回',
    defaultOn: true,
    dangerous: false,
  },
  write_file: {
    label: '整篇写入',
    group: 'file',
    summary: '覆盖写整个文件，写入前给 diff',
    defaultOn: true,
    dangerous: true,
  },
  write_new_file: {
    label: '新建文件',
    group: 'file',
    summary: '在工作区新建一个文件',
    defaultOn: true,
    dangerous: true,
  },
  list_dir: {
    label: '列目录',
    group: 'file',
    summary: '列出工作区某个目录的内容',
    defaultOn: true,
    dangerous: false,
  },
  search_files: {
    label: '搜索文件',
    group: 'file',
    summary: '按正则在工作区里找内容',
    defaultOn: true,
    dangerous: false,
  },
  open_in_editor: {
    label: '在编辑器打开',
    group: 'file',
    summary: '把文件在编辑器里打开给用户看',
    defaultOn: true,
    dangerous: false,
  },
  app_state: {
    label: '读取编辑器状态',
    group: 'app',
    summary: '当前标签、活动文档、光标、设置、已启用工具',
    defaultOn: true,
    dangerous: false,
  },
  close_tabs: {
    label: '关闭标签',
    group: 'app',
    summary: '按条件关闭标签；未保存的默认跳过并报告',
    defaultOn: true,
    dangerous: true,
  },
  set_appearance: {
    label: '修改外观',
    group: 'app',
    summary: '主题、背景图、不透明度、模糊、暗化（可回滚）',
    defaultOn: true,
    dangerous: false,
  },
  open_settings: {
    label: '打开设置',
    group: 'app',
    summary: '把设置面板打开到指定分页，引导用户自己填',
    defaultOn: true,
    dangerous: false,
  },
  remember: {
    label: '记住',
    group: 'memory',
    summary: '把偏好/环境/结论写进 记忆/（长期事实或会话日志）',
    defaultOn: true,
    dangerous: false,
  },
  recall: {
    label: '回忆',
    group: 'memory',
    summary: '在 记忆/ 目录里检索以前记下的内容',
    defaultOn: true,
    dangerous: false,
  },
  propose_mcp_server: {
    label: '配置 MCP 服务器',
    group: 'app',
    summary: '解析用户贴的 mcpServers JSON，弹出确认框；用户确认后才写入配置',
    defaultOn: true,
    dangerous: false,
  },
  propose_archive: {
    label: '提议归档',
    group: 'memory',
    summary: '不直接写盘：打开归档面板让用户确认，确认后才写入知识库/记忆',
    defaultOn: true,
    dangerous: false,
  },
  clear_history: {
    label: '清理历史会话',
    group: 'app',
    summary: '按时间或全部删除历史对话记录（会先确认，不可恢复）',
    defaultOn: true,
    dangerous: true,
  },
  switch_tab: {
    label: '切换标签',
    group: 'app',
    summary: '按标题或路径切到某个已打开的标签',
    defaultOn: true,
    dangerous: false,
  },
}

/** 工具的默认启用集合 */
export function defaultEnabledTools(): string[] {
  return Object.entries(TOOL_META)
    .filter(([, meta]) => meta.defaultOn)
    .map(([name]) => name)
}

/** 工具总数上限（含 MCP），用户可以调 */
export const TOOL_CAP_DEFAULT = 35

/** dev 下检查 TOOL_DEFS 与 TOOL_META 是否一一对应 */
export function assertToolMeta(toolNames: string[]): void {
  const missing = toolNames.filter((name) => !TOOL_META[name])
  const extra = Object.keys(TOOL_META).filter((name) => !toolNames.includes(name))
  if (missing.length) console.warn('[toolMeta] 缺少元数据：', missing.join(', '))
  if (extra.length) console.warn('[toolMeta] 多出未实现的元数据：', extra.join(', '))
}
