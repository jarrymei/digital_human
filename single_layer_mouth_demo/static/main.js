// 获取页面中的 canvas 元素。
// 它是数字人头像的绘制区域。
const canvas = document.getElementById("canvas")
// 隐藏的 video 元素专门给 MediaPipe 读取摄像头帧使用。
// 页面上不展示它，但它是关键点检测的数据来源。
const cameraInput = document.getElementById("camera-input")
// 用于在“音频驱动”和“摄像头关键点驱动”之间切换。
const cameraToggleButton = document.getElementById("camera-toggle")
// 页面上的状态文案，用来提示当前驱动模式。
const driverStatus = document.getElementById("driver-status")
const roiXInput = document.getElementById("tune-roi-x")
const roiYInput = document.getElementById("tune-roi-y")
const roiWidthInput = document.getElementById("tune-roi-width")
const roiHeightInput = document.getElementById("tune-roi-height")
const contourHeightInput = document.getElementById("tune-contour-height")
const contourWidthInput = document.getElementById("tune-contour-width")
const segmentCountInput = document.getElementById("tune-segment-count")
const splitStrengthInput = document.getElementById("tune-split-strength")
const bulgeStrengthInput = document.getElementById("tune-bulge-strength")
// 调试面板，用于实时观察嘴型分类和连续参数。
const debugPanel = document.getElementById("debug-panel")

// 获取 2D 绘图上下文。
const ctx = canvas.getContext("2d")

// 创建头像底图对象。
const avatarImage = new Image()
avatarImage.src = "/static/avatar.png"

// 阶段 1：先实现固定嘴部 ROI + 真人嘴型素材绘制。
// 这里不做人脸检测，先把嘴巴区域写死，方便理解渲染流程。
const mouthROI = {
  x: 125,
  y: 125,
  width: 48,
  height: 21,
}

// 是否显示嘴部 ROI 调试框。
// 学习阶段可以保留这个开关，后面微调坐标时很有用。
const SHOW_MOUTH_ROI = false

// 嘴型素材定义。
// key 是代码里使用的状态名，path 是实际素材路径。
const mouthAssetPaths = {
  m: "/static/mouth/m.png",
  a: "/static/mouth/a.png",
  ai: "/static/mouth/ai.png",
  e: "/static/mouth/e.png",
  ee: "/static/mouth/ee.png",
  i: "/static/mouth/i.png",
  o: "/static/mouth/o.png",
  ou: "/static/mouth/ou.png",
  smile: "/static/mouth/smile.png",
  u: "/static/mouth/u.png",
}

// 保存所有预加载完成的嘴型图片。
const mouthImages = {}

// 保留当前播放中的音频对象。
// 这样再次点击按钮时，可以先终止旧播放，避免状态叠加。
let currentAudio = null

// 用于标识当前是哪一轮播放。
// 如果用户快速重复点击，旧循环会自动失效。
let playbackSessionId = 0

// 统计资源加载情况。
let avatarLoaded = false
let mouthAssetsLoaded = false
let renderLoopStarted = false
// FaceMesh 是 MediaPipe 的人脸关键点模型实例。
let faceMesh = null
// Camera 是 MediaPipe 自带的摄像头采集封装。
let mediapipeCamera = null
// cameraDriving 表示当前是否正在使用摄像头关键点驱动嘴型。
let cameraDriving = false
let saveConfigTimer = null
let latestDebugState = {
  source: "idle",
  shape: "m",
  metrics: null,
  contour: null,
  audioFeatures: null,
  pose: {
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    openness: 0,
    roundness: 0,
    widthness: 0,
  },
}

const tuning = {
  roiX: Number(roiXInput.value),
  roiY: Number(roiYInput.value),
  roiWidth: Number(roiWidthInput.value),
  roiHeight: Number(roiHeightInput.value),
  contourHeightScale: Number(contourHeightInput.value),
  contourWidthScale: Number(contourWidthInput.value),
  segmentCount: Number(segmentCountInput.value),
  splitStrength: Number(splitStrengthInput.value),
  bulgeStrength: Number(bulgeStrengthInput.value),
}

