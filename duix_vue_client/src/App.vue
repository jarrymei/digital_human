<script setup>
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import {
  createTaskCode,
  queryVideoTask,
  resolveResultVideoUrl,
  submitVideoTask,
  synthesizeSpeech
} from './services/duixAvatarApi'

const DEFAULT_HOST = '154.93.109.240'
const POLL_INTERVAL = 2000

const isSubmitting = ref(false)
const isPolling = ref(false)
const progress = ref(0)
const resultVideoUrl = ref('')
const currentTask = ref(null)
const pollTimer = ref(null)
const ttsAudioUrl = ref('')

const config = reactive({
  videoApiBase: import.meta.env.VITE_DUIX_VIDEO_API_BASE || '/duix-video/easy',
  ttsApiBase: import.meta.env.VITE_DUIX_TTS_API_BASE || '/duix-tts',
  outputBaseUrl: import.meta.env.VITE_DUIX_OUTPUT_BASE_URL || `http://${DEFAULT_HOST}:8383`,
  pollInterval: POLL_INTERVAL
})

const videoForm = reactive({
  audioUrl: '',
  videoUrl: '',
  code: createTaskCode(),
  chaofen: 0,
  watermarkSwitch: 0,
  pn: 1
})

const ttsForm = reactive({
  text: '你好，我是 DUIX 数字人。',
  speaker: createTaskCode(),
  referenceAudio: '',
  referenceText: '',
  format: 'wav',
  topP: 0.7,
  maxNewTokens: 1024,
  chunkLength: 100,
  repetitionPenalty: 1.2,
  temperature: 0.7,
  needAsr: false,
  streaming: false,
  isFixedSeed: 0,
  isNorm: 1
})

const events = ref([
  {
    id: 'init',
    name: 'ready',
    detail: '填写 audio_url 和 video_url 后即可提交 Duix.Avatar 离线合成任务',
    time: new Date().toLocaleTimeString()
  }
])

const statusText = computed(() => {
  if (isSubmitting.value) return '提交中'
  if (isPolling.value) return '生成中'
  if (resultVideoUrl.value) return '已完成'
  return '待提交'
})

const canSubmit = computed(() => {
  return videoForm.audioUrl.trim() && videoForm.videoUrl.trim() && videoForm.code.trim() && !isSubmitting.value
})

function logEvent(name, detail) {
  events.value.unshift({
    id: `${Date.now()}-${Math.random()}`,
    name,
    detail: normalizeEvent(detail),
    time: new Date().toLocaleTimeString()
  })
  events.value = events.value.slice(0, 10)
}

function normalizeEvent(event) {
  if (!event) return ''
  if (typeof event === 'string') return event
  if (event.message) return event.message
  try {
    return JSON.stringify(event)
  } catch {
    return String(event)
  }
}

function resetTaskCode() {
  videoForm.code = createTaskCode()
}

async function submitTask() {
  if (!canSubmit.value) return

  stopPolling()
  isSubmitting.value = true
  progress.value = 0
  resultVideoUrl.value = ''

  const payload = {
    audio_url: videoForm.audioUrl.trim(),
    video_url: videoForm.videoUrl.trim(),
    code: videoForm.code.trim(),
    chaofen: Number(videoForm.chaofen),
    watermark_switch: Number(videoForm.watermarkSwitch),
    pn: Number(videoForm.pn)
  }

  try {
    const result = await submitVideoTask(config.videoApiBase, payload)
    currentTask.value = { code: payload.code, payload, submitResult: result }
    logEvent('submit', result)

    if (result.code === 10000 || result.success) {
      startPolling(payload.code)
    } else {
      logEvent('submit-warning', result.msg || '提交返回非成功状态，请检查任务是否已进入队列')
    }
  } catch (error) {
    logEvent('error', error.message)
  } finally {
    isSubmitting.value = false
  }
}

async function queryTask(code = videoForm.code.trim()) {
  if (!code) return

  try {
    const result = await queryVideoTask(config.videoApiBase, code)
    handleQueryResult(result)
    return result
  } catch (error) {
    logEvent('error', error.message)
    throw error
  }
}

function startPolling(code) {
  isPolling.value = true
  logEvent('poll', `开始轮询任务：${code}`)
  queryTask(code).catch(() => stopPolling())

  pollTimer.value = window.setInterval(() => {
    queryTask(code).catch(() => stopPolling())
  }, Number(config.pollInterval) || POLL_INTERVAL)
}

function stopPolling() {
  if (pollTimer.value) {
    window.clearInterval(pollTimer.value)
    pollTimer.value = null
  }
  isPolling.value = false
}

function handleQueryResult(result) {
  logEvent('query', result)

  if (result.code !== 10000) {
    return
  }

  const data = result.data || {}
  progress.value = Number(data.progress || progress.value || 0)

  if (data.status === 2) {
    stopPolling()
    progress.value = 100
    resultVideoUrl.value = resolveResultVideoUrl(config.outputBaseUrl, data.result)
    logEvent('success', data.result || '视频生成完成')
  }

  if (data.status === 3) {
    stopPolling()
    logEvent('failed', data.msg || '视频生成失败')
  }
}

