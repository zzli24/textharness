/**
 * 文件类型图标（单色线性，14px 为主）。
 *
 * 设计原则：
 *  - 形状先区分（表格 / 大括号 / 尖括号 / 折角文档 / 图片框），颜色只做辅助
 *  - 统一 24 视窗、stroke 1.7、currentColor，跟随主题
 *  - 不引图标库：一共十来个，内联比依赖便宜
 */

export type FileKind = 'dir' | 'dirOpen' | 'md' | 'csv' | 'json' | 'code' | 'txt' | 'image' | 'config' | 'unknown'

const KIND_CLASS: Record<FileKind, string> = {
  dir: 'fi-dir',
  dirOpen: 'fi-dir',
  md: 'fi-md',
  csv: 'fi-csv',
  json: 'fi-json',
  code: 'fi-code',
  txt: 'fi-txt',
  image: 'fi-image',
  config: 'fi-config',
  unknown: 'fi-txt',
}

const PATHS: Record<FileKind, string> = {
  dir: '<path d="M3.5 7.5h6l1.6 2h9.4v8.5H3.5z"/><path d="M3.5 7.5V5h6l1.6 2.5"/>',
  // 打开状态：前面那层稍微前倾，像掀开的盖子
  // 打开：背板 + 前盖（前盖向下斜），和关闭态一眼能分开
  dirOpen:
    '<path d="M3.5 17.5V6h5.2l1.6 2.5h9.4v8.5H3.5z"/><path d="M5.8 17.5l2-6.8h12.7l-2.2 6.8H5.8z"/>',
  md: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/><path d="M9 16.5v-4l1.6 2 1.6-2v4"/>',
  csv: '<path d="M3.5 5.5h17v13h-17z"/><path d="M3.5 10h17M3.5 14.5h17M9.5 5.5v13M15 5.5v13"/>',
  json: '<path d="M9.5 4.5c-2 0-2.5 1-2.5 3v2c0 1.4-.8 2-2 2 1.2 0 2 .6 2 2v2c0 2 .5 3 2.5 3"/><path d="M14.5 4.5c2 0 2.5 1 2.5 3v2c0 1.4.8 2 2 2-1.2 0-2 .6-2 2v2c0 2-.5 3-2.5 3"/>',
  code: '<path d="M9 8.5 4.5 12 9 15.5"/><path d="M15 8.5 19.5 12 15 15.5"/><path d="M13 6l-2 12"/>',
  txt: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/><path d="M9 12.5h6M9 16h4.5"/>',
  image: '<path d="M3.5 5.5h17v13h-17z"/><path d="M6.5 15.5l3.5-4 2.5 2.8 2.5-3 3 4.2"/><circle cx="8.5" cy="9" r="1.2"/>',
  config: '<path d="M3.5 8.5h8M15 8.5h5.5M3.5 15.5h5M12 15.5h8.5"/><circle cx="13" cy="8.5" r="2"/><circle cx="9.5" cy="15.5" r="2"/>',
  unknown: '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/>',
}

export function fileKindOf(name: string, isDir = false, open = false): FileKind {
  if (isDir) return open ? 'dirOpen' : 'dir'
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (name.toLowerCase().endsWith('.d.ts')) return 'code'
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'md'
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return 'csv'
  if (['json', 'jsonc', 'json5'].includes(ext)) return 'json'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'sh', 'ps1', 'bat', 'sql', 'go', 'rs', 'java', 'c', 'cpp', 'h'].includes(ext)) {
    return 'code'
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image'
  if (['yml', 'yaml', 'toml', 'ini', 'conf', 'env'].includes(ext)) return 'config'
  if (['txt', 'log', 'text', 'lock'].includes(ext)) return 'txt'
  return 'unknown'
}

/** 生成 <svg> 标记（用 innerHTML 插进去） */
export function fileIconSvg(name: string, isDir = false, size = 14, open = false): string {
  const kind = fileKindOf(name, isDir, open)
  return `<svg class="fi ${KIND_CLASS[kind]}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[kind]}</svg>`
}

/** 生成一个包好图标的 span（给 DOM append 用） */
export function fileIconEl(name: string, isDir = false, size = 14, open = false): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'fi-wrap'
  span.innerHTML = fileIconSvg(name, isDir, size, open)
  return span
}
