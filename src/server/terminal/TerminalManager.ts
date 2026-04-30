import { readFileTool } from '../core/tools/filesystem'
import { readFileContent } from '../core/tools/filesystem/read-file'
import { logger } from '../utils'
import { TerminalSession, OutputCallback, StatusCallback, SessionStatus } from './TerminalSession'
import { validateCommand } from './commandSecurity'
import { getHybridServer } from '../socket'
import { SocketResponseType } from '../socket/types'

export interface CreateSessionResult {
  sessionId: string
}

export interface ExecResult {
  sessionId: string
  outputToFile: string
  currentContent?: string
}

export class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map()

  private sessionCounter: number = 0
  private defaultSessionId: string | null = null
  private defaultCwd: string = process.env.WORKSPACE || process.cwd()

  async createSession(sessionId: string, cwd?: string): Promise<CreateSessionResult> {
    if (this.sessions.has(sessionId)) {
      return { sessionId }
    }
    const sessionCwd = cwd || this.defaultCwd

    // 创建输出回调，广播终端输出到所有连接的客户端
    const outputCallback: OutputCallback = (sid: string, data: string) => {
      const server = getHybridServer()
      if (server) {
        server.broadcast({
          code: 200,
          message: '',
          type: SocketResponseType.TERMINAL_OUTPUT,
          data: { sessionId: sid, data },
          timestamp: Date.now(),
        })
      }
    }

    // 创建状态回调，广播终端状态变更到所有连接的客户端
    const statusCallback: StatusCallback = (sid: string, status: SessionStatus) => {
      const server = getHybridServer()
      if (server) {
        server.broadcast({
          code: 200,
          message: '',
          type: SocketResponseType.TERMINAL_STATUS_CHANGED,
          data: { sessionId: sid, status },
          timestamp: Date.now(),
        })
      }
    }

    const session = new TerminalSession(sessionId, sessionCwd, outputCallback)
    session.setStatusCallback(statusCallback)
    await session.initPty('cmd.exe')
    this.sessions.set(sessionId, session)
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId
    }

    // 广播会话创建事件
    const server = getHybridServer()
    if (server) {
      server.broadcast({
        code: 200,
        message: '',
        type: SocketResponseType.TERMINAL_SESSION_CREATED,
        data: { sessionId },
        timestamp: Date.now(),
      })
    }

    return { sessionId }
  }

  getDefaultSessionId(): string | null {
    return this.defaultSessionId
  }

  getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * 执行命令并自动等待输出稳定后读取日志
   * @param sessionId 会话 ID
   * @param command 要执行的命令
   * @param cwd 工作目录，默认使用工作空间
   * @param waitLog 是否等待日志稳定，默认收集10s的日志
   * @returns 包含会话 ID 和日志文件路径的对象
   */
  async exec(
    sessionId: string | undefined,
    command: string,
    cwd?: string,
    waitLog?: boolean,
  ): Promise<ExecResult> {
    const sid = sessionId || 'term-' + new Date().getTime()

    if (!sid) {
      throw new Error('No sessionId provided and no default session available')
    }
    validateCommand(command)

    let session = this.sessions.get(sid)
    if (!session) {
      const result = await this.createSession(sid, cwd)
      session = this.sessions.get(result.sessionId)!
    }

    // 执行命令
    session.exec(command)

    // 最大允许收集120秒的日志(异步也会收集10s)
    let maxCollectionLogTime = waitLog ? 120 * 1000 : 10 * 1000
    const scrollTimeGap = 2000
    do {
      await new Promise((resolve) => setTimeout(resolve, scrollTimeGap))
    } while (!session.isOutputStable(scrollTimeGap) && (maxCollectionLogTime -= scrollTimeGap) > 0)

    return {
      sessionId: sid,
      outputToFile: session.getLogFilePath(),
      currentContent: session.getLogScreen(),
    }
  }

  interrupt(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.interrupt()
    }
  }

  writeInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.writeInput(data)
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.resize(cols, rows)
    }
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.destroy()
      this.sessions.delete(sessionId)
    }
    if (this.defaultSessionId === sessionId) {
      this.defaultSessionId = this.sessions.keys().next().value || null
    }

    // 广播会话关闭事件
    const server = getHybridServer()
    if (server) {
      server.broadcast({
        code: 200,
        message: '',
        type: SocketResponseType.TERMINAL_SESSION_CLOSED,
        data: { sessionId },
        timestamp: Date.now(),
      })
    }
  }

  destroyAll(): void {
    for (const session of this.sessions.values()) {
      session.destroy()
    }
    this.sessions.clear()
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys())
  }

  getSessions(): TerminalSession[] {
    return Array.from(this.sessions.values())
  }
}

export const terminalManagerSingleton = new TerminalManager()
