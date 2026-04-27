/*
 * 数字人嘴型 Demo 前端主逻辑
 * ------------------------------------------------------------
 * 这个文件故意写成一个“可阅读的学习版”，没有拆成很多模块。
 * 学习时可以从上往下看，理解一个最小数字人链路如何串起来。
 *
 * 当前页面里有两条驱动链路：
 *
 * 1. 音频驱动链路
 *    用户输入文本 -> 调用后端 /tts -> 得到 mp3 -> 浏览器播放音频
 *    -> Web Audio API 分析音量/频段 -> 推断嘴型 -> Canvas 绘制嘴巴。
 *
 * 2. 摄像头关键点驱动链路
 *    浏览器打开摄像头 -> hidden video 保存实时画面
 *    -> MediaPipe FaceMesh 分析人脸关键点 -> 提取嘴部指标
 *    -> 推断嘴型和形变参数 -> Canvas 绘制嘴巴。
 *
 * 页面上还额外有一个“摄像头对照” canvas：
 * 它不参与嘴型计算，只把摄像头画面和嘴部关键点画出来，
 * 方便观察“识别到的嘴巴”与“数字人嘴巴”的对应关系。
 *
 * 代码分层思路：
 * - DOM / 资源：拿到页面元素、加载头像和嘴型素材
 * - mouthRenderer：只负责“怎么画嘴巴”
 * - mouthDriver：只负责“根据输入推断应该是什么嘴型”
 * - 音频流程：TTS 播放 + Web Audio 分析
 * - 摄像头流程：getUserMedia + FaceMesh
 * - 调参流程：读取滑块、保存配置、更新调试面板
 */

// 获取页面中的 canvas 元素。
// 它是数字人头像的绘制区域。
const canvas = document.getElementById("canvas")
// 摄像头对照画布。
// 它不负责采集摄像头，也不负责跑 FaceMesh 模型，
// 只负责把“摄像头输入 + 嘴部识别结果”画出来，方便学习和调试。
const cameraPreviewCanvas = document.getElementById("camera-preview")
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
// 摄像头对照区也是普通 canvas，所以同样使用 2D 绘图上下文。
// 后续所有画视频帧、画嘴部轮廓、画提示文字，都通过这个对象完成。
const cameraPreviewCtx = cameraPreviewCanvas.getContext("2d")

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

// 摄像头对照区中要画出的“外唇轮廓”关键点。
// 这些编号来自 MediaPipe FaceMesh 的标准人脸关键点索引。
// 它们按嘴唇外轮廓顺时针排列，所以可以直接连线形成一个闭合嘴形。
const mouthOverlayContourIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
// 摄像头对照区中额外高亮的 4 个参考点。
// 这 4 个点也是当前嘴型驱动最关心的点：
// - 13 / 14：上下唇距离，用来判断开口程度
// - 61 / 291：左右嘴角距离，用来估算嘴巴宽度
const mouthOverlayReferencePoints = [
  { index: 13, label: "上唇" },
  { index: 14, label: "下唇" },
  { index: 61, label: "左嘴角" },
  { index: 291, label: "右嘴角" },
]

// 保存所有预加载完成的嘴型图片。
// 结构类似：
// {
//   m: HTMLImageElement,
//   a: HTMLImageElement,
//   ...
// }
// 后面渲染时只按 key 取图，不再重复发起网络请求。
const mouthImages = {}

// 保留当前播放中的音频对象。
// 这样再次点击按钮时，可以先终止旧播放，避免状态叠加。
let currentAudio = null

// 用于标识当前是哪一轮播放。
// 如果用户快速重复点击，旧循环会自动失效。
let playbackSessionId = 0

// 统计资源加载情况。
// Canvas 渲染循环必须等“头像底图”和“所有嘴型素材”都加载完成后再启动。
// 如果资源还没加载完就开始 drawImage，浏览器可能画出空白。
let avatarLoaded = false
let mouthAssetsLoaded = false
let renderLoopStarted = false
// FaceMesh 是 MediaPipe 的人脸关键点模型实例。
let faceMesh = null
// 早期版本用过 MediaPipe Camera 封装；这里保留变量名，便于阅读旧代码。
let mediapipeCamera = null
// cameraDriving 表示当前是否正在使用摄像头关键点驱动嘴型。
let cameraDriving = false
// requestAnimationFrame 返回的 id。
// 关闭摄像头时用它取消下一帧分析，避免摄像头关闭后仍继续调用 FaceMesh。
let cameraFrameRequestId = null
// 浏览器 getUserMedia 返回的 MediaStream。
// 保存下来是为了关闭摄像头时可以 stop 每一个 track，释放硬件资源。
let cameraStream = null
// FaceMesh 的 send 是异步的。
// 如果上一帧还没分析完，就不要把下一帧继续塞进去，否则低性能电脑上会堆积任务。
let faceMeshSending = false
// 调参滑块变化时不立刻每一毫秒都保存到后端。
// 这个 timer 用来做简单 debounce：用户停顿一小会儿后再保存。
let saveConfigTimer = null
// 调试面板的统一数据源。
// 不管是音频驱动还是摄像头驱动，都会把当前状态写到这里，
// 然后 updateDebugPanel() 负责把这些状态格式化显示出来。
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

