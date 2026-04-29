import { onUnmounted } from 'vue'
import { eventBus, Events } from '../eventBus'
import { buildSegments, TimelineSegment } from './timeline'
import type { TTSResult } from './useSocket'
import {
  resolveStateCommand,
  StateCommandFromBackend,
  StateCommandResolved,
  StateParam,
  getStateById,
} from '../state/characterStates'

export type { StateParam }

export type StateCommand = StateCommandResolved

export interface AudioCommand {
  type: 'audio'
  text: string
  speed: string
  id: string
  audioData?: string
  timeline: StateCommandFromBackend[]
  duration?: number
  pauseAfter?: number
  batchId?: string
  batchIndex?: number
  isBatchComplete?: boolean
}

export interface PauseCommand {
  type: 'pause'
  duration: number
}

export type CharacterCommand = StateCommand | AudioCommand | PauseCommand

/** TTS加载任务 */
interface TTSLoadTask {
  cmd: AudioCommand
  promise: Promise<void>
}

/** Pack的TTS加载信息 */
interface PackTTSLoad {
  packId: string
  tasks: Map<number, TTSLoadTask>
}

/**
 * TTS预加载队列
 * 负责跨pack预加载TTS音频，独立于播放流程运行
 */
class TTSLoader {
  /** 所有pack的TTS加载任务，按packId索引 */
  private packs: Map<string, PackTTSLoad> = new Map()

  /** packId计数器 */
  private packIdCounter = 0

  /** TTS合成函数 */
  private ttsSynthesize:
    | ((
        text: string,
        speed: string,
        batchContext?: { batchId: string; batchIndex: number; isBatchComplete: boolean },
      ) => Promise<TTSResult | null>)
    | null = null

  /**
   * 设置TTS合成函数
   */
  setTTSSynthesize(
    fn: (
      text: string,
      speed: string,
      batchContext?: { batchId: string; batchIndex: number; isBatchComplete: boolean },
    ) => Promise<TTSResult | null>,
  ): void {
    this.ttsSynthesize = fn
  }

  /**
   * 添加pack并开始加载TTS
   * @param segments 该pack的所有segments
   * @returns packId和ready Promise，ready在TTS请求发起后resolve
   */
  addPack(segments: TimelineSegment[]): { packId: string; ready: Promise<void> } {
    const packId = `pack-${++this.packIdCounter}`
    const tasks = new Map<number, TTSLoadTask>()

    const audioSegments = segments.filter((s) => s.audio && s.audio.text && !s.audio.audioData)
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    audioSegments.forEach((segment, index) => {
      if (segment.audio) {
        segment.audio.batchId = batchId
        segment.audio.batchIndex = index
        segment.audio.isBatchComplete = index === audioSegments.length - 1
      }
    })

    segments.forEach((segment, index) => {
      if (segment.audio && segment.audio.text && !segment.audio.audioData) {
        const cmd = segment.audio
        const batchContext = {
          batchId: cmd.batchId!,
          batchIndex: cmd.batchIndex!,
          isBatchComplete: cmd.isBatchComplete ?? false,
        }
        const promise = this.loadTTS(cmd, batchContext)
        tasks.set(index, { cmd, promise })
      }
    })

    this.packs.set(packId, { packId, tasks })

    const ready = new Promise<void>((resolve) => Promise.resolve().then(resolve))
    return { packId, ready }
  }

  /**
   * 加载单个TTS
   */
  private async loadTTS(
    cmd: AudioCommand,
    batchContext: { batchId: string; batchIndex: number; isBatchComplete: boolean },
  ): Promise<void> {
    if (!this.ttsSynthesize) return

    const hasValidText = /[\u4e00-\u9fa5a-zA-Z0-9]/.test(cmd.text)
    if (!hasValidText) {
      cmd.duration = 1000
      return
    }

    try {
      const result = await this.ttsSynthesize(cmd.text, cmd.speed || 'stand', batchContext)
      if (result) {
        cmd.audioData = result.audioBase64
        cmd.duration = result.duration || 1000
      }
    } catch (error) {
      console.error('[TTSLoader] TTS加载失败:', error)
    }
  }

