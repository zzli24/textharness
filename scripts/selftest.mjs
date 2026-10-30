// 直接跑 TypeScript 源文件（Node 24 原生类型擦除），验证编码与图库这两块最容易出事故的逻辑。
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import iconv from 'iconv-lite'

import { decodeText, encodeText } from '../src/main/services/encoding.ts'
import { savePastedImage, dayStamp } from '../src/main/services/assets.ts'

let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}

console.log('\n== 编码往返 ==')

{
  const buf = Buffer.from('中文 abc 123', 'utf8')
  const d = decodeText(buf)
  check('UTF-8 识别', d.encoding === 'utf8' && !d.bom, d.encoding)
  check('UTF-8 内容', d.text === '中文 abc 123', JSON.stringify(d.text))
  const e = encodeText(d.text, { encoding: d.encoding, bom: d.bom, eol: d.eol })
  check('UTF-8 往返一致', e.buffer.equals(buf) && !e.lossy)
}

{
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  const buf = Buffer.concat([bom, Buffer.from('带 BOM 的中文', 'utf8')])
  const d = decodeText(buf)
  check('BOM 识别', d.bom === true && d.encoding === 'utf8')
  check('BOM 已剥离', d.text === '带 BOM 的中文', JSON.stringify(d.text))
  const e = encodeText(d.text, { encoding: d.encoding, bom: d.bom, eol: d.eol })
  check('BOM 往返一致', e.buffer.equals(buf))
}

{
  const buf = iconv.encode('这是 GBK 编码的中文', 'gbk')
  const d = decodeText(buf)
  check('GBK 识别', d.encoding === 'gb18030', d.encoding)
  check('GBK 中文不乱码', d.text === '这是 GBK 编码的中文', JSON.stringify(d.text))
  const e = encodeText(d.text, { encoding: d.encoding, bom: d.bom, eol: d.eol })
  check('GBK 往返字节一致', e.buffer.equals(buf))
  check('GBK 不误报丢字', e.lossy === false)
}

{
  const buf = iconv.encode('中文', 'gbk')
  const d = decodeText(buf)
  const e = encodeText(`${d.text} 😀`, { encoding: d.encoding, bom: false, eol: 'LF' })
  check('GBK 表示不了 emoji 时报警', e.lossy === true)
}

{
  const buf = iconv.encode('UTF-16 中文', 'utf16le')
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), buf])
  const d = decodeText(withBom)
  check('UTF-16LE 识别', d.encoding === 'utf16le' && d.bom === true, d.encoding)
  check('UTF-16LE 内容', d.text === 'UTF-16 中文', JSON.stringify(d.text))
}

console.log('\n== 换行符 ==')

{
  const buf = Buffer.from('a\r\nb\r\nc', 'utf8')
  const d = decodeText(buf)
  check('CRLF 识别', d.eol === 'CRLF', d.eol)
  check('内存里统一成 LF', d.text === 'a\nb\nc', JSON.stringify(d.text))
  const e = encodeText(d.text, { encoding: 'utf8', bom: false, eol: 'CRLF' })
  check('保存时还原 CRLF', e.buffer.toString('utf8') === 'a\r\nb\r\nc')
}

{
  const buf = Buffer.from('a\nb', 'utf8')
  const d = decodeText(buf)
  const e = encodeText(d.text, { encoding: 'utf8', bom: false, eol: 'LF' })
  check('LF 文件不被改写', e.buffer.toString('utf8') === 'a\nb')
}

console.log('\n== 图片入库路径 ==')

const root = join(process.cwd(), '.tmp', 'selftest-root')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

{
  const bytes = Buffer.from('fake-png-bytes')
  const rel = savePastedImage(root, '.assets', null, 'image/png', bytes)
  const expected = `../.assets/img/${dayStamp()}/`
  check('未命名文档用当日目录做基准', rel.startsWith(expected.replace(/\//g, '/')), rel)
  check('返回 POSIX 风格路径', !rel.includes('\\'), rel)

  const abs = join(root, dayStamp(), rel)
  check('落盘文件存在', readFileSync(abs).equals(bytes))

  const relAgain = savePastedImage(root, '.assets', null, 'image/png', bytes)
  check('相同内容同名去重', relAgain === rel, `${relAgain} vs ${rel}`)

  const docPath = join(root, dayStamp(), 'note.md')
  const rel2 = savePastedImage(root, '.assets', docPath, 'image/png', bytes)
  const abs2 = join(root, dayStamp(), rel2)
  check('文档存在时按文档目录计算', readFileSync(abs2).equals(bytes), rel2)
  check('相对路径可解析回原文件', relative(root, abs2).split(sep).join('/').endsWith('.png'))
}

rmSync(root, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
