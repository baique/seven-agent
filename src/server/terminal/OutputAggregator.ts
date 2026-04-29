import iconv from 'iconv-lite'

export interface OutputAggregatorOptions {
  maxBufferSize?: number
  flushInterval?: number
}

export class OutputAggregator {
  private buffer: string = ''
  private lastFlushTime: number = Date.now()
  private readonly maxBufferSize: number
  private readonly flushInterval: number

  constructor(options: OutputAggregatorOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 4096
    this.flushInterval = options.flushInterval ?? 2000
  }

  onData(chunk: Buffer | string, encoding: BufferEncoding = 'utf-8'): void {
    if (Buffer.isBuffer(chunk)) {
      this.buffer += iconv.decode(chunk, encoding)
    } else {
      this.buffer += chunk
    }
  }

  shouldFlush(): boolean {
    return (
      this.buffer.length >= this.maxBufferSize ||
      Date.now() - this.lastFlushTime >= this.flushInterval
    )
  }

  flush(): string {
    const output = this.buffer
    this.buffer = ''
    this.lastFlushTime = Date.now()
    return output
  }

  getBuffer(): string {
    return this.buffer
  }

  clear(): void {
    this.buffer = ''
    this.lastFlushTime = Date.now()
  }

  /**
   * 获取当前输出（不清除缓冲区）
   */
  getOutput(): string {
    return this.buffer
  }
}