  /**
   * 获取指定segment的TTS加载Promise
   * 播放时await此Promise确保音频已加载
   */
  getTTS(packId: string, segmentIndex: number): Promise<void> | undefined {
    const pack = this.packs.get(packId)
    return pack?.tasks.get(segmentIndex)?.promise
  }

  /**
   * 移除已播放完成的pack，释放内存
   */
  removePack(packId: string): void {
    this.packs.delete(packId)
  }
}

function emitEnd(type: 1 | 2 | 3, id: string) {
  if (type !== 2) {
    const stateDef = getStateById(id)
    if (stateDef?.duration === 'persistent') return
  }
  const cmd = resolveStateCommand({ type, id })
  if (cmd) {
    const eventType =
      type === 1 ? Events.FACE_END : type === 2 ? Events.ACT_END : Events.EMOTION_END
    eventBus.emit(eventType, cmd)
  }
}

function emitStart(type: 1 | 2 | 3, cmd: StateCommandFromBackend) {
  const resolved = resolveStateCommand(cmd)
  if (!resolved) return
  const eventType =
    type === 1 ? Events.FACE_START : type === 2 ? Events.ACT_START : Events.EMOTION_START
  eventBus.emit(eventType, resolved)
}

/** 取消令牌，用于中断当前播放 */
interface CancellationToken {
  cancelled: boolean
}

/**
 * 角色动作控制选项
 */
export interface CharacterActionOptions {
  /** 判断是否应该处理 command，返回 false 时忽略所有 command */
  shouldProcessCommand?: () => boolean
}