async function synthesizeTtsPreview() {
  if (!ttsForm.text.trim() || !ttsForm.referenceAudio.trim() || !ttsForm.referenceText.trim()) {
    logEvent('error', 'TTS 试听需要 text、reference_audio 和 reference_text')
    return
  }

  const payload = {
    speaker: ttsForm.speaker.trim() || createTaskCode(),
    text: ttsForm.text.trim(),
    format: ttsForm.format,
    topP: Number(ttsForm.topP),
    max_new_tokens: Number(ttsForm.maxNewTokens),
    chunk_length: Number(ttsForm.chunkLength),
    repetition_penalty: Number(ttsForm.repetitionPenalty),
    temperature: Number(ttsForm.temperature),
    need_asr: Boolean(ttsForm.needAsr),
    streaming: Boolean(ttsForm.streaming),
    is_fixed_seed: Number(ttsForm.isFixedSeed),
    is_norm: Number(ttsForm.isNorm),
    reference_audio: ttsForm.referenceAudio.trim(),
    reference_text: ttsForm.referenceText.trim()
  }

  try {
    const blob = await synthesizeSpeech(config.ttsApiBase, payload)
    if (ttsAudioUrl.value) {
      URL.revokeObjectURL(ttsAudioUrl.value)
    }
    ttsAudioUrl.value = URL.createObjectURL(blob)
    logEvent('tts', `已生成试听音频：${Math.round(blob.size / 1024)} KB`)
  } catch (error) {
    logEvent('error', error.message)
  }
}

onBeforeUnmount(() => {
  stopPolling()
  if (ttsAudioUrl.value) {
    URL.revokeObjectURL(ttsAudioUrl.value)
  }
})
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Duix.Avatar Client</p>
        <h1>离线数字人视频合成</h1>
      </div>
      <div class="status-pill" :class="{ active: isPolling || resultVideoUrl }">
        <span></span>
        {{ statusText }}
      </div>
    </header>

    <section class="workspace">
      <div class="stage-panel">
        <div class="stage-toolbar">
          <div>
            <strong>生成结果</strong>
            <small>{{ currentTask?.code || '还没有提交任务' }}</small>
          </div>
          <button class="ghost" type="button" @click="queryTask()" :disabled="!videoForm.code.trim()">
            查询进度
          </button>
        </div>

        <div class="video-stage">
          <video v-if="resultVideoUrl" :src="resultVideoUrl" controls autoplay playsinline></video>
          <div v-else class="stage-empty">
            <strong>{{ isPolling ? '视频生成中' : '等待任务' }}</strong>
            <span>{{ isPolling ? `当前进度 ${progress || 0}%` : '提交后会在这里播放生成结果' }}</span>
            <div class="progress-track">
              <div :style="{ width: `${progress || 0}%` }"></div>
            </div>
          </div>
        </div>
      </div>

      <aside class="side-panel">
        <section class="panel-section">
          <div class="section-title">
            <h2>视频合成</h2>
            <span>官方 /easy/submit</span>
          </div>

          <label>
            audio_url
            <input v-model="videoForm.audioUrl" placeholder="例如 /app/data/demo.wav 或已验证的音频路径" />
          </label>
          <label>
            video_url
            <input v-model="videoForm.videoUrl" placeholder="例如 /app/data/avatar.mp4 或已验证的视频路径" />
          </label>
          <label>
            code
            <div class="input-row">
              <input v-model="videoForm.code" />
              <button class="secondary icon-button" type="button" @click="resetTaskCode">生成</button>
            </div>
          </label>

          <div class="inline-settings">
            <label>
              chaofen
              <input v-model.number="videoForm.chaofen" type="number" />
            </label>
            <label>
              watermark_switch
              <input v-model.number="videoForm.watermarkSwitch" type="number" />
            </label>
            <label>
              pn
              <input v-model.number="videoForm.pn" type="number" />
            </label>
          </div>

          <button class="primary" type="button" @click="submitTask" :disabled="!canSubmit">
            提交生成
          </button>
          <button class="secondary" type="button" @click="stopPolling" :disabled="!isPolling">
            停止轮询
          </button>
        </section>

        <section class="panel-section compact">
          <div class="section-title">
            <h2>TTS 试听</h2>
            <span>官方 /v1/invoke</span>
          </div>
          <textarea v-model="ttsForm.text" rows="3" placeholder="输入要合成的文本"></textarea>
          <input v-model="ttsForm.referenceAudio" placeholder="reference_audio，来自训练结果" />
          <input v-model="ttsForm.referenceText" placeholder="reference_text，来自训练结果" />
          <button class="secondary" type="button" @click="synthesizeTtsPreview">
            生成试听音频
          </button>
          <audio v-if="ttsAudioUrl" :src="ttsAudioUrl" controls></audio>
        </section>
      </aside>
    </section>

    <section class="settings-grid">
      <div class="settings">
        <div class="section-title">
          <h2>API 配置</h2>
          <span>默认走 Vite 代理，避免 8383 跨域</span>
        </div>
        <label>
          Video API Base
          <input v-model="config.videoApiBase" placeholder="/duix-video/easy" />
        </label>
        <label>
          TTS API Base
          <input v-model="config.ttsApiBase" placeholder="/duix-tts" />
        </label>
        <label>
          Result Video Base URL
          <input v-model="config.outputBaseUrl" placeholder="http://154.93.109.240:8383" />
        </label>
        <label>
          Poll Interval(ms)
          <input v-model.number="config.pollInterval" type="number" min="1000" step="500" />
        </label>
      </div>

      <div class="events">
        <div class="section-title">
          <h2>事件日志</h2>
          <span>接口响应</span>
        </div>
        <div class="event-list">
          <article v-for="event in events" :key="event.id">
            <time>{{ event.time }}</time>
            <strong>{{ event.name }}</strong>
            <span>{{ event.detail }}</span>
          </article>
          <p v-if="events.length === 0" class="muted">暂无事件</p>
        </div>
      </div>
    </section>
  </main>
</template>
