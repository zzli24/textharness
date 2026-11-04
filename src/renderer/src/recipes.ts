/**
 * 零延迟文本配方。
 *
 * 这些不经过模型：点一下立刻出结果，走 CodeMirror 事务，能 Ctrl+Z 撤销。
 * 需要「想一想」的需求才交给 agent。
 */

export interface Recipe {
  id: string
  label: string
  group: string
  keywords: string[]
  /** 变换函数：输入原文，返回新文本 */
  apply: (text: string) => string
}

const lines = (text: string): string[] => text.split('\n')
const join = (list: string[]): string => list.join('\n')

/** 全角字符转半角（ASCII 区段） */
function toHalfWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/** 半角转全角（ASCII 区段） */
function toFullWidth(text: string): string {
  return text
    .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
    .replace(/ /g, '\u3000')
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}

export const RECIPES: Recipe[] = [
  /* ---------- 清理 ---------- */
  {
    id: 'trim-lines',
    label: '去首尾空白',
    group: '清理',
    keywords: ['trim', '空格', '缩进'],
    apply: (text) => join(lines(text).map((line) => line.trim())),
  },
  {
    id: 'drop-empty-lines',
    label: '去空行',
    group: '清理',
    keywords: ['空行', '空白行', 'blank'],
    apply: (text) => join(lines(text).filter((line) => line.trim())),
  },
  {
    id: 'dedupe-lines',
    label: '去重复行',
    group: '清理',
    keywords: ['去重', '重复', 'unique', 'distinct'],
    apply: (text) => join([...new Set(lines(text))]),
  },
  {
    id: 'strip-html',
    label: '去 HTML 标签',
    group: '清理',
    keywords: ['html', '标签', 'tag'],
    apply: (text) => text.replace(/<[^>]*>/g, ''),
  },
  {
    id: 'normalize-spaces',
    label: '合并多余空格',
    group: '清理',
    keywords: ['空格', '空白', 'space'],
    apply: (text) => text.replace(/[ \t]{2,}/g, ' '),
  },

  /* ---------- 变换 ---------- */
  {
    id: 'to-upper',
    label: '转大写',
    group: '变换',
    keywords: ['upper', '大写'],
    apply: (text) => text.toUpperCase(),
  },
  {
    id: 'to-lower',
    label: '转小写',
    group: '变换',
    keywords: ['lower', '小写'],
    apply: (text) => text.toLowerCase(),
  },
  {
    id: 'to-half-width',
    label: '全角转半角',
    group: '变换',
    keywords: ['全角', '半角', 'width'],
    apply: toHalfWidth,
  },
  {
    id: 'to-full-width',
    label: '半角转全角',
    group: '变换',
    keywords: ['全角', '半角', 'width'],
    apply: toFullWidth,
  },
  {
    id: 'html-escape',
    label: 'HTML 转义',
    group: '变换',
    keywords: ['escape', 'html'],
    apply: (text) =>
      text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch),
  },
  {
    id: 'html-unescape',
    label: 'HTML 反转义',
    group: '变换',
    keywords: ['unescape', 'html'],
    apply: (text) =>
      text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&'),
  },
  {
    id: 'unicode-escape',
    label: 'Unicode 转义',
    group: '变换',
    keywords: ['unicode', '转义'],
    apply: (text) => text.replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`),
  },

  /* ---------- 行操作 ---------- */
  {
    id: 'number-lines',
    label: '加行号',
    group: '行操作',
    keywords: ['序号', '编号', 'number'],
    apply: (text) => join(lines(text).map((line, index) => `${index + 1}. ${line}`)),
  },
  {
    id: 'strip-numbering',
    label: '去行号',
    group: '行操作',
    keywords: ['序号', '编号', 'number'],
    apply: (text) => join(lines(text).map((line) => line.replace(/^\s*\d+[.、)]\s*/, ''))),
  },
  {
    id: 'sort-lines',
    label: '按字母排序',
    group: '行操作',
    keywords: ['排序', 'sort', '升序'],
    apply: (text) => join([...lines(text)].sort(naturalCompare)),
  },
  {
    id: 'sort-lines-desc',
    label: '按字母倒序',
    group: '行操作',
    keywords: ['排序', 'sort', '降序'],
    apply: (text) => join([...lines(text)].sort((a, b) => naturalCompare(b, a))),
  },
  {
    id: 'sort-by-length',
    label: '按长度排序',
    group: '行操作',
    keywords: ['排序', '长度'],
    apply: (text) => join([...lines(text)].sort((a, b) => a.length - b.length)),
  },
  {
    id: 'shuffle-lines',
    label: '随机打乱行',
    group: '行操作',
    keywords: ['随机', 'shuffle', '打乱'],
    apply: (text) => {
      const list = lines(text)
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[list[i], list[j]] = [list[j], list[i]]
      }
      return join(list)
    },
  },
  {
    id: 'lines-to-columns',
    label: '行转列（逗号）',
    group: '行操作',
    keywords: ['行转列', 'join', '逗号'],
    apply: (text) => lines(text).map((line) => line.trim()).filter(Boolean).join(', '),
  },
  {
    id: 'columns-to-lines',
    label: '列转行（按逗号）',
    group: '行操作',
    keywords: ['列转行', 'split', '逗号'],
    apply: (text) => text.split(/[,，]\s*/).join('\n'),
  },

  /* ---------- 编码 ---------- */
  {
    id: 'base64-encode',
    label: 'Base64 编码',
    group: '编码',
    keywords: ['base64', '编码'],
    apply: (text) => {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary)
    },
  },
  {
    id: 'base64-decode',
    label: 'Base64 解码',
    group: '编码',
    keywords: ['base64', '解码'],
    apply: (text) => {
      const binary = atob(text.replace(/\s+/g, ''))
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    },
  },
  {
    id: 'url-encode',
    label: 'URL 编码',
    group: '编码',
    keywords: ['url', 'encode'],
    apply: (text) => encodeURIComponent(text),
  },
  {
    id: 'url-decode',
    label: 'URL 解码',
    group: '编码',
    keywords: ['url', 'decode'],
    apply: (text) => decodeURIComponent(text),
  },
  {
    id: 'json-minify',
    label: 'JSON 压缩',
    group: '编码',
    keywords: ['json', '压缩', 'minify'],
    apply: (text) => JSON.stringify(JSON.parse(text)),
  },
  {
    id: 'json-pretty',
    label: 'JSON 格式化',
    group: '编码',
    keywords: ['json', '格式化', 'pretty'],
    apply: (text) => JSON.stringify(JSON.parse(text), null, 2),
  },

  /* ---------- 提取 ---------- */
  {
    id: 'extract-emails',
    label: '提取邮箱',
    group: '提取',
    keywords: ['email', '邮箱'],
    apply: (text) => (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).join('\n'),
  },
  {
    id: 'extract-urls',
    label: '提取链接',
    group: '提取',
    keywords: ['url', '链接'],
    apply: (text) => (text.match(/https?:\/\/[^\s"'<>]+/g) ?? []).join('\n'),
  },
  {
    id: 'extract-ips',
    label: '提取 IP',
    group: '提取',
    keywords: ['ip', '地址'],
    apply: (text) =>
      (text.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g) ?? []).join('\n'),
  },
  {
    id: 'extract-numbers',
    label: '提取数字',
    group: '提取',
    keywords: ['数字', 'number'],
    apply: (text) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).join('\n'),
  },
  {
    id: 'sum-numbers',
    label: '数值求和',
    group: '提取',
    keywords: ['求和', 'sum', '合计'],
    apply: (text) => {
      const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      const total = numbers.reduce((sum, value) => sum + value, 0)
      return String(Math.round(total * 1e6) / 1e6)
    },
  },
]

export const RECIPE_GROUPS = [...new Set(RECIPES.map((recipe) => recipe.group))]

/** 提取类配方的结果拼接方式 */
export type ExtractJoin = 'newline' | 'comma'

/**
 * 把「每行一个」的提取结果重新拼：
 *  - newline：保持每行一个（默认，方便去重/排序/丢进 SQL IN）
 *  - comma：一行逗号分隔（方便贴进 JSON、配置、邮件收件人）
 * 两种情况都会去重。
 */
export function joinExtractResult(raw: string, mode: ExtractJoin): { text: string; count: number; unique: number } {
  const items = raw.split('\n').map((line) => line.trim()).filter(Boolean)
  const uniqueItems = [...new Set(items)]
  const text = mode === 'comma' ? uniqueItems.join(', ') : uniqueItems.join('\n')
  return { text, count: items.length, unique: uniqueItems.length }
}

export function findRecipe(id: string): Recipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id)
}

/** 统计一次变换前后的行变化，用于 toast 提示 */
export function describeChange(before: string, after: string): string {
  if (before === after) return '内容没有变化'
  const beforeLines = before.split('\n').length
  const afterLines = after.split('\n').length
  const linePart = beforeLines === afterLines ? `${afterLines} 行` : `${beforeLines} → ${afterLines} 行`
  return `${linePart}，${before.length} → ${after.length} 字符`
}