// mouthRenderer 只负责“怎么画嘴巴”。
// 它不关心嘴型为什么改变，只关心当前要显示哪个嘴型，以及如何平滑过渡。
const mouthRenderer = {
  currentShape: "m",
  targetShape: "m",
  transitionProgress: 1,
  transitionSpeed: 0.18,
  currentPose: {
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    openness: 0,
    roundness: 0,
    widthness: 0,
  },
  targetPose: {
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    openness: 0,
    roundness: 0,
    widthness: 0,
  },
  currentContour: null,
  targetContour: null,
  poseSmoothing: 0.22,

  setShape(nextShape) {
    // 如果目标素材不存在，直接忽略，避免渲染层进入无效状态。
    if (!mouthImages[nextShape]) {
      return
    }

    // 目标没变时不重新触发过渡，避免同一状态重复闪烁。
    if (nextShape === this.targetShape) {
      return
    }

    // 切换时，把当前“屏幕上可见的状态”作为旧状态保留下来，
    // 再把新状态设为目标状态，随后由 tick() 推进过渡进度。
    this.currentShape = this.getVisibleShape()
    this.targetShape = nextShape
    this.transitionProgress = 0
  },

  setPose(nextPose) {
    this.targetPose = {
      scaleX: nextPose.scaleX ?? 1,
      scaleY: nextPose.scaleY ?? 1,
      offsetX: nextPose.offsetX ?? 0,
      offsetY: nextPose.offsetY ?? 0,
      openness: nextPose.openness ?? 0,
      roundness: nextPose.roundness ?? 0,
      widthness: nextPose.widthness ?? 0,
    }
  },

  setContour(nextContour) {
    this.targetContour = nextContour
  },

  reset() {
    this.currentShape = "m"
    this.targetShape = "m"
    this.transitionProgress = 1
    this.currentPose = {
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      openness: 0,
      roundness: 0,
      widthness: 0,
    }
    this.targetPose = {
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      openness: 0,
      roundness: 0,
      widthness: 0,
    }
    this.currentContour = null
    this.targetContour = null
  },

  tick() {
    // 每一帧推进一点过渡进度。
    // 这里是时间离散版动画，不是基于真实时间戳的插值。
    if (this.transitionProgress < 1) {
      this.transitionProgress = Math.min(
        1,
        this.transitionProgress + this.transitionSpeed
      )
    }

    // 除了离散的嘴型状态，还平滑推进一组连续姿态参数。
    // 这一步是 B1：让嘴贴片在状态切换之外还能有轻微连续形变。
    this.currentPose.scaleX +=
      (this.targetPose.scaleX - this.currentPose.scaleX) * this.poseSmoothing
    this.currentPose.scaleY +=
      (this.targetPose.scaleY - this.currentPose.scaleY) * this.poseSmoothing
    this.currentPose.offsetX +=
      (this.targetPose.offsetX - this.currentPose.offsetX) * this.poseSmoothing
    this.currentPose.offsetY +=
      (this.targetPose.offsetY - this.currentPose.offsetY) * this.poseSmoothing
    this.currentPose.openness +=
      (this.targetPose.openness - this.currentPose.openness) * this.poseSmoothing
    this.currentPose.roundness +=
      (this.targetPose.roundness - this.currentPose.roundness) * this.poseSmoothing
    this.currentPose.widthness +=
      (this.targetPose.widthness - this.currentPose.widthness) * this.poseSmoothing

    this.currentContour = interpolateContour(
      this.currentContour,
      this.targetContour,
      this.poseSmoothing
    )
  },

  getVisibleShape() {
    return this.transitionProgress >= 1 ? this.targetShape : this.currentShape
  },

  draw() {
    const fromImage = mouthImages[this.currentShape]
    const toImage = mouthImages[this.targetShape]

    if (!fromImage || !toImage) {
      return
    }

    // 当嘴型切换时，用交叉淡入淡出替代“瞬间跳图”。
    // 这不是几何形变，但视觉上会柔和很多，适合当前贴片方案。
    if (this.transitionProgress < 1 && this.currentShape !== this.targetShape) {
      ctx.save()
      ctx.globalAlpha = 1 - this.transitionProgress
      drawMouthImage(fromImage, this.currentPose)
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = this.transitionProgress
      drawMouthImage(toImage, this.currentPose)
      ctx.restore()
      return
    }

    drawMouthImage(toImage, this.currentPose)
  },
}

