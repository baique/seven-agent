/**
 * 内容累加器
 * 用于工具实现方控制内容长度，避免超出限制
 * 精确控制字符数，确保游标位置准确
 */

import { env } from '../config/env'

/**
 * 内容累加器
 * 支持追加字符并检查是否超出限制
 * 按字符精确累加，不超标的全部追加，超标的按字符截断
 */
export class ContentAccumulator {
  private content: string = ''
  private charCount: number = 0
  private lineCount: number = 0
  private readonly maxChars: number
  private readonly maxLines: number
  private exceeded: boolean = false

  constructor(maxChars?: number, maxLines?: number) {
    this.maxChars = maxChars ?? env.FILE_READ_MAX_CHARS
    this.maxLines = maxLines ?? env.FILE_READ_MAX_LINES
  }

  /**
   * 计算追加后的行数
   * 如果当前内容为空，直接计算文本行数
   * 如果当前内容不为空，计算追加后的总行数
   */
  private calculateNewLines(text: string): number {
    if (this.content.length === 0) {
      // 空内容时，直接计算文本行数
      if (text.length === 0) return 0
      return text.split('\n').length
    }

    // 非空内容时，计算追加后的行数
    // 如果当前内容以换行符结尾，新文本的行数就是新增行数
    // 否则，新文本的第一行会合并到当前最后一行
    const textLines = text.split('\n').length

    if (this.content.endsWith('\n')) {
      // 当前内容以换行符结尾，新文本的行数全部新增
      return this.lineCount + textLines
    } else {
      // 当前内容不以换行符结尾，新文本的第一行合并到当前行
      return this.lineCount + textLines - 1
    }
  }

  /**
   * 追加内容
   * 如果全部内容可以追加，则追加并返回 exceeded=false
   * 如果超出限制，则追加部分内容并返回 exceeded=true
   * 优先按字符截断，如果字符未超但行数超，也标记为超出
   * @param text 要追加的文本
   * @returns 是否超出限制
   */
  append(text: string): boolean {
    if (this.exceeded) {
      return true
    }

    const textLength = text.length

    // 检查是否会超出字符限制
    const charsExceeded = this.charCount + textLength > this.maxChars
    // 检查是否会超出行数限制
    const newLines = this.calculateNewLines(text)
    const linesExceeded = newLines > this.maxLines

    if (!charsExceeded && !linesExceeded) {
      // 未超出限制，全部追加
      this.content += text
      this.charCount += textLength
      this.lineCount = newLines
      return false
    }

    // 超出限制，需要截断
    this.exceeded = true

    if (charsExceeded) {
      // 按字符截断
      const remainingChars = this.maxChars - this.charCount
      if (remainingChars > 0) {
        const toAppend = text.substring(0, remainingChars)
        this.content += toAppend
        this.charCount += remainingChars
        // 重新计算行数
        this.lineCount = this.content.split('\n').length
      }
    } else if (linesExceeded) {
      // 行数超限但字符未超，追加全部内容（因为无法按行精确截断）
      this.content += text
      this.charCount += textLength
      this.lineCount = newLines
    }

    return true
  }

  /**
   * 获取当前内容
   */
  getText(): string {
    return this.content
  }

  /**
   * 获取当前字符数
   */
  getCharCount(): number {
    return this.charCount
  }

  /**
   * 获取当前行数
   */
  getLineCount(): number {
    return this.lineCount
  }

  /**
   * 是否已超出限制
   */
  isExceeded(): boolean {
    return this.exceeded
  }

  /**
   * 获取最大字符限制
   */
  getMaxChars(): number {
    return this.maxChars
  }

  /**
   * 获取最大行数限制
   */
  getMaxLines(): number {
    return this.maxLines
  }

  /**
   * 重置累加器
   */
  reset(): void {
    this.content = ''
    this.charCount = 0
    this.lineCount = 0
    this.exceeded = false
  }
}

/**
 * 创建内容累加器
 * @param maxChars 最大字符数（默认使用环境变量）
 * @param maxLines 最大行数（默认使用环境变量）
 * @returns 内容累加器实例
 */
export function createContentAccumulator(maxChars?: number, maxLines?: number): ContentAccumulator {
  return new ContentAccumulator(maxChars, maxLines)
}
