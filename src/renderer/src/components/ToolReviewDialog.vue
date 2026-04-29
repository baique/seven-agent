<script setup lang="ts">
import { computed } from 'vue'
import { Button } from 'ant-design-vue'
import { CheckOutlined, StopOutlined, CheckCircleOutlined } from '@ant-design/icons-vue'
interface ToolReviewData {
  requestId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskDescription: string
  timeout: number
}

const props = defineProps<{
  reviewData: ToolReviewData | null
}>()

const emit = defineEmits<{
  approve: [requestId: string]
  reject: [requestId: string, reason?: string]
  simulate: [requestId: string]
  mouseEvent: [state: boolean, option?: any]
}>()

const visible = computed(() => props.reviewData !== null)

function handleApprove() {
  if (props.reviewData) {
    emit('approve', props.reviewData.requestId)
  }
}

function handleReject() {
  if (props.reviewData) {
    emit('reject', props.reviewData.requestId, '用户拒绝')
  }
}

function handleSimulate() {
  if (props.reviewData) {
    emit('simulate', props.reviewData.requestId)
  }
}

function handleMouseDown() {
  emit('mouseEvent', false, null)
}

function handleMouseUp() {
  emit('mouseEvent', false, null)
}
</script>

<template>
  <div v-if="visible" class="review-overlay" @mousedown="handleMouseDown" @mouseup="handleMouseUp">
    <div class="review-dialog" @click.stop>
      <div class="review-header">
        <span class="review-title">工具执行确认</span>
      </div>

      <div class="review-content" v-if="reviewData">
        <div class="review-item">
          <span class="review-label">工具名称:</span>
          <span class="review-value tool-name">{{ reviewData.toolName }}</span>
        </div>

        <div class="review-item">
          <span class="review-label">风险说明:</span>
          <span class="review-value risk-desc">{{ reviewData.riskDescription }}</span>
        </div>

        <div class="review-item" v-if="Object.keys(reviewData.toolArgs).length > 0">
          <span class="review-label">参数:</span>
          <pre class="review-args">{{ JSON.stringify(reviewData.toolArgs, null, 2) }}</pre>
        </div>
      </div>

      <div class="review-actions">
        <Button class="reject-btn" @click="handleReject">
          <template #icon><StopOutlined /></template>
          拒绝
        </Button>
        <Button class="simulate-btn" @click="handleSimulate">
          <template #icon><CheckCircleOutlined /></template>
          模拟成功
        </Button>
        <Button type="primary" class="approve-btn" @click="handleApprove">
          <template #icon><CheckOutlined /></template>
          确认执行
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  pointer-events: auto;
}

.review-dialog {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  width: 280px;
  max-width: 90vw;
  max-height: 85vh;
  overflow: hidden;
  pointer-events: auto;
}

.review-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: linear-gradient(135deg, #ff6b6b, #ffa500);
  color: #fff;
  pointer-events: auto;
}

.review-title {
  font-size: 16px;
  font-weight: 600;
}

.review-countdown {
  font-size: 14px;
  background: rgba(255, 255, 255, 0.2);
  padding: 4px 10px;
  border-radius: 12px;
}

.review-content {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
  pointer-events: auto;
}

.review-item {
  margin-bottom: 12px;
}

.review-label {
  display: block;
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}

.review-value {
  font-size: 14px;
  color: #333;
}

.tool-name {
  font-weight: 600;
  color: #1890ff;
}

.risk-desc {
  color: #ff4d4f;
}

.review-args {
  margin: 0;
  padding: 10px;
  background: #f5f5f5;
  border-radius: 6px;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 40vh;
  overflow-y: auto;
}

/* 滚动条样式 */
.review-args::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.review-args::-webkit-scrollbar-track {
  background: rgba(0, 212, 255, 0.05);
  border-radius: 2px;
}

.review-args::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, #00d4ff, #00ffff);
  border-radius: 2px;
  opacity: 0.6;
}

.review-args::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, #00ffff, #00d4ff);
  opacity: 0.8;
}

.review-actions {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #f0f0f0;
  background: #fafafa;
  pointer-events: auto;
}

.reject-btn {
  flex: 1;
  pointer-events: auto;
}

.simulate-btn {
  flex: 1;
  background: #52c41a;
  border-color: #52c41a;
  color: #fff;
  pointer-events: auto;
}

.simulate-btn:hover {
  background: #389e0d;
  border-color: #389e0d;
  color: #fff;
}

.approve-btn {
  flex: 1;
  pointer-events: auto;
}
</style>