// mouthDriver 只负责“嘴型为什么变化”。
// 当前这一版支持两种输入源：
// 1. audio：根据音频频谱特征推断嘴型
// 2. landmarks：根据真实嘴部关键点参数推断嘴型
//
// 它的输出始终都是“嘴型状态名”，例如 m / a / i / o。
// 最终怎么画出来，由 mouthRenderer 决定。
const mouthDriver = {
  defaultShape: "m",
  mode: "audio",

  reset() {
    mouthRenderer.reset()
  },

  setMode(mode) {
    // mode 只是控制“当前由谁驱动嘴型”，不直接负责采集数据。
    this.mode = mode
    setDriverStatus(
      mode === "landmarks" ? "当前模式：摄像头关键点驱动" : "当前模式：音频驱动"
    )
  },

  setShape(shape) {
    mouthRenderer.setShape(shape)
  },

  setPose(pose) {
    mouthRenderer.setPose(pose)
  },

  setContour(contour) {
    mouthRenderer.setContour(contour)
  },

  // 从一帧音频特征中估算嘴型。
  // 这里不用严格音素识别，而是用能量、频谱重心和频段分布做近似分类。
  shapeFromAudioFeatures(features) {
    const {
      rms,
      normalizedCentroid,
      lowRatio,
      midRatio,
      highRatio,
      openness,
    } = features

    if (rms < 0.02) {
      return "m"
    }

    // 高频占比高且频谱重心偏上，更接近 i / ee。
    if (highRatio > lowRatio * 1.15 && normalizedCentroid > 0.58) {
      return openness > 0.45 ? "ee" : "i"
    }

    // 低频更强且高频较弱，更接近圆唇 o / u。
    if (lowRatio > highRatio * 1.18 && normalizedCentroid < 0.42) {
      return openness > 0.52 ? "o" : "u"
    }

    // 中频占比较高时，优先认为是 e / ai / a 这一类。
    if (midRatio > 0.42 && normalizedCentroid > 0.46 && normalizedCentroid < 0.62) {
      if (openness > 0.64) {
        return "a"
      }
      if (openness > 0.4) {
        return "ai"
      }
      return "e"
    }

    if (openness < 0.24) {
      return "e"
    }

    if (openness < 0.48) {
      return "ai"
    }

    return "a"
  },

  poseFromAudioFeatures(features) {
    const { openness, lowRatio, highRatio, normalizedCentroid } = features
    const roundness = clamp((lowRatio - highRatio) * 1.6 + (0.45 - normalizedCentroid), 0, 1)
    const widthness = clamp((highRatio - lowRatio) * 1.7 + (normalizedCentroid - 0.45), 0, 1)

    return {
      scaleX: 1 + widthness * 0.12 - roundness * 0.08,
      scaleY: 1 + openness * 0.42,
      offsetX: 0,
      offsetY: openness * 4,
      openness,
      roundness,
      widthness,
    }
  },

  // 从真实嘴部关键点提取的参数中估算嘴型。
  // 这是 B0 阶段的核心：先把“关键点 -> 嘴型状态”跑通，
  // 暂时还不做网格形变或贴图 warp。
  shapeFromLandmarks(metrics) {
    const { openRatio, widthRatio, roundRatio } = metrics

    // openRatio：上下唇张开的相对程度
    // widthRatio：嘴巴偏横向拉伸还是偏紧凑
    // roundRatio：嘴型是否更接近圆唇
    if (openRatio < 0.12) {
      return "m"
    }

    if (roundRatio > 0.68) {
      return openRatio > 0.3 ? "o" : "u"
    }

    if (widthRatio > 2.7) {
      return openRatio > 0.22 ? "ee" : "i"
    }

    if (openRatio > 0.34) {
      return "a"
    }

    if (openRatio > 0.24) {
      return "ai"
    }

    return "e"
  },

  poseFromLandmarks(metrics) {
    const { openRatio, widthRatio, roundRatio } = metrics
    const openness = clamp((openRatio - 0.08) / 0.32, 0, 1)
    const widthness = clamp((widthRatio - 1.9) / 1.2, 0, 1)
    const roundness = clamp((roundRatio - 0.28) / 0.5, 0, 1)

    return {
      scaleX: 1 + widthness * 0.18 - roundness * 0.1,
      scaleY: 1 + openness * 0.5,
      offsetX: 0,
      offsetY: openness * 5,
      openness,
      roundness,
      widthness,
    }
  },
}

avatarImage.onload = () => {
  avatarLoaded = true
  startRenderLoopIfReady()
}

// 预加载所有嘴型素材。
function loadMouthAssets() {
  const entries = Object.entries(mouthAssetPaths)
  let loadedCount = 0

  entries.forEach(([name, path]) => {
    const image = new Image()
    image.onload = () => {
      mouthImages[name] = image
      loadedCount += 1

      if (loadedCount === entries.length) {
        mouthAssetsLoaded = true
        startRenderLoopIfReady()
      }
    }
    image.src = path
  })
}

