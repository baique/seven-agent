/**
 * 编码检测和转换工具类
 * 提供Buffer编码检测和转换功能
 */

/**
 * 检测Buffer编码并解码为字符串
 * 自动检测UTF-8、CP936(GBK)等编码
 * 主要用于Windows平台下的命令行输出解码
 * @param buffer 待解码的Buffer
 * @returns 解码后的字符串
 */
export function detectAndDecode(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) {
    return ''
  }

  if (process.platform === 'win32') {
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return buffer.toString('utf-8')
    }

    const utf8Str = buffer.toString('utf-8')
    if (!utf8Str.includes('\uFFFD')) {
      return utf8Str
    }

    try {
      //@ts-ignore
      return buffer.toString('cp936')
    } catch {}
  }

  return buffer.toString('utf-8')
}
