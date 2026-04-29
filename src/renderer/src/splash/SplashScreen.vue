<template>
  <div class="splash-container" :class="{ 'fade-out': isFadingOut }">
    <!-- 背景动画 -->
    <canvas ref="canvasRef" class="bg-canvas"></canvas>

    <!-- 扫描线效果 -->
    <div class="scan-line"></div>

    <!-- 主内容区 -->
    <div class="content">
      <!-- Logo区域 -->
      <div class="logo-section">
        <div class="logo-ring">
          <div class="logo-inner"></div>
        </div>
        <h1 class="app-name">Agent</h1>
        <p class="app-version">v1.0.0</p>
      </div>

      <!-- 进度区域 -->
      <div class="progress-section">
        <!-- 步骤指示器 -->
        <div class="steps-indicator">
          <div
            v-for="(step, index) in steps"
            :key="step.id"
            class="step-item"
            :class="{
              active: index <= currentStepIndex,
              current: index === currentStepIndex,
            }"
          >
            <div class="step-dot"></div>
            <div v-if="index < steps.length - 1" class="step-line"></div>
          </div>
        </div>

        <!-- 当前步骤信息 -->
        <div class="step-info">
          <div class="step-label">{{ currentStep.label }}</div>
          <div class="step-description">{{ currentStep.description }}</div>
        </div>

        <!-- 进度条 -->
        <div class="progress-bar-container">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" :style="{ width: `${progress}%` }">
              <div class="progress-glow"></div>
            </div>
          </div>
          <div class="progress-text">{{ Math.round(progress) }}%</div>
        </div>
      </div>

      <!-- 底部信息 -->
      <div class="footer">
        <div class="tech-decoration">
          <span class="tech-text">SYSTEM INITIALIZING</span>
          <span class="tech-dots">{{ dots }}</span>
        </div>
      </div>
    </div>

    <!-- 角落装饰 -->
    <div class="corner corner-tl"></div>
    <div class="corner corner-tr"></div>
    <div class="corner corner-bl"></div>
    <div class="corner corner-br"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface SplashStep {
  id: string
  label: string
  description: string
}

const steps: SplashStep[] = [
  { id: 'init', label: '初始化', description: '正在准备启动环境...' },
  { id: 'server', label: '启动服务器', description: '正在启动核心服务...' },
  { id: 'connect', label: '连接服务', description: '正在建立连接...' },
  { id: 'workspace', label: '初始化工作空间', description: '正在加载工作区...' },
  { id: 'memory', label: '加载历史记忆', description: '正在恢复对话历史...' },
  { id: 'complete', label: '准备就绪', description: '即将进入主界面...' },
]

const currentStepId = ref('init')
const progress = ref(0)
const isFadingOut = ref(false)
const dots = ref('')
const canvasRef = ref<HTMLCanvasElement>()

const currentStepIndex = computed(() => {
  return steps.findIndex((s) => s.id === currentStepId.value)
})

const currentStep = computed(() => {
  const step = steps.find((s) => s.id === currentStepId.value)
  return step || steps[0]
})

// 动画点
let dotsInterval: number
onMounted(() => {
  dotsInterval = window.setInterval(() => {
    dots.value = '.'.repeat((dots.value.length % 3) + 1)
  }, 500)

  // 初始化粒子背景
  initParticleBackground()

  // 监听进度更新
  if (window.api?.on) {
    window.api.on(
      'splash:progress',
      (data: { step: string; progress: number; label: string; description: string }) => {
        currentStepId.value = data.step
        progress.value = data.progress
      },
    )

    window.api.on('splash:fade-out', () => {
      isFadingOut.value = true
    })
  }
})

onUnmounted(() => {
  clearInterval(dotsInterval)
})