function startRenderLoopIfReady() {
  // 必须等头像和嘴型素材都准备好，才启动渲染循环。
  // 否则第一帧可能出现空白或局部缺失。
  if (avatarLoaded && mouthAssetsLoaded && !renderLoopStarted) {
    renderLoopStarted = true
    draw()
  }
}

function draw() {
  // 先推进过渡，再画当前帧。
  mouthRenderer.tick()

  // 清空上一帧。
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // 先绘制底图。
  ctx.drawImage(avatarImage, 0, 0, canvas.width, canvas.height)

  // 再把当前嘴型素材叠加到固定嘴部 ROI 上。
  mouthRenderer.draw()

  if (SHOW_MOUTH_ROI) {
    ctx.strokeStyle = "rgba(255, 0, 0, 0.8)"
    ctx.lineWidth = 1
    ctx.strokeRect(mouthROI.x, mouthROI.y, mouthROI.width, mouthROI.height)
  }

  requestAnimationFrame(draw)
}

function drawMouthImage(mouthImage, pose = defaultPose()) {
  // 所有嘴型贴片都统一绘制到同一个 ROI 区域。
  // B1 开始引入轻微连续参数：
  // - scaleX: 横向拉伸
  // - scaleY: 竖向开合
  // - offsetY: 开口时略微下移，减少“贴片悬空感”
  //
  // B2 再往前走一步：
  // 不再整张图一次性缩放，而是切成多条横向条带分别绘制。
  // 每一条都可拥有不同的宽度和上下位移，形成最小的局部网格/裁剪形变效果。
  const drawWidth = mouthROI.width * pose.scaleX
  const drawHeight = mouthROI.height * pose.scaleY
  const drawX = mouthROI.x + (mouthROI.width - drawWidth) / 2 + pose.offsetX
  const drawY = mouthROI.y + (mouthROI.height - drawHeight) / 2 + pose.offsetY
  const segmentCount = tuning.segmentCount
  const sourceSliceHeight = mouthImage.height / segmentCount
  const targetSliceHeight = drawHeight / segmentCount
  const baseSliceOverlap = Math.max(0.8, targetSliceHeight * 0.12)

  ctx.save()

  if (mouthRenderer.currentContour && mouthRenderer.currentContour.length > 2) {
    applyContourClip(drawX, drawY, drawWidth, drawHeight, mouthRenderer.currentContour)
  }

  for (let i = 0; i < segmentCount; i++) {
    const t = segmentCount === 1 ? 0.5 : i / (segmentCount - 1)
    const centerWeight = cosineBell(t)
    const lipEdgeWeight = 1 - centerWeight
    const signedOffset = t - 0.5
    const upperWeight = t < 0.5 ? cosineBell(t * 2) : 0
    const lowerWeight = t > 0.5 ? cosineBell((1 - t) * 2) : 0
    const cornerLock = smoothstep(0.72, 1, lipEdgeWeight)
    const seamBridge = smoothstep(0, 0.22, centerWeight)

    const localScaleX =
      1 +
      pose.widthness * 0.11 * centerWeight -
      pose.roundness * (0.06 * centerWeight + 0.1 * lipEdgeWeight)

    const lockedScaleX = 1 + (localScaleX - 1) * (1 - cornerLock * 0.88)
    const sliceWidth = drawWidth * lockedScaleX
    const sliceX = drawX + (drawWidth - sliceWidth) / 2

    const splitAmount =
      pose.openness * drawHeight * tuning.splitStrength * 0.52
    const bridgedSplitAmount = splitAmount * (1 - seamBridge * 0.78)
    const upperLift = -upperWeight * bridgedSplitAmount
    const lowerDrop = lowerWeight * bridgedSplitAmount
    const centerBulgeY =
      centerWeight * pose.openness * drawHeight * tuning.bulgeStrength * 0.72
    const seamSoftening = signedOffset * pose.openness * drawHeight * 0.008
    const sliceOverlap = baseSliceOverlap + centerWeight * targetSliceHeight * 0.28
    const sliceY =
      drawY +
      i * targetSliceHeight +
      upperLift +
      lowerDrop +
      centerBulgeY +
      seamSoftening -
      sliceOverlap / 2

    ctx.drawImage(
      mouthImage,
      0,
      i * sourceSliceHeight,
      mouthImage.width,
      sourceSliceHeight,
      sliceX,
      sliceY,
      sliceWidth,
      targetSliceHeight + sliceOverlap
    )
  }

  ctx.restore()
}

function setDriverStatus(text) {
  driverStatus.textContent = text
}

