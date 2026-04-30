# Digital Human Learning Demo

这个仓库是一个循序渐进学习数字人技术的实验项目。当前重点不是一次性做完整产品，而是先把每条关键链路跑通、看懂、能修改。

## 当前版本

当前可运行版本在 `single_layer_mouth_demo/` 目录下。

它已经实现：

- FastAPI 页面和接口
- `edge-tts` 文本转语音
- Canvas 头像绘制
- 多张嘴部 PNG 贴图
- 音频特征驱动嘴型
- 摄像头 FaceMesh 关键点驱动嘴型
- 嘴部 ROI、轮廓裁剪和局部条带形变调参

当前阶段可以理解为：

```text
阶段 3 早期：静态头像 + 单层嘴部贴图 + 音频/关键点驱动
```

## 运行方式

进入 Demo 目录：

```bash
cd single_layer_mouth_demo
```

安装依赖：

```bash
pip install -r requirements.txt
```

启动后端：

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

浏览器打开：

```text
http://127.0.0.1:8000
```

## 当前学习重点

当前代码已经不只是“嘴巴会动”，而是在学习下面这条链路：

```text
文本输入 -> TTS 生成音频 -> 浏览器播放 -> 提取音频特征 -> 推断嘴型 -> Canvas 绘制贴图
```

摄像头模式则用于对照理解：

```text
摄像头画面 -> FaceMesh 嘴部关键点 -> 提取开口/宽度/圆唇指标 -> 推断嘴型 -> Canvas 绘制贴图
```

## 下一步方向

单层嘴部贴图已经能做出可观察效果，但上限比较明显。下一步建议进入：

```text
多层嘴部结构
```

也就是把当前“一张嘴部贴图”逐步拆成：

- 口腔阴影层
- 牙齿层
- 上唇层
- 下唇层
- 高光或唇线辅助层

这样可以继续学习“2D 数字人不是换一张嘴图，而是分层渲染和分层运动”的基本思路。

详细学习路线见 [docs/stage-03-multilayer-mouth.md](docs/stage-03-multilayer-mouth.md)。

## LiveTalking 实验

如果想跳过手绘嘴部素材，直接研究算法库实时生成嘴部，可以看：

[livetalking_experiment/README.md](livetalking_experiment/README.md)

这个目录已把现有 Canvas Demo 和 LiveTalking 实验分开：前者保留为学习基线，后者用于研究 Wav2Lip / MuseTalk 这类实时视频数字人路线。

## Duix.Avatar Web 客户端

如果你已经在云服务器上部署了开源项目 Duix.Avatar，可以看：

[duix_vue_client/README.md](duix_vue_client/README.md)

这个目录是一个独立的 Vue3 页面客户端：填写 `audio_url`、`video_url` 和任务 `code` 后提交到 `/easy/submit`，再轮询 `/easy/query`，最后在页面里播放生成视频。它用于学习“离线数字人视频合成服务如何被 Web 页面调用”。

## Wav2Lip 核心离线 Demo

如果觉得 LiveTalking 的实时工程代码太复杂，可以先看：

[wav2lip_core_demo/README.md](wav2lip_core_demo/README.md)

这个 Demo 不做 WebRTC 和 TTS，只保留 `输入视频/图片 + 音频 -> Wav2Lip -> 输出 mp4`，适合单独理解口型生成的核心流程。