export function useCharacterAction(options?: CharacterActionOptions) {
  const buffer: CharacterCommand[] = []

  /** 待执行队列：存储所有待处理的pack（未加载） */
  const queue: TimelineSegment[][] = []

  /** 任务栈：固定大小2，存储已加载的pack */
  const stack: { packId: string; segments: TimelineSegment[] }[] = []
  const STACK_SIZE = 2

  /** 加载状态 */
  let loading = false
  /** 播放状态 */
  let playing = false

  let lastSegmentFaces: string[] = []
  let lastSegmentActs: string[] = []
  let lastSegmentEmotions: { id: string; intensity: number }[] = []

  /** TTS预加载器 */
  const ttsLoader = new TTSLoader()

  /** 当前播放的取消令牌 */
  let currentCancellationToken: CancellationToken | null = null

  function setTTSSynthesize(
    fn: (
      text: string,
      speed: string,
      batchContext?: { batchId: string; batchIndex: number; isBatchComplete: boolean },
    ) => Promise<TTSResult | null>,
  ) {
    ttsLoader.setTTSSynthesize(fn)
  }

  /**
   * 加载流程：从队列取pack入栈并加载
   */
  async function tryLoad(): Promise<void> {
    if (loading) return
    if (stack.length >= STACK_SIZE) return
    if (queue.length === 0) return

    loading = true
    try {
      const segments = queue.shift()!
      const { packId, ready } = ttsLoader.addPack(segments)
      stack.push({ packId, segments })
      await ready
    } finally {
      loading = false
      /** 加载完成后触发播放 */
      tryPlay()
      /** 继续尝试加载 */
      tryLoad()
    }
  }

  /**
   * 播放流程：播放栈顶pack
   */
  async function tryPlay(): Promise<void> {
    if (playing) return
    if (stack.length === 0) {
      /** 栈空且队列空，结束 */
      if (queue.length === 0 && !loading) {
        if (lastSegmentFaces.length > 0 || lastSegmentActs.length > 0) {
          lastSegmentFaces.forEach((id) => emitEnd(1, id))
          lastSegmentActs.forEach((id) => emitEnd(2, id))
          lastSegmentEmotions.forEach((e) => emitEnd(3, e.id))
          lastSegmentFaces = []
          lastSegmentActs = []
          lastSegmentEmotions = []
        }
        eventBus.emit(Events.TIMELINE_COMPLETE)
      }
      return
    }

    playing = true
    /** 创建新的取消令牌 */
    currentCancellationToken = { cancelled: false }
    try {
      const current = stack[0]
      await playPack(current.packId, current.segments, currentCancellationToken)

      /** 播放完毕，出栈 */
      ttsLoader.removePack(current.packId)
      stack.shift()

      /** 出栈后触发加载 */
      tryLoad()
    } finally {
      playing = false
      currentCancellationToken = null
      /** 继续播放 */
      tryPlay()
    }
  }

  const unsubscribe = eventBus.on(
    Events.MESSAGE_COMMAND,
    ({ command }: { requestId: string; command: any }) => {
      // 如果提供了判断函数且返回 false，则忽略此 command
      if (options?.shouldProcessCommand && !options.shouldProcessCommand()) {
        return
      }
      switch (command.type) {
        case 1:
        case 2:
        case 3: {
          const resolved = resolveStateCommand(command as StateCommandFromBackend)
          if (resolved) {
            buffer.push(resolved)
          }
          break
        }
        case 'audio': {
          const audioCmd = command as AudioCommand

          if (audioCmd.text) {
            const hasValidText = /[\u4e00-\u9fa5a-zA-Z0-9]/.test(audioCmd.text)
            if (!hasValidText) {
              audioCmd.duration = 1000
            }
          }

          console.log('[useCharacterAction] audio command received:', {
            text: audioCmd.text?.slice(0, 20),
            pauseAfter: audioCmd.pauseAfter,
            hasPauseAfter: 'pauseAfter' in audioCmd,
          })

          const pack = [...buffer, audioCmd]
          buffer.length = 0
          queue.push(buildSegments(pack))

          /** 入队后触发加载和播放 */
          tryLoad()
          tryPlay()
          break
        }

        case 'pause': {
          const pack = [...buffer, command]
          buffer.length = 0
          queue.push(buildSegments(pack))

          tryLoad()
          tryPlay()
          break
        }
      }
    },
  )

  /**
   * 播放单个pack
   */
  async function playPack(
    packId: string,
    segments: TimelineSegment[],
    cancellationToken: CancellationToken,
  ): Promise<void> {
    for (let i = 0; i < segments.length; i++) {
      /** 检查是否已取消 */
      if (cancellationToken.cancelled) {
        return
      }

      const segment = segments[i]

      /** 等待当前segment的TTS加载完成 */
      const ttsPromise = ttsLoader.getTTS(packId, i)
      if (ttsPromise) {
        await ttsPromise
      }

      /** 检查是否已取消 */
      if (cancellationToken.cancelled) {
        return
      }

      await playSegment(segment, cancellationToken)
    }
  }

  async function playSegment(segment: TimelineSegment, cancellationToken: CancellationToken) {
    /** 检查是否已取消 */
    if (cancellationToken.cancelled) {
      return
    }

    const currentFaces = segment.faces.map((f) => f.id)
    const currentActs = segment.acts.map((a) => a.id)
    const currentEmotions = segment.emotions.map((e) => ({ id: e.id, intensity: e.intensity ?? 1 }))

    const isCalm = currentEmotions.some((e) => e.id === '平静')

    lastSegmentFaces.filter((id) => !currentFaces.includes(id)).forEach((id) => emitEnd(1, id))
    lastSegmentActs.filter((id) => !currentActs.includes(id)).forEach((id) => emitEnd(2, id))

    if (isCalm) {
      for (const lastEmotion of lastSegmentEmotions) {
        if (lastEmotion.id !== '平静') {
          emitEnd(3, lastEmotion.id)
        }
      }
      lastSegmentEmotions = []
    } else {
      for (const lastEmotion of lastSegmentEmotions) {
        const currentEmotion = currentEmotions.find((e) => e.id === lastEmotion.id)
        const lastIntensity = lastEmotion.intensity ?? 1
        const currentIntensity = currentEmotion?.intensity ?? 1

        if (lastIntensity >= currentIntensity) {
          emitEnd(3, lastEmotion.id)
        }
      }

      for (const emotion of currentEmotions) {
        const lastEmotion = lastSegmentEmotions.find((e) => e.id === emotion.id)
        const lastIntensity = lastEmotion?.intensity ?? 1
        const currentIntensity = emotion.intensity ?? 1

        if (currentIntensity > lastIntensity) {
          emitEnd(3, emotion.id)
        }
      }
    }

    lastSegmentFaces = currentFaces
    lastSegmentActs = currentActs
    lastSegmentEmotions = currentEmotions

    const actDuration = segment.acts.length > 1 ? 1000 : 3000
    const audioDuration = segment.audio?.duration || segment.duration

    const facePromise = playFaces(segment.faces, audioDuration, cancellationToken)
    const actPromise = playActs(segment.acts, actDuration, audioDuration, cancellationToken)
    const emotionPromise = playEmotions(segment.emotions, audioDuration, cancellationToken)
    const audioPromise = segment.audio
      ? playAudio(segment.audio, cancellationToken)
      : delayWithCancellation(segment.duration, cancellationToken)

    await Promise.all([facePromise, actPromise, emotionPromise, audioPromise])

    /** 检查是否已取消 */
    if (cancellationToken.cancelled) {
      return
    }

    console.log(
      '[useCharacterAction] segment playback complete, pauseAfter:',
      segment.audio?.pauseAfter,
    )

    if (segment.audio?.pauseAfter) {
      const pauseDuration = segment.audio.pauseAfter * 1000
      console.log('[useCharacterAction] applying pauseAfter delay:', pauseDuration, 'ms')
      await delayWithCancellation(pauseDuration, cancellationToken)
    }
  }

  async function playFaces(
    faces: StateCommandFromBackend[],
    audioDuration: number,
    cancellationToken: CancellationToken,
  ) {
    if (faces.length === 0) return

    for (const face of faces) {
      emitStart(1, face)
    }

    await delayWithCancellation(audioDuration, cancellationToken)
  }

  async function playActs(
    acts: StateCommandFromBackend[],
    actDuration: number,
    audioDuration: number,
    cancellationToken: CancellationToken,
  ) {
    for (let i = 0; i < acts.length; i++) {
      const act = acts[i]
      emitStart(2, act)

      if (i < acts.length - 1) {
        await delayWithCancellation(actDuration, cancellationToken)
      } else {
        await delayWithCancellation(audioDuration, cancellationToken)
      }
    }
  }

  async function playEmotions(
    emotions: StateCommandFromBackend[],
    audioDuration: number,
    cancellationToken: CancellationToken,
  ) {
    if (emotions.length === 0) return

    for (const emotion of emotions) {
      emitStart(3, emotion)
    }

    await delayWithCancellation(audioDuration, cancellationToken)
  }

  /**
   * 支持取消的延迟函数
   */
  function delayWithCancellation(ms: number, cancellationToken: CancellationToken): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now()
      const checkInterval = 50 // 每50ms检查一次是否取消

      const check = () => {
        if (cancellationToken.cancelled) {
          resolve()
          return
        }

        const elapsed = Date.now() - startTime
        if (elapsed >= ms) {
          resolve()
        } else {
          setTimeout(check, Math.min(checkInterval, ms - elapsed))
        }
      }

      check()
    })
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function playAudio(
    item: AudioCommand,
    cancellationToken: CancellationToken,
  ): Promise<void> {
    if (!item.audioData) {
      return
    }

    return new Promise((resolve) => {
      /** 检查是否已取消 */
      if (cancellationToken.cancelled) {
        resolve()
        return
      }

      eventBus.emit(Events.AUDIO_START, {
        audio: item,
        done: () => {
          /** 无论是否取消都resolve，确保Promise链正常结束 */
          resolve()
        },
      })
    })
  }

  /**
   * 清空所有动作队列和音频队列
   * 停止当前播放并清理状态
   */
  function clearActionQueue(): void {
    /** 1. 取消当前播放 */
    if (currentCancellationToken) {
      currentCancellationToken.cancelled = true
      currentCancellationToken = null
    }

    /** 2. 清空待执行队列 */
    queue.length = 0

    /** 3. 清空任务栈 */
    while (stack.length > 0) {
      const current = stack.shift()
      if (current) {
        ttsLoader.removePack(current.packId)
      }
    }

    /** 4. 清空buffer */
    buffer.length = 0

    /** 5. 重置状态 */
    loading = false
    playing = false

    /** 6. 重置lastSegment状态 */
    lastSegmentFaces = []
    lastSegmentActs = []
    lastSegmentEmotions = []

    /** 7. 发送音频取消事件 */
    eventBus.emit(Events.AUDIO_CANCEL)

    console.log('[useCharacterAction] 动作队列已清空')
  }

  onUnmounted(() => {
    unsubscribe()
  })

  return {
    setTTSSynthesize,
    clearActionQueue,
  }
}