// 页面滑块对应的可调参数。
// 这些参数不是“业务数据”，而是学习和实验时用来观察不同绘制效果的开关。
// 调整滑块 -> 改 tuning -> 改 mouthROI 或局部形变参数 -> 下一帧绘制生效。
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
  // currentShape 表示当前屏幕上正在淡出的旧嘴型。
  // targetShape 表示当前正在淡入、最终要稳定显示的新嘴型。
  // 这两个值分开存，是为了实现嘴型切换时的交叉淡入淡出。
  currentShape: "m",
  targetShape: "m",
  // transitionProgress 范围 0-1。
  // 0 表示刚开始切换，1 表示切换完成。
  transitionProgress: 1,
  // 每一帧增加多少过渡进度。
  // 值越大，嘴型切换越快；值越小，嘴型切换越柔和。
  transitionSpeed: 0.18,
  // currentPose 是当前已经显示出来的连续形变参数。
  // targetPose 是驱动器本帧希望达到的目标参数。
  // 两者之间用插值平滑，避免嘴巴抖动。
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
  // 轮廓用于裁剪嘴型贴图。
  // 摄像头关键点模式下，嘴部轮廓会随真实嘴巴变化。
  // 音频模式下没有真实轮廓，因此通常为 null。
  currentContour: null,
  targetContour: null,
  // 姿态平滑系数。
  // 0 表示完全不追目标，1 表示瞬间跳到目标。
  // 0.22 是一个折中：响应不会太慢，也不会明显抖动。
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
    // nextPose 可能来自音频，也可能来自摄像头关键点。
    // 这里统一补默认值，让后面的绘制逻辑不用判断字段是否存在。
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
    // 这里只记录目标轮廓，不直接改 currentContour。
    // currentContour 会在 tick() 中逐帧插值过去，让嘴部裁剪轮廓也能平滑变化。
    this.targetContour = nextContour
  },

  reset() {
    // reset 用于驱动模式切换、播放结束、摄像头关闭等场景。
    // 它把渲染器恢复到闭嘴状态，避免上一种模式的嘴型残留到下一种模式。
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
    // 调试面板需要知道“当前用户实际看到的嘴型”。
    // 如果过渡完成，看到的是 targetShape；
    // 如果还在过渡中，视觉上仍然混合了 currentShape 和 targetShape。
    return this.transitionProgress >= 1 ? this.targetShape : this.currentShape
  },

  draw() {
    // 渲染层只关心图片是否存在，不关心嘴型是音频推断来的还是摄像头推断来的。
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
    // 音频只能告诉我们“声音听起来像什么”，不能直接告诉我们嘴唇位置。
    // 所以这里把音频特征转成一组近似的连续姿态：
    // - openness：声音越强，嘴巴越容易张开
    // - roundness：低频占比高时，粗略认为更接近圆唇
    // - widthness：高频占比高时，粗略认为更接近扁嘴/咧嘴
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
    // 摄像头关键点比音频更直接：
    // openRatio / widthRatio / roundRatio 已经来自真实嘴部几何关系。
    // 这里做的事情是把这些比例映射到贴图绘制需要的 scale / offset 参数。
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
  // 图片加载是异步的。
  // 只有 onload 触发后，drawImage 才能稳定把头像画到 canvas 上。
  avatarLoaded = true
  startRenderLoopIfReady()
}

