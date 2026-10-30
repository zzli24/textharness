import iconv from 'iconv-lite'
import type { Encoding, Eol, FileMeta } from '@shared/types'

/**
 * 内部编码标识 → iconv-lite 名称。
 *
 * 注意这里刻意分成"解码"和"编码"两套：
 *  - 解码用 gb18030：它是 Unicode 全集，任何字节都能解出来，不会抛错；
 *  - 编码用 gbk（CP936）：我们对外标注的是 GBK，必须写出真 GBK 字节。
 *    如果按 gb18030 编码，emoji 会变成 4 字节的 GB18030 序列，
 *    在只认 CP936 的老工具（多数 SQL 客户端、老的 Notepad++ 编码模式）里就是乱码。
 */
const ICONV_DECODE: Record<Encoding, string> = {
  utf8: 'utf8',
  gb18030: 'gb18030',
  utf16le: 'utf16le',
  utf16be: 'utf16-be',
}

const ICONV_ENCODE: Record<Encoding, string> = {
  utf8: 'utf8',
  gb18030: 'gbk',
  utf16le: 'utf16le',
  utf16be: 'utf16-be',
}

export const ENCODING_LABEL: Record<Encoding, string> = {
  utf8: 'UTF-8',
  gb18030: 'GBK',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

export interface Detected {
  encoding: Encoding
  bom: boolean
  body: Buffer
}

/**
 * 编码探测：BOM > 严格 UTF-8 校验 > GB18030 兜底。
 * 中文环境的现实是：不是合法 UTF-8 的 8 位文本，绝大多数是 GBK。
 */
export function detect(buf: Buffer): Detected {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8', bom: true, body: buf.subarray(3) }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', bom: true, body: buf.subarray(2) }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf16be', bom: true, body: buf.subarray(2) }
  }
  if (buf.length === 0 || isValidUtf8(buf)) {
    return { encoding: 'utf8', bom: false, body: buf }
  }
  return { encoding: 'gb18030', bom: false, body: buf }
}

export interface DecodedText {
  text: string
  encoding: Encoding
  bom: boolean
  eol: Eol
  /** 文件里同时存在 CRLF 和 LF */
  mixedEol: boolean
}

export function decodeText(buf: Buffer): DecodedText {
  const d = detect(buf)
  const raw = iconv.decode(d.body, ICONV_DECODE[d.encoding])
  const hasCrlf = raw.includes('\r\n')
  const hasLf = /(^|[^\r])\n/.test(raw)
  return {
    // 内存里统一用 \n，保存时再按 eol 转回去
    text: raw.replace(/\r\n/g, '\n'),
    encoding: d.encoding,
    bom: d.bom,
    eol: hasCrlf ? 'CRLF' : 'LF',
    mixedEol: hasCrlf && hasLf,
  }
}

export interface EncodeResult {
  buffer: Buffer
  /** 编码往返不一致 = 有字符表示不了 */
  lossy: boolean
}

export function encodeText(text: string, meta: FileMeta): EncodeResult {
  const out = meta.eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text
  const body = iconv.encode(out, ICONV_ENCODE[meta.encoding])
  const back = iconv.decode(body, ICONV_DECODE[meta.encoding])
  const bom = meta.bom ? bomBytes(meta.encoding) : Buffer.alloc(0)
  return { buffer: Buffer.concat([bom, body]), lossy: back !== out }
}

function bomBytes(enc: Encoding): Buffer {
  switch (enc) {
    case 'utf8':
      return Buffer.from([0xef, 0xbb, 0xbf])
    case 'utf16le':
      return Buffer.from([0xff, 0xfe])
    case 'utf16be':
      return Buffer.from([0xfe, 0xff])
    default:
      return Buffer.alloc(0)
  }
}
