import { ref, computed, onUnmounted } from 'vue'
import { eventBus, Events } from '../eventBus'
import type { AudioCommand } from './useCharacterAction'

interface AudioTask {
  base64Data: string
  onEnd: () => void
}

export function useAudioPlayer() {
  const audioPlaying = ref(false)

  let audioElement: HTMLAudioElement | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let dataArray: Uint8Array<ArrayBuffer> | null = null
  let source: MediaElementAudioSourceNode | null = null
  let animationFrameId: number | null = null
  let mouthCallback: ((openness: number) => void) | null = null

  /** 音频播放队列 */
  const audioQueue = ref<AudioTask[]>([])
  let isProcessingQueue = false

  /** 当前音频的清理函数 */
  let currentAudioCleanup: (() => void) | null = null

  const unsubscribers: (() => void)[] = []

  unsubscribers.push(
    eventBus.on(
      Events.AUDIO_START,
      ({ audio, done }: { audio: AudioCommand; done: () => void }) => {
        if (!audio.audioData) {
          done()
          return
        }
        /** 将音频任务加入队列 */
        audioQueue.value.push({ base64Data: audio.audioData, onEnd: done })
        processQueue()
      },
    ),
  )

  /** 监听音频取消事件 */
  unsubscribers.push(
    eventBus.on(Events.AUDIO_CANCEL, () => {
      clearAudioQueue()
    }),
  )

  /** 处理音频队列 */
  async function processQueue() {
    if (isProcessingQueue || audioQueue.value.length === 0) return

    isProcessingQueue = true

    while (audioQueue.value.length > 0) {
      const task = audioQueue.value.shift()!
      await playAudioInternal(task.base64Data, task.onEnd)
    }

    isProcessingQueue = false
  }

  function initAudioContext() {
    if (audioContext) return

    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.8
    dataArray = new Uint8Array(analyser.frequencyBinCount)
  }

  function startMouthAnimation() {
    if (!analyser || !dataArray) return

    const volumeHistory: number[] = []
    const HISTORY_SIZE = 5
    let lastMouthOpen = 0
    const outputHistory: number[] = []
    const OUTPUT_HISTORY_SIZE = 3

    function analyze() {
      if (!audioElement) {
        mouthCallback?.(0)
        return
      }

      // 音频播放结束或暂停时，停止动画循环
      if (audioElement.paused && audioElement.currentTime >= audioElement.duration) {
        mouthCallback?.(0)
        return
      }

      analyser!.getByteFrequencyData(dataArray!)

      let sum = 0
      const vocalRange = Math.floor(dataArray!.length * 0.2)
      for (let i = 0; i < vocalRange; i++) {
        sum += dataArray![i]
      }
      const average = sum / vocalRange

      volumeHistory.push(average)
      if (volumeHistory.length > HISTORY_SIZE) {
        volumeHistory.shift()
      }

      const recentMax = Math.max(...volumeHistory)
      const recentMin = Math.min(...volumeHistory)
      const dynamicRange = recentMax - recentMin

      let targetOpenness = 0

      if (average > 45 && dynamicRange > 10) {
        targetOpenness = Math.min(1, (average - 40) / 70)
      } else if (average > 35) {
        targetOpenness = Math.min(0.3, (average - 35) / 50)
      }

      const openSpeed = 0.5
      const closeSpeed = 0.35
      const speed = targetOpenness > lastMouthOpen ? openSpeed : closeSpeed
      const smoothedOpenness = lastMouthOpen * (1 - speed) + targetOpenness * speed
      lastMouthOpen = smoothedOpenness

      outputHistory.push(smoothedOpenness)
      if (outputHistory.length > OUTPUT_HISTORY_SIZE) {
        outputHistory.shift()
      }
      const finalOpenness = outputHistory.reduce((a, b) => a + b, 0) / outputHistory.length

      mouthCallback?.(finalOpenness)

      animationFrameId = requestAnimationFrame(analyze)
    }

    analyze()
  }

  function stopMouthAnimation() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    mouthCallback?.(0)
  }

  function setMouthCallback(callback: (openness: number) => void) {
    mouthCallback = callback
  }

  // 内部播放函数，返回 Promise 在播放结束时 resolve
  function playAudioInternal(base64Data: string, onEnd: () => void): Promise<void> {
    return new Promise((resolve) => {
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      const blob = new Blob([bytes], { type: 'audio/mp3' })
      const url = URL.createObjectURL(blob)

      // 创建局部变量，避免被全局 audioElement 覆盖
      const currentAudio = new Audio(url)
      audioElement = currentAudio
      audioPlaying.value = true

      let isResolved = false

      const cleanup = () => {
        if (isResolved) return
        isResolved = true

        // 只有当前音频是正在播放的音频时才清理
        if (audioElement === currentAudio) {
          audioPlaying.value = false
          stopMouthAnimation()
          audioElement = null
          currentAudioCleanup = null
        }
        URL.revokeObjectURL(url)
        eventBus.emit(Events.AUDIO_END)
        onEnd()
        resolve()
      }

      // 保存清理函数，用于外部取消
      currentAudioCleanup = () => {
        currentAudio.pause()
        currentAudio.currentTime = 0
        cleanup()
      }

      currentAudio.onended = cleanup

      currentAudio.onerror = () => {
        console.error('播放音频失败')
        cleanup()
      }

      initAudioContext()

      if (audioContext && analyser) {
        if (source) {
          source.disconnect()
          source = null
        }
        source = audioContext.createMediaElementSource(currentAudio)
        source.connect(analyser)
        analyser.connect(audioContext.destination)
      }

      startMouthAnimation()
      currentAudio.play().catch((err) => {
        console.error('播放音频失败:', err)
        cleanup()
      })
    })
  }

  /** 清空音频队列并停止当前播放 */
  function clearAudioQueue() {
    // 1. 清空队列
    audioQueue.value.length = 0

    // 2. 停止当前播放的音频
    if (currentAudioCleanup) {
      currentAudioCleanup()
    }

    // 3. 停止嘴巴动画
    stopMouthAnimation()

    console.log('[useAudioPlayer] 音频队列已清空')
  }

  onUnmounted(() => {
    unsubscribers.forEach((unsub) => unsub())
    clearAudioQueue()
  })

  return {
    audioPlaying,
    audioQueueLength: computed(() => audioQueue.value.length),
    setMouthCallback,
    clearAudioQueue,
  }
}