function updateDebugPanel() {
  const metrics = latestDebugState.metrics
  const pose = latestDebugState.pose

  const lines = [
    `数据源: ${formatSourceLabel(latestDebugState.source)}`,
    `驱动模式: ${formatModeLabel(mouthDriver.mode)}`,
    `当前嘴型: ${latestDebugState.shape}`,
    `可见嘴型: ${mouthRenderer.getVisibleShape()}`,
    `目标嘴型: ${mouthRenderer.targetShape}`,
    `过渡进度: ${formatNumber(mouthRenderer.transitionProgress)}`,
    `横向缩放: ${formatNumber(pose.scaleX)}`,
    `纵向缩放: ${formatNumber(pose.scaleY)}`,
    `横向偏移: ${formatNumber(pose.offsetX)}`,
    `纵向偏移: ${formatNumber(pose.offsetY)}`,
    `开口强度: ${formatNumber(pose.openness)}`,
    `圆唇强度: ${formatNumber(pose.roundness)}`,
    `扁嘴强度: ${formatNumber(pose.widthness)}`,
    `轮廓点数: ${latestDebugState.contour ? latestDebugState.contour.length : 0}`,
    `ROI X: ${tuning.roiX}`,
    `ROI Y: ${tuning.roiY}`,
    `ROI 宽度: ${tuning.roiWidth}`,
    `ROI 高度: ${tuning.roiHeight}`,
    `轮廓高度: ${formatNumber(tuning.contourHeightScale)}`,
    `轮廓宽度: ${formatNumber(tuning.contourWidthScale)}`,
    `条带数量: ${tuning.segmentCount}`,
    `上下错位: ${formatNumber(tuning.splitStrength)}`,
    `中部鼓起: ${formatNumber(tuning.bulgeStrength)}`,
  ]

  if (metrics) {
    lines.push(`开口比例: ${formatNumber(metrics.openRatio)}`)
    lines.push(`横向比例: ${formatNumber(metrics.widthRatio)}`)
    lines.push(`圆唇比例: ${formatNumber(metrics.roundRatio)}`)
  }

  if (latestDebugState.audioFeatures) {
    lines.push(`音频 RMS: ${formatNumber(latestDebugState.audioFeatures.rms)}`)
    lines.push(`频谱质心: ${formatNumber(latestDebugState.audioFeatures.normalizedCentroid)}`)
    lines.push(`低频占比: ${formatNumber(latestDebugState.audioFeatures.lowRatio)}`)
    lines.push(`中频占比: ${formatNumber(latestDebugState.audioFeatures.midRatio)}`)
    lines.push(`高频占比: ${formatNumber(latestDebugState.audioFeatures.highRatio)}`)
  }

  debugPanel.textContent = lines.join("\n")
}

function setDebugState(nextState) {
  latestDebugState = {
    ...latestDebugState,
    ...nextState,
  }
  updateDebugPanel()
}

function speak() {
  const text = document.getElementById("text").value.trim()

  if (!text) {
    return
  }

  // 如果上一次音频还在播放，先停止它。
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
  }

  // 手动点击 TTS 时，优先切回音频驱动。
  // 否则摄像头关键点和音频会同时竞争 mouthRenderer 的状态控制权。
  mouthDriver.setMode("audio")
  mouthDriver.reset()
  setDebugState({
    source: "audio",
    shape: "m",
    metrics: null,
    contour: null,
    audioFeatures: null,
    pose: defaultPose(),
  })

  fetch(`/tts?text=${encodeURIComponent(text)}`)
    .then(res => res.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)

      currentAudio = audio
      // sessionId 用来废弃旧播放的动画循环。
      // 只要开始了新一轮播放，旧循环就应该停止。
      playbackSessionId += 1
      const sessionId = playbackSessionId

      audio.play()
      animateMouth(audio, sessionId)

      audio.addEventListener("ended", () => {
        mouthDriver.reset()
        URL.revokeObjectURL(url)

        if (currentAudio === audio) {
          currentAudio = null
        }
      })
    })
}

