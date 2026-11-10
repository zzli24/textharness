/**
 * 给模型看的工具清单（schema）。
 *
 * 从 tools.ts 拆出来：这里是「描述」，tools.ts 里是「实现」，
 * 加工具时只改这两处之一，不用在 1200 行的文件里翻。
 */

export const TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: '列出工作区某个目录下的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的目录路径；留空表示工作区根目录' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_new_file',
      description:
        '在工作区里"新建"一个文件。如果目标已存在会直接失败——用于定时任务等只允许新增、不允许改写既有内容的场景。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的新文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_patch',
      description:
        '精确修改已有文件里的某一段内容：把 old_text 替换成 new_text。比 write_file 更安全更省 token——只发改动部分，不用重抄整篇。old_text 必须在文件里唯一命中（不唯一就多带几行上下文）；确实要改多处时传 replace_all=true。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          old_text: { type: 'string', description: '要被替换的原文（尽量带上几行上下文，保证唯一）' },
          new_text: { type: 'string', description: '替换后的内容；传空字符串表示删除这段' },
          replace_all: { type: 'boolean', description: 'old_text 出现多次时是否全部替换，默认 false' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: '读取工作区内一个文本文件的内容，返回带行号的文本。文件较大时会分段返回，末尾会提示下一次该用哪个 offset 继续读；需要完整内容时请继续调用直到没有提示。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          offset: { type: 'number', description: '从第几行开始读（1 起），默认 1' },
          limit: { type: 'number', description: '最多读多少行，默认 2000（还会按字符数自动分段）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        '把内容写入工作区内的文件（不存在则创建，存在则覆盖）。覆盖前会自动备份到 .history。适合写笔记、脚本、SQL。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'replace_in_file',
      description:
        '按正则批量替换单个文件里的文本，一次调用改完所有命中。落盘前会把命中的前后对比给你看（工作区外的文件会先要写权限）。适合"把所有 X 改成 Y"这类规则化改动，比 apply_patch 一条条改省步数。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（工作区外用绝对路径）' },
          pattern: { type: 'string', description: '要匹配的正则表达式' },
          replacement: { type: 'string', description: '替换成什么；可用 $1 $2 引用分组，删掉命中就传空串' },
          ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
        },
        required: ['path', 'pattern', 'replacement'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_script',
      description:
        '写一段 Node.js 脚本交给本机执行，适合处理大文件（整库 dump、日志、CSV）：统计、提取、批量改写、生成新文件。脚本通过 stdout 输出结果，运行时需要用户点一次确认。做批量文本处理时比反复调用 read_file 更省上下文。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              '完整的 Node.js 脚本。require() 和 import 写法都支持（按出现的语法自动选择）。cwd 是工作区根目录，读写工作区外文件请用绝对路径。结果用 console.log 输出，尽量只打印摘要。',
          },
          timeout_ms: { type: 'number', description: '超时毫秒数，默认 20000，最大 120000' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_images',
      description:
        '列出工作区里的图片（png/jpg/webp/gif/bmp），返回相对路径和大小。用户说"用我那张图当背景"时先用它找图，再用 set_appearance 的 bgImage 应用。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '限定目录（相对工作区），默认扫描整个工作区' },
          limit: { type: 'number', description: '最多返回多少张，默认 40' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'app_state',
      description:
        '读取编辑器当前状态：打开了哪些标签（标题/路径/是否未保存/哪个是当前）、光标位置、选中内容、主题与背景设置、工作区路径、是否分栏。用户问"我开了几个页面/这个文件改过没/我的背景是什么"时先用它。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_appearance',
      description:
        '修改编辑器外观：主题（dark/light）、背景预设、不透明度、模糊、暗化。用户说"换成深色""背景太亮了"时直接调用，不要只给步骤。',
      parameters: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['dark', 'light'], description: '主题' },
          bgPreset: { type: 'number', description: '背景预设：0=无，1=深夜蓝，2=暮色紫，3=晨曦橙，4=森林青，5=石墨灰' },
          bgOpacity: { type: 'number', description: '背景不透明度 0.05~0.9' },
          bgBlur: { type: 'number', description: '背景模糊 0~24 px' },
          bgDim: { type: 'number', description: '背景暗化 0~0.85' },
          bgImage: {
            type: 'string',
            description: '工作区内的图片路径（相对路径，如 .assets/img/2026-11-02/a.png）；传空串表示清除自定义背景',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'close_tabs',
      description:
        '关闭标签。scope: today=今天打开的、others=除当前之外、all=全部、match=按标题/路径匹配。未保存的标签默认跳过并在结果里报告；只有用户明确说"全部关掉/不保存也关"时才传 includeDirty=true。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['today', 'others', 'all', 'match'], description: '关闭范围' },
          pattern: { type: 'string', description: 'scope=match 时用，按标题或路径包含匹配' },
          includeDirty: { type: 'boolean', description: '是否连未保存的一起关，默认 false' },
        },
        required: ['scope'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_settings',
      description:
        '打开设置面板并定位到某个分页，引导用户自己填（模型/Key 这类敏感项不要替用户填）。分页：workspace / editor / look / model / agents / tasks / tools / update / about。',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: '分页 id' },
        },
        required: ['section'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remember',
      description:
        '写记忆，分三档：fact=一两句长期事实（上限 200 字，进每轮上下文）；log=一次会话的结论（上限 800 字，只注入最近几条）；template=多字段模板/表单/清单/长格式（落到 记忆/模板/，不进上下文，用时再读）。判断口诀：每轮都用得上→fact；只在特定任务用→template；一次性结论→log。不要把模板、字段清单、整段配置塞进 fact。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              '要记的内容。fact 必须是一句话（≤200 字）；template 可以多行，第一行当标题',
          },
          kind: {
            type: 'string',
            enum: ['fact', 'log', 'template'],
            description: 'fact=长期事实，log=会话日志，template=模板/清单',
          },
        },
        required: ['text', 'kind'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recall',
      description: '在 记忆/ 目录里找以前记下的内容（偏好、历史结论）。回答"我之前说过什么/上次怎么定的"时先查这里。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，空格分隔' },
          limit: { type: 'number', description: '最多返回几条，默认 10' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_archive',
      description:
        '提议把一段内容归档（不会直接写盘）。调用后界面会打开归档面板并预填内容，用户点「写入」才真正保存。target=knowledge 存知识库（结构化资料），target=memory 存记忆（长期偏好/结论/模板）。用户说"这段值得留档/存起来"或你觉得内容值得复用时用。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['knowledge', 'memory'], description: '存哪里' },
          title: { type: 'string', description: '标题（也会当文件名）' },
          content: { type: 'string', description: '要归档的正文，保留 markdown' },
          category: { type: 'string', description: '知识库分类（如 MySQL），留空则用户选' },
          memoryKind: {
            type: 'string',
            enum: ['fact', 'log', 'template'],
            description: 'target=memory 时：长期事实/会话结论/模板',
          },
        },
        required: ['target', 'title', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_mcp_server',
      description:
        '用户贴了一段 MCP 服务器 JSON（Claude Desktop 的 mcpServers 格式）时，解析并打开「添加服务器」确认框；用户点「添加并连接」后才写入配置。不要直接改配置文件。',
      parameters: {
        type: 'object',
        properties: {
          json: { type: 'string', description: '用户贴的原始 JSON（可以是 {mcpServers:{...}} 或直接的 {name:{...}}）' },
        },
        required: ['json'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'clear_history',
      description:
        '清理历史会话记录（不可恢复，会先弹原生确认框）。scope: older=删除 N 天前的、all=全部删除。用户说"把之前的对话记录清掉"时用。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['older', 'all'], description: '清理范围' },
          days: { type: 'number', description: 'scope=older 时保留最近多少天，默认 30' },
        },
        required: ['scope'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'switch_tab',
      description: '切换到一个已打开的标签，按标题或路径包含匹配。',
      parameters: {
        type: 'object',
        properties: { match: { type: 'string', description: '标题或路径的一部分' } },
        required: ['match'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'transform_selection',
      description:
        '对用户当前选中的文本执行一段 JavaScript 变换，出 diff 给用户确认后替换选区（可用 Ctrl+Z 撤销）。code 里用 text 变量拿到原文，必须 return 新字符串。适合大小写、去重、排序、加序号、按列截取、编码转换这类确定性变换。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              '函数体，例如 return text.toUpperCase() 或 text.split("\\n").filter((l, i, a) => a.indexOf(l) === i).join("\\n")。可用 text 变量，必须 return 一个字符串。',
          },
          note: { type: 'string', description: '一句话说明这次变换做了什么，会显示在确认框里' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'text_stats',
      description:
        '统计一段文本或一个文件的基本信息：行数、非空行、词数、字符数、中文字数、去重后行数、最长行长度。适合回答"这个文件多大/有多少行/有没有重复"。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径；留空则统计当前选中的文本',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'count_in_file',
      description:
        '在单个文件里统计：总行数、匹配某个正则的行数与次数，并可返回前若干条命中行。适合大文件（整库 dump、日志）里数 CREATE TABLE 之类，不用把全文读进上下文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（工作区外会弹窗申请权限）' },
          pattern: { type: 'string', description: '正则表达式；留空则只统计总行数/大小' },
          ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 true' },
          sample: { type: 'number', description: '返回前几条命中行，默认 20，最大 300' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: '在工作区里按正则搜索文本，返回命中的文件、行号和内容片段。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '限定搜索的子目录，留空表示整个工作区' },
          max_results: { type: 'number', description: '最多返回多少条，默认 40' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_in_editor',
      description: '把工作区里的一个文件在编辑器里打开（用户可见）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'feishu_fetch_doc',
      description:
        '从飞书云文档拉取内容（Markdown），保存到工作区「飞书/」目录。需要先在 设置 → 集成 里登录飞书。',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: '飞书文档 URL 或 token' },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'feishu_push_doc',
      description:
        '把工作区里的 Markdown 整篇覆盖回写飞书文档。会丢失评论/图片等富内容，执行前会请求用户确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的 Markdown 文件路径' },
          doc: { type: 'string', description: '飞书文档 URL 或 token；省略时用上次拉取的映射' },
        },
        required: ['path'],
      },
    },
  },  {
    type: 'function' as const,
    function: {
      name: 'feishu_search_docs',
      description:
        '搜索飞书云文档/知识库/表格，返回标题、类型和可用于拉取的 URL/token。需要先登录飞书集成。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（标题或正文，最多 30 个字符）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'feishu_fetch_docs',
      description:
        '批量把飞书文档拉到工作区「飞书/」目录。可以传 docs（URL/token 数组），也可以传 query 自动搜索后拉取前 N 篇。',
      parameters: {
        type: 'object',
        properties: {
          docs: { type: 'array', items: { type: 'string' }, description: '飞书文档 URL 或 token 列表' },
          query: { type: 'string', description: '搜索关键词；不传 docs 时使用' },
          limit: { type: 'number', description: '搜索后最多拉取几篇，默认 5' },
        },
      },
    },
  },

]

export type ToolDef = (typeof TOOL_DEFS)[number]