// 粒子背景动画
function initParticleBackground() {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const resize = () => {
    canvas.width = canvas.offsetWidth * window.devicePixelRatio
    canvas.height = canvas.offsetHeight * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
  }
  resize()
  window.addEventListener('resize', resize)

  interface Particle {
    x: number
    y: number
    vx: number
    vy: number
    size: number
    alpha: number
  }

  const particles: Particle[] = []
  const particleCount = 50

  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * canvas.offsetWidth,
      y: Math.random() * canvas.offsetHeight,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      size: Math.random() * 2 + 1,
      alpha: Math.random() * 0.5 + 0.2,
    })
  }

  let animationId: number
  const animate = () => {
    ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight)

    // 绘制粒子
    particles.forEach((p, i) => {
      p.x += p.vx
      p.y += p.vy

      if (p.x < 0 || p.x > canvas.offsetWidth) p.vx *= -1
      if (p.y < 0 || p.y > canvas.offsetHeight) p.vy *= -1

      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(100, 180, 255, ${p.alpha})`
      ctx.fill()

      // 连接线
      particles.slice(i + 1).forEach((p2) => {
        const dx = p.x - p2.x
        const dy = p.y - p2.y
        const dist = Math.sqrt(dx * dx + dy * dy)

        if (dist < 100) {
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(p2.x, p2.y)
          ctx.strokeStyle = `rgba(100, 180, 255, ${0.1 * (1 - dist / 100)})`
          ctx.stroke()
        }
      })
    })

    animationId = requestAnimationFrame(animate)
  }
  animate()

  onUnmounted(() => {
    cancelAnimationFrame(animationId)
    window.removeEventListener('resize', resize)
  })
}
</script>

<style scoped>
.splash-container {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
  border-radius: 12px;
  position: relative;
  overflow: hidden;
  box-shadow:
    0 0 60px rgba(0, 150, 255, 0.3),
    inset 0 0 60px rgba(0, 100, 200, 0.1);
  transition: opacity 0.5s ease-out;
  -webkit-app-region: drag;
}

.splash-container.fade-out {
  opacity: 0;
}

/* 背景画布 */
.bg-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* 扫描线效果 */
.scan-line {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(100, 200, 255, 0.5), transparent);
  animation: scan 3s linear infinite;
  pointer-events: none;
}

@keyframes scan {
  0% {
    transform: translateY(0);
  }
  100% {
    transform: translateY(400px);
  }
}

/* 主内容 */
.content {
  position: relative;
  z-index: 10;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 40px 30px;
}

/* Logo区域 */
.logo-section {
  text-align: center;
}

.logo-ring {
  width: 80px;
  height: 80px;
  border: 3px solid rgba(100, 180, 255, 0.3);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  position: relative;
  animation: pulse 2s ease-in-out infinite;
}

.logo-ring::before {
  content: '';
  position: absolute;
  width: 100%;
  height: 100%;
  border: 2px solid transparent;
  border-top-color: rgba(100, 180, 255, 0.8);
  border-radius: 50%;
  animation: spin 2s linear infinite;
}

.logo-inner {
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #64b4ff, #0096ff);
  border-radius: 50%;
  box-shadow: 0 0 20px rgba(100, 180, 255, 0.5);
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.05);
    opacity: 0.8;
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.app-name {
  font-size: 28px;
  font-weight: 300;
  color: #fff;
  letter-spacing: 4px;
  text-shadow: 0 0 20px rgba(100, 180, 255, 0.5);
  margin-bottom: 8px;
}

.app-version {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 2px;
}

/* 进度区域 */
.progress-section {
  width: 100%;
  max-width: 480px;
}

/* 步骤指示器 */
.steps-indicator {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 24px;
}

.step-item {
  display: flex;
  align-items: center;
}

.step-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  transition: all 0.3s ease;
}

.step-item.active .step-dot {
  background: rgba(100, 180, 255, 0.6);
}

.step-item.current .step-dot {
  background: #64b4ff;
  box-shadow: 0 0 10px rgba(100, 180, 255, 0.8);
  animation: dotPulse 1.5s ease-in-out infinite;
}

@keyframes dotPulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.3);
  }
}

.step-line {
  width: 30px;
  height: 2px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 8px;
  transition: all 0.3s ease;
}

.step-item.active .step-line {
  background: linear-gradient(90deg, rgba(100, 180, 255, 0.6), rgba(100, 180, 255, 0.3));
}

/* 步骤信息 */
.step-info {
  text-align: center;
  margin-bottom: 20px;
}

.step-label {
  font-size: 16px;
  color: #fff;
  font-weight: 500;
  margin-bottom: 6px;
  letter-spacing: 1px;
}

.step-description {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
}

/* 进度条 */
.progress-bar-container {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-bar-bg {
  flex: 1;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
  position: relative;
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #0096ff, #64b4ff);
  border-radius: 3px;
  transition: width 0.3s ease;
  position: relative;
}

.progress-glow {
  position: absolute;
  right: 0;
  top: 0;
  width: 20px;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5));
  animation: glow 1.5s ease-in-out infinite;
}

@keyframes glow {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

.progress-text {
  font-size: 14px;
  color: #64b4ff;
  font-weight: 500;
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 底部 */
.footer {
  text-align: center;
}

.tech-decoration {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.tech-text {
  font-size: 11px;
  color: rgba(100, 180, 255, 0.6);
  letter-spacing: 3px;
  font-family: 'Courier New', monospace;
}

.tech-dots {
  font-size: 11px;
  color: rgba(100, 180, 255, 0.6);
  font-family: 'Courier New', monospace;
  min-width: 20px;
  text-align: left;
}

/* 角落装饰 */
.corner {
  position: absolute;
  width: 20px;
  height: 20px;
  border: 2px solid rgba(100, 180, 255, 0.3);
}

.corner-tl {
  top: 15px;
  left: 15px;
  border-right: none;
  border-bottom: none;
}

.corner-tr {
  top: 15px;
  right: 15px;
  border-left: none;
  border-bottom: none;
}

.corner-bl {
  bottom: 15px;
  left: 15px;
  border-right: none;
  border-top: none;
}

.corner-br {
  bottom: 15px;
  right: 15px;
  border-left: none;
  border-top: none;
}
</style>