// 预加载所有嘴型素材。
function loadMouthAssets() {
  // Object.entries 会把 mouthAssetPaths 变成：
  // [
  //   ["m", "/static/mouth/m.png"],
  //   ["a", "/static/mouth/a.png"],
  //   ...
  // ]
  // 这样既能知道素材路径，也能知道加载后应该存到 mouthImages 的哪个 key。
  const entries = Object.entries(mouthAssetPaths)
  let loadedCount = 0

  entries.forEach(([name, path]) => {
    const image = new Image()
    image.onload = () => {
      // 每张图加载完成后放进缓存表。
      // 后续渲染每一帧都从 mouthImages 取，不再创建新 Image。
      mouthImages[name] = image
      loadedCount += 1

      if (loadedCount === entries.length) {
        // 所有嘴型素材都加载完成后，才允许启动主渲染循环。
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
    // 调试 ROI 时使用。
    // ROI 是嘴巴贴图被绘制到头像上的固定矩形区域。
    // 如果嘴巴位置不对，可以临时把 SHOW_MOUTH_ROI 改成 true 观察红框。
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
    // 摄像头关键点模式下，会根据真实外唇轮廓裁剪嘴型贴图。
    // 这一步能减少贴图超出嘴唇区域的违和感。
    applyContourClip(drawX, drawY, drawWidth, drawHeight, mouthRenderer.currentContour)
  }

  for (let i = 0; i < segmentCount; i++) {
    // t 表示当前条带在嘴巴中的垂直位置：
    // t=0 是最上方，t=0.5 是中间，t=1 是最下方。
    const t = segmentCount === 1 ? 0.5 : i / (segmentCount - 1)
    // centerWeight 在嘴巴中间最大，在上下边缘最小。
    // 用它让中间区域变化更明显，嘴角/边缘更稳定。
    const centerWeight = cosineBell(t)
    const lipEdgeWeight = 1 - centerWeight
    const signedOffset = t - 0.5
    // upperWeight / lowerWeight 分别表示当前条带属于上唇还是下唇。
    // 张嘴时，上唇可以略微上移，下唇可以略微下移。
    const upperWeight = t < 0.5 ? cosineBell(t * 2) : 0
    const lowerWeight = t > 0.5 ? cosineBell((1 - t) * 2) : 0
    // 嘴角区域应该更稳定，否则嘴角会被拉扯得很明显。
    const cornerLock = smoothstep(0.72, 1, lipEdgeWeight)
    // 嘴巴中间上下唇交界处不能裂得太开，否则贴片条带会有割裂感。
    const seamBridge = smoothstep(0, 0.22, centerWeight)

    // localScaleX 控制当前条带的横向缩放。
    // 扁嘴时中间区域略宽，圆唇时中间和边缘略收。
    const localScaleX =
      1 +
      pose.widthness * 0.11 * centerWeight -
      pose.roundness * (0.06 * centerWeight + 0.1 * lipEdgeWeight)

    // cornerLock 会削弱嘴角附近的横向变化，让嘴角更像锚点。
    const lockedScaleX = 1 + (localScaleX - 1) * (1 - cornerLock * 0.88)
    const sliceWidth = drawWidth * lockedScaleX
    const sliceX = drawX + (drawWidth - sliceWidth) / 2

    const splitAmount =
      pose.openness * drawHeight * tuning.splitStrength * 0.52
    // seamBridge 用来减少中缝附近的上下分离，让上下唇过渡更自然。
    const bridgedSplitAmount = splitAmount * (1 - seamBridge * 0.78)
    const upperLift = -upperWeight * bridgedSplitAmount
    const lowerDrop = lowerWeight * bridgedSplitAmount
    // centerBulgeY 让嘴巴中部随开口略微鼓起，避免只是机械拉伸。
    const centerBulgeY =
      centerWeight * pose.openness * drawHeight * tuning.bulgeStrength * 0.72
    // seamSoftening 给上下条带一点很轻微的错位，减少完全水平切片的僵硬感。
    const seamSoftening = signedOffset * pose.openness * drawHeight * 0.008
    // 相邻条带之间稍微重叠，避免浏览器缩放时出现细小缝隙。
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
  // 这个状态只给用户看，帮助判断当前是音频驱动还是摄像头驱动。
  // 真正的驱动模式保存在 mouthDriver.mode 里。
  driverStatus.textContent = text
}

function updateDebugPanel() {
  // 调试面板的目标是“把内部状态摊开给学习者看”。
  // 它不参与计算，只把 latestDebugState、mouthRenderer、tuning 中的值格式化成文本。
  const metrics = latestDebugState.metrics
  const pose = latestDebugState.pose

  // lines 数组每一项对应调试面板中的一行。
  // 比起直接拼一个大字符串，数组更方便后续增删调试项。
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
    // 摄像头关键点驱动时才会有 metrics。
    // 音频驱动没有真实嘴部几何信息，因此 metrics 为 null。
    lines.push(`开口比例: ${formatNumber(metrics.openRatio)}`)
    lines.push(`横向比例: ${formatNumber(metrics.widthRatio)}`)
    lines.push(`圆唇比例: ${formatNumber(metrics.roundRatio)}`)
  }

  if (latestDebugState.audioFeatures) {
    // 音频驱动时才会有 audioFeatures。
    // 这些值来自 Web Audio API 的频域和时域数据。
    lines.push(`音频 RMS: ${formatNumber(latestDebugState.audioFeatures.rms)}`)
    lines.push(`频谱质心: ${formatNumber(latestDebugState.audioFeatures.normalizedCentroid)}`)
    lines.push(`低频占比: ${formatNumber(latestDebugState.audioFeatures.lowRatio)}`)
    lines.push(`中频占比: ${formatNumber(latestDebugState.audioFeatures.midRatio)}`)
    lines.push(`高频占比: ${formatNumber(latestDebugState.audioFeatures.highRatio)}`)
  }

  debugPanel.textContent = lines.join("\n")
}

function setDebugState(nextState) {
  // 用“合并对象”的方式更新调试状态。
  // 这样调用方只需要传本次变化的字段，不用每次都构造完整对象。
  latestDebugState = {
    ...latestDebugState,
    ...nextState,
  }
  updateDebugPanel()
}

function speak() {
  // speak 是“文本转语音 + 音频驱动嘴型”的入口。
  // 用户点击“说话”按钮后会调用它。
  const text = document.getElementById("text").value.trim()

  if (!text) {
    // 空文本没有必要请求后端，直接返回。
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
      // 后端返回的是 mp3 二进制数据。
      // URL.createObjectURL 可以把 Blob 临时变成一个浏览器可播放的本地 URL。
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)

      currentAudio = audio
      // sessionId 用来废弃旧播放的动画循环。
      // 只要开始了新一轮播放，旧循环就应该停止。
      playbackSessionId += 1
      const sessionId = playbackSessionId

      audio.play()
      // 播放音频的同时启动嘴型分析循环。
      // 注意：这里不是等音频播放完再分析，而是边播放边取当前音频特征。
      animateMouth(audio, sessionId)

      audio.addEventListener("ended", () => {
        // 播放结束后回到闭嘴状态，并释放临时 URL。
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
  //
  // createMediaElementSource(audio) 把普通 <audio> 播放源接入 Web Audio。
  // analyser 不会改变声音，只负责提供频谱和波形数据。
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const analyser = audioCtx.createAnalyser()
  const source = audioCtx.createMediaElementSource(audio)
  // fftSize 越大，频谱分辨率越高，但计算量也更大。
  // 1024 对这个 Demo 足够，能看到大致低/中/高频分布。
  analyser.fftSize = 1024
  // smoothingTimeConstant 是 Web Audio 自带的平滑。
  // 值越大，频谱变化越不抖，但响应也会更慢。
  analyser.smoothingTimeConstant = 0.7

  // 连接顺序不能漏：
  // source -> analyser 用于分析
  // analyser -> destination 用于真正把声音播放出来
  source.connect(analyser)
  analyser.connect(audioCtx.destination)

  // frequencyData 保存频域数据，表示不同频段的能量。
  // timeData 保存时域数据，表示音频波形，用来估算 RMS 音量。
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

    // 把底层音频数组转换成更容易理解的特征：
    // rms / 频谱质心 / 低中高频占比 / 开口强度。
    const audioFeatures = extractAudioFeatures(frequencyData, timeData)
    // 再把音频特征映射成嘴型状态和连续姿态。
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
  // 这个函数只初始化 FaceMesh 模型，不打开摄像头。
  // 打开摄像头由 startCameraStream() 负责。
  // 分开写的好处是：模型初始化失败和摄像头权限失败可以分别定位。
  if (typeof FaceMesh === "undefined") {
    throw new Error("FaceMesh 脚本没有加载成功，请检查网络或 CDN 访问。")
  }

  // FaceMesh 会输出整张脸的关键点，这里我们只取嘴部相关点。
  faceMesh = new FaceMesh({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  })

  faceMesh.setOptions({
    // 当前学习 Demo 只跟踪一张脸。
    // 多人跟踪会增加复杂度，也不利于理解“一个数字人”的链路。
    maxNumFaces: 1,
    // refineLandmarks 会给眼睛/嘴唇等细节区域更精细的关键点。
    // 对嘴部驱动来说，打开它更容易得到稳定的嘴唇数据。
    refineLandmarks: true,
    // 置信度阈值越高，误检越少，但可能更容易丢脸。
    // 0.5 是 MediaPipe 示例里常用的折中值。
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })

  // FaceMesh 每分析完一帧，就会调用 handleFaceMeshResults。
  // 这个回调里会同时做两件事：
  // 1. 画摄像头对照预览
  // 2. 用嘴部关键点驱动数字人口型
  faceMesh.onResults(handleFaceMeshResults)
}

function getCameraStartBlockReason() {
  // getUserMedia 是浏览器标准摄像头 API。
  // 老浏览器或极少数环境可能没有 navigator.mediaDevices。
  if (!navigator.mediaDevices?.getUserMedia) {
    return "当前浏览器不支持摄像头采集 API。"
  }

  // Chrome 对摄像头访问有安全上下文要求。
  // localhost / 127.0.0.1 被认为是安全的；
  // 普通 http 的局域网 IP 通常会被拦。
  if (!window.isSecureContext) {
    return "Chrome 需要在 https://、http://localhost 或 http://127.0.0.1 下开启摄像头。"
  }

  return ""
}

function getCameraErrorMessage(error) {
  // 不同浏览器对摄像头失败会给出不同 name。
  // 这里把常见英文错误翻译成学习者能理解的中文提示。
  const name = error?.name || ""
  const detail = error?.message ? `（${name}: ${error.message}）` : name ? `（${name}）` : ""

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "摄像头权限被拒绝，请在 Chrome 地址栏左侧的网站设置里允许摄像头。"
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "没有找到可用摄像头，请确认设备已连接。"
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return `Chrome 无法读取摄像头。可能是被其它程序占用，也可能是 Chrome 当前选中的摄像头设备异常。请关闭 Edge/会议软件/系统相机，或在 Chrome 设置里切换默认摄像头后重试。${detail}`
  }

  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "摄像头不支持当前采集参数，已建议使用 320x240，但设备仍无法打开。"
  }

  if (name === "SecurityError") {
    return "浏览器安全策略阻止摄像头，请使用 localhost、127.0.0.1 或 HTTPS 访问页面。"
  }

  return error?.message || `摄像头启动失败，请打开浏览器控制台查看详细错误。${detail}`
}

function getVideoPlayErrorMessage(error) {
  // getUserMedia 成功只代表“浏览器拿到了摄像头流”。
  // 还需要把流挂到 video 上，并让 video 真的开始播放，FaceMesh 才能读取帧。
  const name = error?.name || ""

  if (name === "NotReadableError") {
    return "Chrome 已获得摄像头流，但隐藏 video 无法读取画面。请刷新页面后重试，或在 Chrome 设置中确认没有禁用摄像头。"
  }

  if (name === "NotAllowedError") {
    return "Chrome 阻止了页面播放摄像头画面，请刷新页面后重新允许摄像头。"
  }

  return error?.message || "摄像头视频流已打开，但页面无法播放摄像头画面。"
}

function waitForCameraMetadata() {
  // loadedmetadata 表示 video 已经知道视频宽高、时长等基础信息。
  // 对实时摄像头来说，等到这个事件后再 play / drawImage 更稳。
  if (cameraInput.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    // 如果一直等不到 metadata，不要让按钮永远卡住。
    // 5 秒超时后主动失败，方便页面显示错误。
    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error("等待摄像头画面超时，请刷新页面后重试。"))
    }, 5000)

    const cleanup = () => {
      // Promise 完成或失败后都要移除事件监听，避免重复触发和内存泄漏。
      window.clearTimeout(timeoutId)
      cameraInput.removeEventListener("loadedmetadata", handleLoaded)
      cameraInput.removeEventListener("error", handleError)
    }

    const handleLoaded = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(cameraInput.error || new Error("摄像头视频元素加载失败。"))
    }

    cameraInput.addEventListener("loadedmetadata", handleLoaded)
    cameraInput.addEventListener("error", handleError)
  })
}