// 第一阶段先用“音频能量 -> 真人嘴型素材”的方式驱动。
// 这一步先验证真实嘴型渲染链路是否成立，不追求严格音素同步。
function animateMouth(audio, sessionId) {
  // Web Audio API 的基础链路：
  // audio 元素 -> analyser -> 扬声器
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const analyser = audioCtx.createAnalyser()
  const source = audioCtx.createMediaElementSource(audio)
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.7

  source.connect(analyser)
  analyser.connect(audioCtx.destination)

  const frequencyData = new Uint8Array(analyser.frequencyBinCount)
  const timeData = new Uint8Array(analyser.fftSize)

  function update() {
    // 如果这已经不是当前播放会话，就立刻停止旧循环。
    if (sessionId !== playbackSessionId) {
      mouthDriver.reset()
      audioCtx.close()
      return
    }

    analyser.getByteFrequencyData(frequencyData)
    analyser.getByteTimeDomainData(timeData)

    const audioFeatures = extractAudioFeatures(frequencyData, timeData)
    const nextShape = mouthDriver.shapeFromAudioFeatures(audioFeatures)
    const nextPose = mouthDriver.poseFromAudioFeatures(audioFeatures)
    mouthDriver.setShape(nextShape)
    mouthDriver.setPose(nextPose)
    mouthDriver.setContour(null)
    setDebugState({
      source: "audio",
      shape: nextShape,
      metrics: null,
      contour: null,
      audioFeatures,
      pose: nextPose,
    })

    if (!audio.paused) {
      requestAnimationFrame(update)
    } else {
      mouthDriver.reset()
      setDebugState({
        source: "audio-ended",
        shape: "m",
        metrics: null,
        contour: null,
        audioFeatures: null,
        pose: defaultPose(),
      })
      audioCtx.close()
    }
  }

  update()
}

function initCameraDriver() {
  // FaceMesh 会输出整张脸的关键点，这里我们只取嘴部相关点。
  faceMesh = new FaceMesh({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  })

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })

  faceMesh.onResults(handleFaceMeshResults)
}

async function toggleCameraDrive() {
  // 再次点击时关闭摄像头驱动。
  if (cameraDriving) {
    stopCameraDrive()
    return
  }

  try {
    if (!faceMesh) {
      initCameraDriver()
    }

    // MediaPipe Camera 会不断把 video 当前帧送给 FaceMesh。
    mediapipeCamera = new Camera(cameraInput, {
      onFrame: async () => {
        if (cameraDriving) {
          await faceMesh.send({ image: cameraInput })
        }
      },
      width: 320,
      height: 240,
    })

    cameraDriving = true
    await mediapipeCamera.start()
    mouthDriver.setMode("landmarks")
    cameraToggleButton.textContent = "关闭摄像头驱动"
  } catch (error) {
    cameraDriving = false
    console.error(error)
    setDriverStatus("摄像头启动失败，请检查浏览器权限")
  }
}

function stopCameraDrive() {
  cameraDriving = false
  mouthDriver.setMode("audio")
  mouthDriver.reset()
  cameraToggleButton.textContent = "开启摄像头驱动"
  setDebugState({
    source: "camera-stopped",
    shape: "m",
    metrics: null,
    contour: null,
    audioFeatures: null,
    pose: defaultPose(),
  })

  // 关闭浏览器摄像头流，释放硬件资源。
  const stream = cameraInput.srcObject
  if (stream) {
    stream.getTracks().forEach(track => track.stop())
    cameraInput.srcObject = null
  }

  mediapipeCamera = null
}

function handleFaceMeshResults(results) {
  // 只有在摄像头驱动模式下，才接管嘴型控制。
  if (!cameraDriving || mouthDriver.mode !== "landmarks") {
    return
  }

  const landmarks = results.multiFaceLandmarks?.[0]
  // 没检测到脸时，退回闭嘴状态。
  if (!landmarks) {
    mouthDriver.setShape("m")
    mouthDriver.setPose(defaultPose())
    mouthDriver.setContour(null)
    setDebugState({
      source: "landmarks-no-face",
      shape: "m",
      metrics: null,
      contour: null,
      audioFeatures: null,
      pose: defaultPose(),
    })
    return
  }

  const metrics = getMouthMetrics(landmarks)
  const contour = getMouthContour(landmarks)
  const nextShape = mouthDriver.shapeFromLandmarks(metrics)
  const nextPose = mouthDriver.poseFromLandmarks(metrics)
  mouthDriver.setShape(nextShape)
  mouthDriver.setPose(nextPose)
  mouthDriver.setContour(contour)
  setDebugState({
    source: "landmarks",
    shape: nextShape,
    metrics,
    contour,
    audioFeatures: null,
    pose: nextPose,
  })
}

