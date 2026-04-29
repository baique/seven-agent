<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { CheckOutlined, StopOutlined, CheckCircleOutlined } from '@ant-design/icons-vue'

interface ToolReviewData {
  requestId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskDescription: string
  timeout: number
}

const reviewData = ref<ToolReviewData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const submitting = ref(false)
const userComment = ref('')

/** Server HTTP 端口，从 URL 参数获取 */
let socketPort = 9172

declare global {
  interface Window {
    api: {
      getToolReviewData: (requestId: string) => Promise<ToolReviewData | null>
      closeReview: (requestId: string) => void
    }
  }
}

onMounted(async () => {
  try {
    const urlParams = new URLSearchParams(window.location.search)
    const requestId = urlParams.get('requestId')
    const portParam = urlParams.get('socketPort')

    if (portParam) {
      socketPort = parseInt(portParam, 10) || 9172
    }

    if (!requestId) {
      error.value = 'Missing requestId parameter'
      loading.value = false
      return
    }

    reviewData.value = await window.api.getToolReviewData(requestId)
    if (!reviewData.value) {
      error.value = 'Review data not found'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    loading.value = false
  }
})

/**
 * 直接通过 HTTP 向 Server 发送审查响应
 */
async function sendReviewResponse(response: {
  requestId: string
  approved: boolean
  simulated?: boolean
  reason?: string
}): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${socketPort}/api/review/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response),
    })
    const data = await res.json()
    return data.code === 200
  } catch (err) {
    console.error('[Review] 发送审查响应失败:', err)
    return false
  }
}

async function handleApprove() {
  if (!reviewData.value || submitting.value) return
  submitting.value = true
  try {
    const reason = userComment.value.trim() ? `用户补充：${userComment.value.trim()}` : undefined
    const sent = await sendReviewResponse({
      requestId: reviewData.value.requestId,
      approved: true,
      simulated: false,
      reason,
    })
    if (!sent) {
      error.value = 'Failed to send approval'
      return
    }
    window.api.closeReview(reviewData.value.requestId)
  } finally {
    submitting.value = false
  }
}

async function handleReject() {
  if (!reviewData.value || submitting.value) return
  submitting.value = true
  try {
    const comment = userComment.value.trim()
    const reason = comment ? `用户拒绝\n用户补充：${comment}` : '用户拒绝'
    const sent = await sendReviewResponse({
      requestId: reviewData.value.requestId,
      approved: false,
      simulated: false,
      reason,
    })
    if (!sent) {
      error.value = 'Failed to send rejection'
      return
    }
    window.api.closeReview(reviewData.value.requestId)
  } finally {
    submitting.value = false
  }
}