async function openCameraStream() {
  // 第一轮请求使用推荐参数：
  // - 不采集音频，只要视频
  // - 320x240 足够给 FaceMesh 分析，也减少性能压力
  // - facingMode:user 更偏向前置摄像头
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        facingMode: "user",
      },
    })
  } catch (firstError) {
    console.warn("使用推荐摄像头参数失败，改用最宽松参数重试。", firstError)

    try {
      // 第二轮用最宽松的 video:true。
      // 这样可以排除“摄像头支持，但不支持我们指定的分辨率/方向”这种问题。
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: true,
      })
    } catch (fallbackError) {
      console.error("摄像头宽松参数重试仍失败。", fallbackError)
      throw fallbackError
    }
  }
}

async function startCameraStream() {
  // 这是摄像头启动的完整流程：
  // 1. 检查浏览器环境是否允许摄像头
  // 2. 停掉可能残留的旧流
  // 3. 调用 getUserMedia 获取新流
  // 4. 把流挂到隐藏 video
  // 5. 等 video 准备好并开始播放
  const blockReason = getCameraStartBlockReason()

  if (blockReason) {
    throw new Error(blockReason)
  }

  stopCameraStream()

  try {
    cameraStream = await openCameraStream()
  } catch (error) {
    throw new Error(getCameraErrorMessage(error))
  }

  cameraInput.muted = true
  cameraInput.playsInline = true
  // srcObject 是把 MediaStream 交给 video 元素播放的标准方式。
  cameraInput.srcObject = cameraStream

  try {
    await waitForCameraMetadata()
    await cameraInput.play()
  } catch (error) {
    throw new Error(getVideoPlayErrorMessage(error))
  }
}