function getMouthMetrics(landmarks) {
  
  // 这里取的是 MediaPipe FaceMesh 的标准关键点编号：
  // - 13 / 14：上下唇中点
  // - 61 / 291：左右嘴角
  // - 0：人中附近，用作一个粗略的垂直基准
  const upperLip = landmarks[13]
  const lowerLip = landmarks[14]
  const leftCorner = landmarks[61]
  const rightCorner = landmarks[291]
  const philtrum = landmarks[0]

  const mouthOpen = distance(upperLip, lowerLip)
  const mouthWidth = distance(leftCorner, rightCorner)
  const mouthHeightBase = distance(philtrum, lowerLip)

  // 这里不用绝对像素，而是用比例。
  // 这样能减弱用户离镜头远近变化带来的影响。
  const openRatio = mouthWidth > 0 ? mouthOpen / mouthWidth : 0
  const widthRatio = mouthWidth / Math.max(mouthHeightBase, 0.001)
  const roundRatio = mouthOpen / Math.max(mouthHeightBase, 0.001)

  return {
    openRatio,
    widthRatio,
    roundRatio,
  }
}

function extractAudioFeatures(frequencyData, timeData) {
  let totalEnergy = 0
  let weightedIndex = 0
  let lowEnergy = 0
  let midEnergy = 0
  let highEnergy = 0

  for (let i = 0; i < frequencyData.length; i++) {
    const value = frequencyData[i]
    totalEnergy += value
    weightedIndex += value * i

    if (i < frequencyData.length * 0.22) {
      lowEnergy += value
    } else if (i < frequencyData.length * 0.62) {
      midEnergy += value
    } else {
      highEnergy += value
    }
  }

  let rmsAccumulator = 0
  for (let i = 0; i < timeData.length; i++) {
    const normalized = (timeData[i] - 128) / 128
    rmsAccumulator += normalized * normalized
  }

  const rms = Math.sqrt(rmsAccumulator / timeData.length)
  const normalizedCentroid =
    totalEnergy > 0 ? weightedIndex / totalEnergy / Math.max(frequencyData.length - 1, 1) : 0
  const lowRatio = totalEnergy > 0 ? lowEnergy / totalEnergy : 0
  const midRatio = totalEnergy > 0 ? midEnergy / totalEnergy : 0
  const highRatio = totalEnergy > 0 ? highEnergy / totalEnergy : 0
  const openness = clamp((rms - 0.018) / 0.11, 0, 1)

  return {
    rms,
    normalizedCentroid,
    lowRatio,
    midRatio,
    highRatio,
    openness,
  }
}

function getMouthContour(landmarks) {
  // 外唇轮廓关键点，按顺时针近似排列。
  const contourIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
  const leftCorner = landmarks[61]
  const rightCorner = landmarks[291]
  const upperLip = landmarks[13]
  const lowerLip = landmarks[14]
  const width = Math.max(distance(leftCorner, rightCorner) * tuning.contourWidthScale, 0.001)
  const height = Math.max(distance(upperLip, lowerLip) * tuning.contourHeightScale, 0.001)
  const centerX = (leftCorner.x + rightCorner.x) / 2
  const centerY = (upperLip.y + lowerLip.y) / 2

  return contourIndices.map(index => {
    const point = landmarks[index]
    const normalizedX = clamp((point.x - centerX) / width + 0.5, 0, 1)
    const normalizedY = clamp((point.y - centerY) / height + 0.5, 0, 1)

    // 让嘴角更稳定，同时把上下两端略微向中心收缩，
    // 这样轮廓会更接近“中间饱满、上下收敛”的嘴唇形态。
    const verticalCenterWeight = cosineBell(normalizedY)
    const cornerDistance = Math.abs(normalizedX - 0.5) * 2
    const cornerAnchor = smoothstep(0.76, 1, cornerDistance)
    const xTowardCenter = 0.5 + (normalizedX - 0.5) * (0.82 + verticalCenterWeight * 0.18)
    const blendedX = xTowardCenter * (1 - cornerAnchor) + normalizedX * cornerAnchor

    return { x: blendedX, y: normalizedY }
  }).map(point => ({
    x: clamp(point.x, 0, 1),
    y: clamp(point.y, 0, 1),
  }))
}

function applyContourClip(drawX, drawY, drawWidth, drawHeight, contour) {
  ctx.beginPath()

  contour.forEach((point, index) => {
    const x = drawX + point.x * drawWidth
    const y = drawY + point.y * drawHeight

    if (index === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  })

  ctx.closePath()
  ctx.clip()
}

function distance(a, b) {
  // 关键点是归一化坐标，这里算的是归一化平面上的欧氏距离。
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1)
  return t * t * (3 - 2 * t)
}