async function handleSimulate() {
  if (!reviewData.value || submitting.value) return
  submitting.value = true
  try {
    const reason = userComment.value.trim() ? `用户补充：${userComment.value.trim()}` : undefined
    const sent = await sendReviewResponse({
      requestId: reviewData.value.requestId,
      approved: true,
      simulated: true,
      reason,
    })
    if (!sent) {
      error.value = 'Failed to send simulation'
      return
    }
    window.api.closeReview(reviewData.value.requestId)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="review-container">
    <div class="review-panel">
      <div class="scan-line"></div>
      <div class="corner-decor tl"></div>
      <div class="corner-decor tr"></div>
      <div class="corner-decor bl"></div>
      <div class="corner-decor br"></div>

      <div class="panel-header">
        <div class="header-line"></div>
        <div class="header-dot left"></div>
        <span class="header-title">Tool Review</span>
        <div class="header-dot right"></div>
        <div class="header-line"></div>
      </div>

      <div v-if="loading" class="loading">
        <div class="loading-spinner"></div>
        <span>初始化中...</span>
      </div>
      <div v-else-if="error" class="error-panel">
        <span class="error-text">{{ error }}</span>
      </div>
      <template v-else-if="reviewData">
        <div class="panel-content">
          <div class="info-row">
            <span class="info-label">工具</span>
            <span class="info-value tool-name">{{ reviewData.toolName }}</span>
          </div>
          <div class="info-row risk-row">
            <span class="info-label">风险</span>
            <div class="risk-content">
              <span class="info-value risk">{{ reviewData.riskDescription }}</span>
            </div>
          </div>
          <div v-if="Object.keys(reviewData.toolArgs).length > 0" class="info-row args-row">
            <span class="info-label">参数</span>
          </div>
        </div>

        <div v-if="Object.keys(reviewData.toolArgs).length > 0" class="args-list">
          <div v-for="(value, key) in reviewData.toolArgs" :key="key" class="arg-item">
            <span class="arg-key">{{ key }}</span>
            <pre class="arg-value">{{
              typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
            }}</pre>
          </div>
        </div>

        <div class="user-comment-section">
          <textarea
            v-model="userComment"
            class="comment-input"
            placeholder="拒绝原因（仅在拒绝时有效）"
            rows="2"
            :disabled="submitting"
          ></textarea>
        </div>

        <div class="panel-actions">
          <button class="action-btn reject" :disabled="submitting" @click="handleReject">
            <StopOutlined />
            <span>拒绝</span>
          </button>
          <button class="action-btn simulate" :disabled="submitting" @click="handleSimulate">
            <CheckCircleOutlined />
            <span>模拟</span>
          </button>
          <button class="action-btn approve" :disabled="submitting" @click="handleApprove">
            <CheckOutlined />
            <span>批准</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body {
  min-height: 530px;
  width: 420px;
}

.review-container {
  width: 420px;
  min-height: 530px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: transparent;
  padding: 10px 0;
}

.review-panel {
  width: 400px;
  height: 580px;
  max-height: 85vh;
  background:
    linear-gradient(180deg, rgba(0, 180, 220, 0.08) 0%, rgba(0, 150, 200, 0.05) 100%),
    linear-gradient(
      135deg,
      rgba(10, 10, 26, 0.85) 0%,
      rgba(26, 26, 46, 0.9) 50%,
      rgba(15, 15, 35, 0.85) 100%
    );
  border: 1px solid rgba(0, 212, 255, 0.4);
  border-radius: 8px;
  backdrop-filter: blur(30px) saturate(200%);
  -webkit-backdrop-filter: blur(30px) saturate(200%);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.4),
    0 0 60px rgba(0, 212, 255, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 0 60px rgba(0, 212, 255, 0.05);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.review-panel::before {
  pointer-events: none;
  content: '';
  position: absolute;
  top: -1px;
  left: -1px;
  right: -1px;
  bottom: -1px;
  border-radius: 9px;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    rgba(0, 212, 255, 0.6) 60deg,
    rgba(0, 255, 255, 0.8) 120deg,
    transparent 180deg,
    transparent 360deg
  );
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  padding: 1px;
  animation: borderRotate 4s linear infinite;
  z-index: 10;
}

@keyframes borderRotate {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.scan-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(0, 212, 255, 0.8) 50%, transparent 100%);
  animation: scanMove 2s ease-in-out infinite;
  z-index: 5;
}

@keyframes scanMove {
  0%,
  100% {
    top: 0;
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  90% {
    opacity: 1;
  }
  100% {
    top: 100%;
    opacity: 0;
  }
}

.corner-decor {
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: #00d4ff;
  border-style: solid;
  z-index: 6;
}

.corner-decor.tl {
  top: 4px;
  left: 4px;
  border-width: 2px 0 0 2px;
}

.corner-decor.tr {
  top: 4px;
  right: 4px;
  border-width: 2px 2px 0 0;
}

.corner-decor.bl {
  bottom: 4px;
  left: 4px;
  border-width: 0 0 2px 2px;
}

.corner-decor.br {
  bottom: 4px;
  right: 4px;
  border-width: 0 2px 2px 0;
}

.panel-header {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  gap: 10px;
  margin-top: 8px;
  -webkit-app-region: drag;
}

.header-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(0, 212, 255, 0.6) 50%, transparent 100%);
}

.header-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #00ffff;
  box-shadow:
    0 0 8px #00ffff,
    0 0 16px #00ffff;
}

.header-title {
  font-size: 13px;
  font-weight: 600;
  color: #00d4ff;
  letter-spacing: 3px;
  text-shadow: 0 0 10px rgba(0, 212, 255, 0.8);
}

.loading,
.error-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  gap: 16px;
  color: #00d4ff;
  font-size: 12px;
  letter-spacing: 2px;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(0, 212, 255, 0.3);
  border-top-color: #00d4ff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-text {
  color: #ff4d4f;
  text-shadow: 0 0 10px rgba(255, 77, 77, 0.5);
}

.panel-content {
  width: 100%;
  padding: 0 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
}

