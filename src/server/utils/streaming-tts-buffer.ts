import { splitTextWithTags } from './index'
import type { TTSCommand } from '../core/nodes/llm-structured'
import { CHARACTER_STATES } from '../core/dict/face_and_act'
import type { StateInTTS } from '../core/nodes/llm-structured'

/**
 * 流式TTS缓冲区
 * 按段落累积内容，识别代码块/表格边界，适时生成TTS命令
 */
export class StreamingTTSBuffer {
  private lineBuffer = ''
  private paragraphBuffer = ''
  private state: 'normal' | 'code_block' | 'table' | 'think' = 'normal'
  private codeBlockMarker = ''

  /**
   * 追加内容到缓冲区
   * @param chunk - 新的内容片段
   * @returns TTS命令数组，如果没有可发送的内容则返回空数组
   */
  append(chunk: string): TTSCommand[] {
    this.lineBuffer += chunk
    const commands: TTSCommand[] = []

    // 按行处理
    while (true) {
      const newlineIndex = this.lineBuffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = this.lineBuffer.slice(0, newlineIndex)
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1)

      const result = this.processLine(line)
      if (result.length > 0) {
        commands.push(...result)
      }
    }

    return commands
  }

  /**
   * 处理单行内容
   */
  private processLine(line: string): TTSCommand[] {
    const trimmed = line.trim()

    // think 标签处理 - 遇到 </think> 结束
    if (this.state === 'think') {
      if (trimmed.includes('</think>')) {
        this.state = 'normal'
      }
      return []
    }

    // 代码块处理
    if (this.state === 'code_block') {
      if (trimmed.startsWith(this.codeBlockMarker)) {
        this.state = 'normal'
      }
      return []
    }

    // 表格处理
    if (this.state === 'table') {
      if (!trimmed.startsWith('|')) {
        this.state = 'normal'
        // 表格结束，继续处理当前行
      } else {
        return []
      }
    }

    // 检查是否进入 think 标签
    if (trimmed.startsWith('<think')) {
      this.state = 'think'
      // 如果这行也包含结束标签，立即恢复正常
      if (trimmed.includes('</think>')) {
        this.state = 'normal'
      }
      return []
    }

    // 检查是否进入代码块
    if (trimmed.startsWith('```')) {
      this.codeBlockMarker = '```'
      this.state = 'code_block'
      // 先处理之前累积的段落
      const result = this.flushParagraph()
      return result
    }

    if (trimmed.startsWith('~~~')) {
      this.codeBlockMarker = '~~~'
      this.state = 'code_block'
      const result = this.flushParagraph()
      return result
    }

    // 检查是否进入表格
    if (trimmed.startsWith('|') && trimmed.includes('|', 1)) {
      this.state = 'table'
      const result = this.flushParagraph()
      return result
    }

    // 空行表示段落结束
    if (trimmed === '') {
      return this.flushParagraph()
    }

    // 标题行也触发段落发送
    if (/^#{1,6}\s/.test(trimmed)) {
      const result = this.flushParagraph()
      this.paragraphBuffer = line + '\n'
      return result
    }

    // 累积到段落缓冲区
    this.paragraphBuffer += line + '\n'
    return []
  }

  /**
   * 刷新当前段落，生成TTS命令
   */
  private flushParagraph(): TTSCommand[] {
    if (!this.paragraphBuffer.trim()) {
      return []
    }

    const content = this.paragraphBuffer.trim()
    this.paragraphBuffer = ''

    // 使用 splitTextWithTags 处理段落
    const segments = splitTextWithTags(content)

    return segments.map((seg) => {
      const tags = seg.tag
        .map((tag) => {
          let [action, intensity] = tag.split('-')
          action = action.trim()
          intensity = intensity?.trim() || '1'
          if (CHARACTER_STATES[action]) {
            return {
              id: action,
              stateType: CHARACTER_STATES[action].type,
              intensity: parseInt(intensity, 10),
            } as StateInTTS
          }
          return null
        })
        .filter((item): item is StateInTTS => item != null)

      return {
        type: 'tts' as const,
        text: seg.text,
        speed: 'stand' as const,
        state: tags,
        pauseAfter: seg.pauseAfter,
      }
    })
  }

  /**
   * 结束流式处理，返回剩余内容
   */
  finalize(): TTSCommand[] {
    // 处理剩余的行缓冲
    if (this.lineBuffer) {
      this.processLine(this.lineBuffer)
      this.lineBuffer = ''
    }

    // 刷新最后一段
    const result = this.flushParagraph()

    // 重置状态
    this.state = 'normal'
    this.codeBlockMarker = ''

    return result
  }

  /**
   * 重置缓冲区状态
   */
  reset(): void {
    this.lineBuffer = ''
    this.paragraphBuffer = ''
    this.state = 'normal'
    this.codeBlockMarker = ''
  }
}
