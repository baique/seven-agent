import { readFileTool } from '../core/tools/filesystem'
import { readFileContent } from '../core/tools/filesystem/read-file'
import { logger } from '../utils'
import { TerminalSession, OutputCallback, StatusCallback, SessionStatus } from './TerminalSession'
import { validateCommand } from './commandSecurity'

export interface CreateSessionResult {
  sessionId: string
}

export interface ExecResult {
  sessionId: string
  outputToFile: string
  currentContent?: string
}

export type BroadcastCallback = (event: string, data: unknown) => void

export class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map()

  private sessionCounter: number = 0
  private defaultSessionId: string | null = null
  private broadcastCallback: BroadcastCallback | null = null
  private defaultCwd: string = process.env.WORKSPACE || process.cwd()

  setBroadcastCallback(callback: BroadcastCallback | null): void {
    this.broadcastCallback = callback
  }

  private broadcast(event: string, data: unknown): void {
    if (this.broadcastCallback) {
      this.broadcastCallback(event, data)
    }
  }

  private createSessionOutputCallback(): OutputCallback {
    return (sessionId: string, data: string) => {
      this.broadcast('terminal:output', { sessionId, data })
    }
  }

  private createSessionStatusCallback(): StatusCallback {
    return (sessionId: string, status: SessionStatus) => {
      this.broadcast('terminal:status_changed', { sessionId, status })
    }
  }

  async createSession(sessionId: string, cwd?: string): Promise<CreateSessionResult> {
    if (this.sessions.has(sessionId)) {
      return { sessionId }
    }
    const callback = this.createSessionOutputCallback()
    const sessionCwd = cwd || this.defaultCwd
    const session = new TerminalSession(sessionId, sessionCwd, callback)
    await session.initPty('cmd.exe')
    session.setStatusCallback(this.createSessionStatusCallback())
    this.sessions.set(sessionId, session)
    if (!this.defaultSessionId) {
      this.defaultSessionId = sessionId
    }
    this.broadcast('terminal:session_created', { sessionId })
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
      this.broadcast('terminal:session_closed', { sessionId })
    }
    if (this.defaultSessionId === sessionId) {
      this.defaultSessionId = this.sessions.keys().next().value || null
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
