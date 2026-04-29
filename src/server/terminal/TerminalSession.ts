import * as pty from 'node-pty'
import iconv from 'iconv-lite'
import { Terminal } from '@xterm/headless'
import { debounce, throttle } from 'lodash'
import stripAnsi from 'strip-ansi'

import * as fs from 'fs'
import * as path from 'path'

export type SessionStatus = 'idle' | 'running'

export type OutputCallback = (sessionId: string, data: string) => void
export type StatusCallback = (sessionId: string, status: SessionStatus) => void

export const START_SIGNAL = '__start__'

export class TerminalSession {
  readonly id: string
  private pty: pty.IPty | null = null
  private headlessTerminal: Terminal
  private _status: SessionStatus = 'idle'
  private readonly cwd: string
  private _lastOutputTime: number = 0
  private _timedOut: boolean = false

  private outputCallback: OutputCallback | null = null
  private statusCallback: StatusCallback | null = null

  private logFilePath: string
  private rowCount: number = 50
  private scrollbackCount: number = 50000
  private colCount: number = 80
  private logScreen: string = ''
  private logStream: fs.WriteStream | null = null

  constructor(id: string, cwd: string = '', callback?: OutputCallback) {
    this.id = id
    this.cwd = cwd || process.cwd()

    if (callback) {
      this.outputCallback = callback
    }

    // 创建日志文件
    this.logFilePath = //'test-term.log'
      path.join(
        process.env.WORKSPACE || process.cwd(),
        'terminal',
        `terminal-${id}-${Date.now()}.log`,
      )
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true })
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'w' })

    // 初始化无头终端
    this.headlessTerminal = new Terminal({
      cols: this.colCount,
      rows: this.rowCount,
      scrollback: this.scrollbackCount,
      convertEol: false,
      allowProposedApi: true,
    })

    const bufferLines: string[] = []

    const cwdStr = new RegExp(`${path.resolve(this.cwd)}`, 'ig')
    // 日志产生了变化，更新缓冲区
    this.headlessTerminal.onWriteParsed(() => {
      const activeBuffer = this.headlessTerminal.buffer.active
      const startPos = 0 //activeBuffer.viewportY
      const totalRows = activeBuffer.length //startPos + this.headlessTerminal.rows
      for (let currentLine = startPos; currentLine < totalRows; currentLine++) {
        const line = activeBuffer.getLine(currentLine)
        const lineStr = line?.translateToString(true) || ''

        if (bufferLines.length < currentLine) {
          bufferLines.length = currentLine
        }
        bufferLines[currentLine] = stripAnsi(lineStr)
      }
      this.logScreen = bufferLines.join('\n')
    })
  }

  getScreenLine(screen: string) {
    return screen
      .split('\n')
      .filter((f) => f.trim() !== '')
      .map((f, idx) => `${idx + 1}| ${f}`)
  }

  sessionSnapshot: string[] = []
  getLogScreen(): string | undefined {
    this.sessionSnapshot = this.getScreenLine(this.logScreen)
    return this.sessionSnapshot.join('\n')
  }

  getDiffLogScreen(): string | undefined {
    const diff = this.getScreenLine(this.logScreen)
      .filter((f, idx, arr) => {
        // 如过最后10行，原样返回
        if (idx >= arr.length - 10) {
          return true
        }
        return this.sessionSnapshot[idx] !== f
      })
      .join('\n')
    this.sessionSnapshot = this.getScreenLine(this.logScreen)
    return diff
  }

  public initPty(shell: string): Promise<number> {
    if (this.pty) {
      try {
        this.pty.kill()
      } catch {
        // 忽略销毁失败
      } finally {
        this.pty = null
      }
    }

    this.pty = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: this.colCount,
      rows: this.rowCount,
      cwd: this.cwd,
      env: process.env as { [key: string]: string },
    })

    let init = false

    const p: Promise<number> = new Promise((resolve) => {
      this.pty?.onData((text: string) => {
        this._lastOutputTime = Date.now()

        // let text = iconv.decode(Buffer.from(data), 'utf-8')
        if (!init) {
          const lineArr = text.split('\n')
          const line = lineArr.findIndex((f) => f.trim().startsWith(START_SIGNAL))
          if (line !== -1) {
            init = true
            resolve(1)
            if (line === lineArr.length - 1) {
              return
            }
            text = lineArr.slice(line + 1).join('\n')
          } else {
            return
          }
        }

        this.logStream?.write(text)
        this.headlessTerminal.write(text)

        if (this.outputCallback) {
          this.outputCallback(this.id, text)
        }
      })
    })

    // 开始执行了
    this.pty.write(`echo ${START_SIGNAL}\r\n`)
    return p
  }

  getFullOutput() {
    return fs.readFileSync(this.logFilePath, 'utf-8')
  }

  get status(): SessionStatus {
    return this._status
  }

  get currentWorkingDirectory(): string {
    return this.cwd
  }

  setOutputCallback(callback: OutputCallback | null): void {
    this.outputCallback = callback
  }

  setStatusCallback(callback: StatusCallback | null): void {
    this.statusCallback = callback
  }

  private notifyStatusChange(): void {
    if (this.statusCallback) {
      this.statusCallback(this.id, this._status)
    }
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  /**
   * 获取日志文件路径
   */
  getLogFilePath(): string {
    return this.logFilePath
  }

  exec(command: string) {
    this.notifyStatusChange()
    this._lastOutputTime = Date.now()
    this.write(command + '\r')
  }

  private doInterrupt(): void {
    this._status = 'idle'
    this.notifyStatusChange()
    if (this.pty) {
      try {
        this.pty.write('\x03')
      } catch {
        // 忽略中断失败
      }
    }
  }

  isTimedOut(): boolean {
    return this._timedOut
  }

  getLastOutputTime(): number {
    return this._lastOutputTime
  }

  /**
   * 检查输出是否已稳定（N 秒无新输出）
   */
  isOutputStable(timeoutMs: number = 5000): boolean {
    return Date.now() - this._lastOutputTime >= timeoutMs
  }

  writeInput(data: string): void {
    this.write(data)
  }

  interrupt(): void {
    this.doInterrupt()
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows)
  }

  destroy(): void {
    // 销毁无头终端
    this.logStream?.end()
    this.logStream = null
    this.headlessTerminal.dispose()

    if (this.pty) {
      try {
        this.pty.kill()
      } catch {
        // 忽略销毁失败
      } finally {
        this.pty = null
      }
    }
    this._status = 'idle'
  }
}
