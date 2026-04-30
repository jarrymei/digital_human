export function createTaskCode() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID()
  }
  return `duix-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export async function submitVideoTask(baseUrl, payload) {
  const response = await fetch(joinUrl(baseUrl, '/submit'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  return parseJsonResponse(response, '提交视频合成任务失败')
}

export async function queryVideoTask(baseUrl, code) {
  const url = new URL(joinUrl(baseUrl, '/query'), window.location.origin)
  url.searchParams.set('code', code)

  const response = await fetch(url.toString())
  return parseJsonResponse(response, '查询视频合成进度失败')
}

export async function synthesizeSpeech(baseUrl, payload) {
  const response = await fetch(joinUrl(baseUrl, '/v1/invoke'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || `语音合成失败：${response.status}`)
  }

  return response.blob()
}

export function resolveResultVideoUrl(outputBaseUrl, resultPath) {
  if (!resultPath) return ''
  if (/^https?:\/\//i.test(resultPath)) return resultPath

  const normalizedBase = outputBaseUrl.replace(/\/$/, '')
  const normalizedPath = resultPath.startsWith('/') ? resultPath : `/${resultPath}`
  return `${normalizedBase}${normalizedPath}`
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

async function parseJsonResponse(response, fallbackMessage) {
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(payload?.msg || payload?.message || `${fallbackMessage}：${response.status}`)
  }

  return payload
}