function startCameraFrameLoop() {
  // requestAnimationFrame 让摄像头分析跟浏览器刷新节奏保持一致。
  // 每一帧把 video 当前画面送进 FaceMesh。
  const sendFrame = async () => {
    if (!cameraDriving) {
      // cameraDriving 被关闭后，下一帧循环自然停止。
      return
    }

    if (!faceMeshSending && cameraInput.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      // HAVE_CURRENT_DATA 表示 video 至少有当前帧可以读。
      // faceMeshSending 防止上一帧还没分析完时重复 send。
      faceMeshSending = true

      try {
        await faceMesh.send({ image: cameraInput })
      } catch (error) {
        console.error(error)
        setDriverStatus(`摄像头关键点分析失败：${getCameraErrorMessage(error)}`)
      } finally {
        faceMeshSending = false
      }
    }

    cameraFrameRequestId = requestAnimationFrame(sendFrame)
  }

  cameraFrameRequestId = requestAnimationFrame(sendFrame)
}

async function toggleCameraDrive() {
  // 这个函数是摄像头按钮的点击入口。
  // 它既负责“打开”，也负责“再次点击关闭”。
  // 再次点击时关闭摄像头驱动。
  if (cameraDriving) {
    stopCameraDrive()
    return
  }

  try {
    if (!faceMesh) {
      initCameraDriver()
    }

    await startCameraStream()
    cameraDriving = true
    startCameraFrameLoop()
    mouthDriver.setMode("landmarks")
    cameraToggleButton.textContent = "关闭摄像头驱动"
  } catch (error) {
    cameraDriving = false
    console.error(error)
    setDriverStatus(`摄像头启动失败：${error?.message || getCameraErrorMessage(error)}`)
    stopCameraStream()
  }
}

