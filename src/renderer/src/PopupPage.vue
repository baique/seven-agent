<script setup lang="ts">
import { onMounted, ref } from 'vue'

const content = ref('')
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    const urlParams = new URLSearchParams(window.location.search)
    const nanoid = urlParams.get('nanoid')

    if (!nanoid) {
      error.value = 'Missing nanoid parameter'
      loading.value = false
      return
    }

    const port = window.location.port || '9172'
    const response = await fetch(`http://localhost:${port}/popup/${nanoid}`)

    if (!response.ok) {
      throw new Error(`Failed to fetch content: ${response.statusText}`)
    }

    content.value = await response.text()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="popup-container">
    <div v-if="loading" class="loading">Loading...</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <div v-else class="popup-content" v-html="content"></div>
  </div>
</template>

<style scoped>
.popup-container {
  width: 100vw;
  height: 100vh;
  background: transparent;
}

.loading,
.error {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 16px;
  color: #666;
}

.error {
  color: #f56c6c;
}

.popup-content {
  width: 100%;
  height: 100%;
  overflow: auto;
}
</style>