.info-row {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.info-label {
  font-size: 10px;
  color: rgba(0, 212, 255, 0.7);
  letter-spacing: 1px;
  min-width: 50px;
  padding-top: 2px;
}

.info-value {
  font-size: 13px;
  color: #e0e0e0;
  flex: 1;
}

.info-value.tool-name {
  color: #00ffff;
  font-weight: 600;
  text-shadow: 0 0 8px rgba(0, 255, 255, 0.5);
}

.info-value.risk {
  color: #ff6b6b;
  text-shadow: 0 0 8px rgba(255, 107, 107, 0.4);
}

.risk-row {
  align-items: flex-start;
}

.risk-content {
  flex: 1;
  max-height: 80px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 107, 107, 0.4) transparent;
}

.risk-content::-webkit-scrollbar {
  width: 4px;
}

.risk-content::-webkit-scrollbar-track {
  background: transparent;
}

.risk-content::-webkit-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    rgba(255, 107, 107, 0.2) 0%,
    rgba(255, 107, 107, 0.6) 50%,
    rgba(255, 107, 107, 0.2) 100%
  );
  border-radius: 2px;
  box-shadow: 0 0 8px rgba(255, 107, 107, 0.4);
}

.args-row {
  flex-direction: column;
  gap: 6px;
}

.args-list {
  flex: 1;
  width: 92%;
  margin: 0 auto 16px;
  min-height: 60px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 212, 255, 0.4) transparent;
}

.args-list::-webkit-scrollbar {
  width: 4px;
}

.args-list::-webkit-scrollbar-track {
  background: transparent;
}

.args-list::-webkit-scrollbar-thumb {
  background: linear-gradient(
    180deg,
    rgba(0, 212, 255, 0.2) 0%,
    rgba(0, 212, 255, 0.6) 50%,
    rgba(0, 212, 255, 0.2) 100%
  );
  border-radius: 2px;
  box-shadow: 0 0 8px rgba(0, 212, 255, 0.4);
}

.arg-item {
  margin-bottom: 8px;
}

.arg-item:last-child {
  margin-bottom: 0;
}

.arg-key {
  display: block;
  font-size: 10px;
  color: rgba(0, 212, 255, 0.7);
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.arg-value {
  margin: 0;
  padding: 8px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(0, 212, 255, 0.2);
  border-radius: 4px;
  font-size: 11px;
  color: #b0b0b0;
  font-family: 'Consolas', 'Monaco', monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.user-comment-section {
  padding: 10px 20px;
  border-top: 1px solid rgba(0, 212, 255, 0.15);
  background: rgba(0, 0, 0, 0.1);
  -webkit-app-region: no-drag;
}

.comment-input {
  width: 100%;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 4px;
  font-size: 12px;
  color: #e0e0e0;
  font-family: inherit;
  resize: none;
  outline: none;
  transition: all 0.2s ease;
}

.comment-input::placeholder {
  color: rgba(224, 224, 224, 0.4);
}

.comment-input:focus {
  border-color: rgba(0, 212, 255, 0.6);
  box-shadow:
    0 0 10px rgba(0, 212, 255, 0.2),
    inset 0 0 10px rgba(0, 212, 255, 0.05);
}

.comment-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.panel-actions {
  display: flex;
  gap: 10px;
  padding: 16px 20px;
  border-top: 1px solid rgba(0, 212, 255, 0.15);
  background: rgba(0, 0, 0, 0.2);
  -webkit-app-region: no-drag;
}

.action-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: transparent;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.reject {
  border-color: rgba(255, 77, 77, 0.6);
  color: #ff6b6b;
}

.action-btn.reject:hover:not(:disabled) {
  background: rgba(255, 77, 77, 0.15);
  border-color: #ff6b6b;
  box-shadow:
    0 0 15px rgba(255, 77, 77, 0.3),
    inset 0 0 15px rgba(255, 77, 77, 0.1);
}

.action-btn.simulate {
  border-color: rgba(82, 196, 26, 0.6);
  color: #52c41a;
}

.action-btn.simulate:hover:not(:disabled) {
  background: rgba(82, 196, 26, 0.15);
  border-color: #52c41a;
  box-shadow:
    0 0 15px rgba(82, 196, 26, 0.3),
    inset 0 0 15px rgba(82, 196, 26, 0.1);
}

.action-btn.approve {
  border-color: rgba(0, 212, 255, 0.6);
  color: #00d4ff;
}

.action-btn.approve:hover:not(:disabled) {
  background: rgba(0, 212, 255, 0.15);
  border-color: #00d4ff;
  box-shadow:
    0 0 15px rgba(0, 212, 255, 0.3),
    inset 0 0 15px rgba(0, 212, 255, 0.1);
}

.action-btn:active:not(:disabled) {
  transform: scale(0.98);
}

.action-btn :deep(.anticon) {
  font-size: 14px;
}
</style>