function cosineBell(value) {
  const t = clamp(value, 0, 1)
  return 0.5 - 0.5 * Math.cos(Math.PI * t)
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "-"
}

function formatModeLabel(mode) {
  if (mode === "landmarks") {
    return "摄像头关键点"
  }

  if (mode === "audio") {
    return "语音驱动"
  }

  return mode
}

function formatSourceLabel(source) {
  const sourceMap = {
    idle: "空闲",
    audio: "语音分析",
    "audio-ended": "语音结束",
    landmarks: "关键点跟踪",
    "landmarks-no-face": "未检测到人脸",
    "camera-stopped": "摄像头已关闭",
  }

  return sourceMap[source] || source
}

function interpolateContour(currentContour, targetContour, factor) {
  if (!targetContour) {
    return null
  }

  if (!currentContour || currentContour.length !== targetContour.length) {
    return targetContour.map(point => ({ ...point }))
  }

  return currentContour.map((point, index) => ({
    x: point.x + (targetContour[index].x - point.x) * factor,
    y: point.y + (targetContour[index].y - point.y) * factor,
  }))
}

function defaultPose() {
  return {
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    openness: 0,
    roundness: 0,
    widthness: 0,
  }
}

function syncTuningFromInputs() {
  tuning.roiX = Number(roiXInput.value)
  tuning.roiY = Number(roiYInput.value)
  tuning.roiWidth = Number(roiWidthInput.value)
  tuning.roiHeight = Number(roiHeightInput.value)
  mouthROI.x = tuning.roiX
  mouthROI.y = tuning.roiY
  mouthROI.width = tuning.roiWidth
  mouthROI.height = tuning.roiHeight
  tuning.contourHeightScale = Number(contourHeightInput.value)
  tuning.contourWidthScale = Number(contourWidthInput.value)
  tuning.segmentCount = Number(segmentCountInput.value)
  tuning.splitStrength = Number(splitStrengthInput.value)
  tuning.bulgeStrength = Number(bulgeStrengthInput.value)
  updateDebugPanel()
  scheduleConfigSave()
}

function getCurrentConfig() {
  return {
    roiX: tuning.roiX,
    roiY: tuning.roiY,
    roiWidth: tuning.roiWidth,
    roiHeight: tuning.roiHeight,
    contourHeightScale: tuning.contourHeightScale,
    contourWidthScale: tuning.contourWidthScale,
    segmentCount: tuning.segmentCount,
    splitStrength: tuning.splitStrength,
    bulgeStrength: tuning.bulgeStrength,
  }
}

function applyConfig(config) {
  roiXInput.value = String(config.roiX)
  roiYInput.value = String(config.roiY)
  roiWidthInput.value = String(config.roiWidth)
  roiHeightInput.value = String(config.roiHeight)
  contourHeightInput.value = String(config.contourHeightScale)
  contourWidthInput.value = String(config.contourWidthScale)
  segmentCountInput.value = String(config.segmentCount)
  splitStrengthInput.value = String(config.splitStrength)
  bulgeStrengthInput.value = String(config.bulgeStrength)
  syncTuningFromInputs()
}

async function loadConfigFromServer() {
  try {
    const response = await fetch("/config")
    if (!response.ok) {
      throw new Error(`load config failed: ${response.status}`)
    }

    const config = await response.json()
    applyConfig(config)
  } catch (error) {
    console.error(error)
  }
}

function scheduleConfigSave() {
  if (saveConfigTimer) {
    clearTimeout(saveConfigTimer)
  }

  saveConfigTimer = setTimeout(() => {
    saveConfigTimer = null
    saveConfigToServer()
  }, 250)
}

async function saveConfigToServer() {
  try {
    await fetch("/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(getCurrentConfig()),
    })
  } catch (error) {
    console.error(error)
  }
}

loadMouthAssets()
cameraToggleButton.addEventListener("click", toggleCameraDrive)
roiXInput.addEventListener("input", syncTuningFromInputs)
roiYInput.addEventListener("input", syncTuningFromInputs)
roiWidthInput.addEventListener("input", syncTuningFromInputs)
roiHeightInput.addEventListener("input", syncTuningFromInputs)
contourHeightInput.addEventListener("input", syncTuningFromInputs)
contourWidthInput.addEventListener("input", syncTuningFromInputs)
segmentCountInput.addEventListener("input", syncTuningFromInputs)
splitStrengthInput.addEventListener("input", syncTuningFromInputs)
bulgeStrengthInput.addEventListener("input", syncTuningFromInputs)
updateDebugPanel()
loadConfigFromServer()