function stopCameraDrive() {
  // 停止摄像头驱动时，嘴型控制权交还给音频模式。
  // 这里不是自动播放音频，只是把 mode 和 UI 状态恢复到音频驱动。
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

  stopCameraStream()
  mediapipeCamera = null
}

function stopCameraStream() {
  // 停止 requestAnimationFrame 循环。
  // 如果不取消，关闭摄像头后仍可能继续尝试分析空 video。
  if (cameraFrameRequestId !== null) {
    cancelAnimationFrame(cameraFrameRequestId)
    cameraFrameRequestId = null
  }

  const stream = cameraStream || cameraInput.srcObject
  if (stream) {
    // 一个 MediaStream 里可能有多个 track。
    // 这里逐个 stop，浏览器才会真正释放摄像头硬件。
    stream.getTracks().forEach(track => track.stop())
  }

  cameraStream = null
  cameraInput.srcObject = null
  faceMeshSending = false
  clearCameraPreview("摄像头未开启")
}

function handleFaceMeshResults(results) {
  // results 是 FaceMesh 对当前视频帧的分析结果。
  // 即使当前没有启用“摄像头驱动嘴型”，也可以先画对照预览，
  // 因为预览本身只是帮助学习者观察识别结果。
  drawCameraPreview(results)

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
  // 关键点 -> 几何指标 -> 嘴型状态。
  const nextShape = mouthDriver.shapeFromLandmarks(metrics)
  // 关键点 -> 几何指标 -> 连续形变参数。
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

function clearCameraPreview(message) {
  const width = cameraPreviewCanvas.width
  const height = cameraPreviewCanvas.height

  // 摄像头关闭或初始化时，预览区不能留着上一帧画面。
  // 清空后画一个深色背景和状态文案，让学习者知道当前没有实时输入。
  cameraPreviewCtx.save()
  cameraPreviewCtx.clearRect(0, 0, width, height)
  cameraPreviewCtx.fillStyle = "#122840"
  cameraPreviewCtx.fillRect(0, 0, width, height)
  cameraPreviewCtx.fillStyle = "#d9e7f5"
  cameraPreviewCtx.font = "14px sans-serif"
  cameraPreviewCtx.textAlign = "center"
  cameraPreviewCtx.textBaseline = "middle"
  cameraPreviewCtx.fillText(message, width / 2, height / 2)
  cameraPreviewCtx.restore()
}

function drawCameraPreview(results) {
  const width = cameraPreviewCanvas.width
  const height = cameraPreviewCanvas.height
  const landmarks = results.multiFaceLandmarks?.[0]

  // 第一步：把隐藏 video 里的当前摄像头帧画到对照 canvas。
  // 浏览器的 video 元素负责持有真实摄像头流，canvas 只负责“截图式”绘制当前帧。
  cameraPreviewCtx.save()
  cameraPreviewCtx.clearRect(0, 0, width, height)
  // 前置摄像头通常按“照镜子”的方式显示更直觉。
  // 这里先把 canvas 坐标系水平翻转，再画 video，
  // 后面画关键点时也会使用同样的镜像坐标，保证标注和画面对齐。
  cameraPreviewCtx.translate(width, 0)
  cameraPreviewCtx.scale(-1, 1)
  cameraPreviewCtx.drawImage(cameraInput, 0, 0, width, height)
  cameraPreviewCtx.restore()

  // 第二步：把 FaceMesh 的结果叠加到视频画面上。
  // 注意：这里的叠加只是调试可视化，不参与真正的嘴型分类。
  if (landmarks) {
    drawMouthOverlay(landmarks)
  } else {
    drawCameraPreviewBadge("未检测到人脸")
  }
}

function drawMouthOverlay(landmarks) {
  cameraPreviewCtx.save()
  cameraPreviewCtx.lineWidth = 2
  cameraPreviewCtx.strokeStyle = "rgba(31, 111, 178, 0.95)"
  cameraPreviewCtx.fillStyle = "rgba(31, 111, 178, 0.18)"
  cameraPreviewCtx.beginPath()

  // FaceMesh 给出的坐标是 0 到 1 的归一化坐标：
  // x=0 表示画面最左边，x=1 表示画面最右边；
  // y=0 表示画面最上边，y=1 表示画面最下边。
  // 画到 canvas 前，需要转换成实际像素坐标。
  mouthOverlayContourIndices.forEach((index, pointIndex) => {
    const point = landmarkToPreviewPoint(landmarks[index])

    if (pointIndex === 0) {
      cameraPreviewCtx.moveTo(point.x, point.y)
    } else {
      cameraPreviewCtx.lineTo(point.x, point.y)
    }
  })

  cameraPreviewCtx.closePath()
  cameraPreviewCtx.fill()
  cameraPreviewCtx.stroke()

  // 这里只画 4 个黄色参考点，不再显示文字。
  // 点位足够帮助观察嘴巴识别是否稳定，文字会遮挡真实嘴部细节。
  mouthOverlayReferencePoints.forEach(({ index }) => {
    const point = landmarkToPreviewPoint(landmarks[index])

    cameraPreviewCtx.beginPath()
    cameraPreviewCtx.fillStyle = "#f5c542"
    cameraPreviewCtx.strokeStyle = "rgba(18, 40, 64, 0.85)"
    cameraPreviewCtx.arc(point.x, point.y, 4, 0, Math.PI * 2)
    cameraPreviewCtx.fill()
    cameraPreviewCtx.stroke()
  })

  cameraPreviewCtx.restore()
}

function drawCameraPreviewBadge(text) {
  // 未检测到人脸时仍然保留摄像头画面，只在左上角叠加一个小提示。
  // 这样可以同时看到“画面是否正常”和“模型是否检测到脸”。
  cameraPreviewCtx.save()
  cameraPreviewCtx.fillStyle = "rgba(18, 40, 64, 0.72)"
  cameraPreviewCtx.fillRect(10, 10, 112, 28)
  cameraPreviewCtx.fillStyle = "#ffffff"
  cameraPreviewCtx.font = "13px sans-serif"
  cameraPreviewCtx.textAlign = "left"
  cameraPreviewCtx.textBaseline = "middle"
  cameraPreviewCtx.fillText(text, 20, 24)
  cameraPreviewCtx.restore()
}

function landmarkToPreviewPoint(point) {
  // 因为摄像头画面已经按自拍习惯做了水平镜像，
  // 所以关键点的 x 坐标也要用 1 - x 做同样镜像。
  // 如果不这样处理，嘴部轮廓会左右反着贴在画面上。
  return {
    x: (1 - point.x) * cameraPreviewCanvas.width,
    y: point.y * cameraPreviewCanvas.height,
  }
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
  // 例如用户离镜头近时，mouthOpen 和 mouthWidth 都会变大；
  // 但 mouthOpen / mouthWidth 这个比例相对稳定。
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
  // frequencyData 是频域数据。
  // 每个 value 表示某个频率范围内的能量，值越大代表这个频段越强。
  let totalEnergy = 0
  let weightedIndex = 0
  let lowEnergy = 0
  let midEnergy = 0
  let highEnergy = 0

  for (let i = 0; i < frequencyData.length; i++) {
    const value = frequencyData[i]
    totalEnergy += value
    // weightedIndex 用于计算“频谱质心”：
    // 能量集中在高频时，质心偏大；集中在低频时，质心偏小。
    weightedIndex += value * i

    // 这里把频谱粗略切成低/中/高三段。
    // 它不是严格声学分类，只是为了学习阶段做一个可理解的近似。
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
    // timeData 的中心值是 128。
    // 转成 -1 到 1 附近的波形后，可以计算 RMS 音量。
    const normalized = (timeData[i] - 128) / 128
    rmsAccumulator += normalized * normalized
  }

  const rms = Math.sqrt(rmsAccumulator / timeData.length)
  const normalizedCentroid =
    totalEnergy > 0 ? weightedIndex / totalEnergy / Math.max(frequencyData.length - 1, 1) : 0
  const lowRatio = totalEnergy > 0 ? lowEnergy / totalEnergy : 0
  const midRatio = totalEnergy > 0 ? midEnergy / totalEnergy : 0
  const highRatio = totalEnergy > 0 ? highEnergy / totalEnergy : 0
  // openness 是给嘴巴开合用的归一化强度。
  // 0.018 是静音阈值附近的经验值，0.11 控制从轻声到大声的映射跨度。
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
  // 这个函数给“嘴型贴图裁剪”生成一个归一化轮廓。
  // 返回值不是摄像头画面上的像素坐标，而是 0-1 的局部嘴部坐标。
  // 后续 applyContourClip 会把它映射到头像上的 mouthROI。
  // 外唇轮廓关键点，按顺时针近似排列。
  const contourIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
  const leftCorner = landmarks[61]
  const rightCorner = landmarks[291]
  const upperLip = landmarks[13]
  const lowerLip = landmarks[14]
  const width = Math.max(distance(leftCorner, rightCorner) * tuning.contourWidthScale, 0.001)
  const height = Math.max(distance(upperLip, lowerLip) * tuning.contourHeightScale, 0.001)
  // 以左右嘴角中点作为横向中心，以上下唇中点作为纵向中心。
  // 这样嘴部轮廓会围绕嘴巴中心归一化。
  const centerX = (leftCorner.x + rightCorner.x) / 2
  const centerY = (upperLip.y + lowerLip.y) / 2

  return contourIndices.map(index => {
    const point = landmarks[index]
    // 把 FaceMesh 全脸归一化坐标，转换成“嘴部局部区域”坐标。
    // 结果 normalizedX / normalizedY 越接近 0.5，说明越靠近嘴部中心。
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
  // Canvas 的 clip() 会把后续绘制限制在当前路径内部。
  // 这里先用嘴部轮廓创建一个裁剪路径，再绘制嘴型贴图条带。
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
  // 把数值限制在 [min, max] 区间内。
  // 动画和识别里经常需要防止比例跑出合理范围。
  return Math.max(min, Math.min(max, value))
}

function smoothstep(edge0, edge1, value) {
  // smoothstep 是一种平滑插值函数。
  // 相比线性变化，它在开始和结束时更柔和，常用于动画权重。
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1)
  return t * t * (3 - 2 * t)
}

function cosineBell(value) {
  // 余弦钟形曲线：输入 0 或 1 时接近 0，输入 0.5 时接近 1。
  // 很适合表示“嘴巴中间强、边缘弱”的权重。
  const t = clamp(value, 0, 1)
  return 0.5 - 0.5 * Math.cos(Math.PI * t)
}

function formatNumber(value) {
  // 调试面板里显示小数时统一保留 3 位。
  // 如果遇到 NaN / Infinity，就显示 "-"，避免面板出现难读的异常值。
  return Number.isFinite(value) ? value.toFixed(3) : "-"
}

function formatModeLabel(mode) {
  // 代码内部使用英文 mode，界面面板显示中文，方便学习者理解。
  if (mode === "landmarks") {
    return "摄像头关键点"
  }

  if (mode === "audio") {
    return "语音驱动"
  }

  return mode
}

function formatSourceLabel(source) {
  // source 表示“本次调试状态来自哪里”。
  // 这里集中维护英文 key 到中文文案的映射。
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
  // 轮廓插值用于让摄像头嘴部裁剪边界平滑变化。
  // 如果每一帧直接使用新的轮廓，轻微关键点抖动会让贴图边缘也抖。
  if (!targetContour) {
    return null
  }

  if (!currentContour || currentContour.length !== targetContour.length) {
    // 第一次拿到轮廓，或者轮廓点数变化时，无法逐点插值。
    // 直接复制目标轮廓作为当前轮廓。
    return targetContour.map(point => ({ ...point }))
  }

  return currentContour.map((point, index) => ({
    x: point.x + (targetContour[index].x - point.x) * factor,
    y: point.y + (targetContour[index].y - point.y) * factor,
  }))
}

function defaultPose() {
  // 默认姿态表示“没有额外形变”：
  // 不缩放、不偏移、不开口、不圆唇、不扁嘴。
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
  // 用户拖动任意调参滑块时，会调用这个函数。
  // 它把 DOM input 的字符串值转换成数字，并同步到 tuning / mouthROI。
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
  // 调参后立刻刷新面板，让用户知道当前具体数值。
  updateDebugPanel()
  // 同时安排保存到后端配置文件，但通过 debounce 避免过于频繁写文件。
  scheduleConfigSave()
}

function getCurrentConfig() {
  // 返回当前需要持久化的调参字段。
  // 只保存学习调参相关的值，不保存运行态数据，比如当前嘴型或摄像头状态。
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
  // 后端返回的是配置对象。
  // 先把值写回页面滑块，再调用 syncTuningFromInputs 统一同步到 tuning。
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
  // 页面加载时读取上次保存的调参配置。
  // 这样刷新页面后，不会丢失刚刚调好的 ROI 和形变参数。
  try {
    const response = await fetch("/config")
    if (!response.ok) {
      throw new Error(`load config failed: ${response.status}`)
    }

    const config = await response.json()
    applyConfig(config)
  } catch (error) {
    // 配置读取失败不应该阻止 Demo 运行。
    // 失败时继续使用 HTML input 中的默认值即可。
    console.error(error)
  }
}

function scheduleConfigSave() {
  // debounce 保存：
  // 用户拖动 range 时会连续触发很多 input 事件。
  // 如果每次都 POST /config，会造成大量无意义请求。
  if (saveConfigTimer) {
    clearTimeout(saveConfigTimer)
  }

  saveConfigTimer = setTimeout(() => {
    saveConfigTimer = null
    saveConfigToServer()
  }, 250)
}

async function saveConfigToServer() {
  // 把当前调参配置 POST 给 FastAPI 后端。
  // 后端会写入 tuning_config.json。
  try {
    await fetch("/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(getCurrentConfig()),
    })
  } catch (error) {
    // 保存失败只影响下次刷新能否恢复参数，不影响当前页面继续调试。
    console.error(error)
  }
}

// ------------------------------
// 页面初始化入口
// ------------------------------
// 这里是整个前端脚本真正开始运行的地方：
// 1. 先清空摄像头对照区，显示“摄像头未开启”
// 2. 预加载嘴型素材，素材加载完后会启动主渲染循环
// 3. 绑定按钮和滑块事件
// 4. 初始化调试面板
// 5. 从后端读取上次保存的调参配置
clearCameraPreview("摄像头未开启")
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
