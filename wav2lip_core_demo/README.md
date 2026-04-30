# Wav2Lip Core Demo

这个目录是 LiveTalking 的核心内容拆解版。

它故意不包含：

- WebRTC
- TTS
- 多 session
- 多线程队列
- 前端页面
- 实时推流

只保留一条最小链路：

```text
输入视频/图片 + 输入音频
        -> 提取 mel 音频特征
        -> 检测人脸区域
        -> Wav2Lip 推理
        -> 把生成结果贴回原帧
        -> 输出 mp4
```

## 目录

```text
wav2lip_core_demo/
├── demo.py
├── inputs/
├── models/
└── outputs/
```

`demo.py` 默认复用旁边的 LiveTalking 源码：

```text
../livetalking_experiment/upstream/
```

所以不需要复制 Wav2Lip 模型代码。

## 准备文件

推荐放：

```text
inputs/face.mp4
inputs/speech.wav
models/wav2lip.pth
```

如果你已经在 LiveTalking 里放好了权重，也可以直接引用：

```text
../livetalking_experiment/upstream/models/wav2lip.pth
```

同时需要系统能访问 `ffmpeg` 命令，因为最后一步要把无声视频和输入音频合成为 mp4。

## 运行

在仓库根目录执行：

```bash
cd wav2lip_core_demo

python3 demo.py \
  --face inputs/face.mp4 \
  --audio inputs/speech.wav \
  --checkpoint ../livetalking_experiment/upstream/models/wav2lip.pth \
  --outfile outputs/result.mp4 \
  --img-size 256
```

如果输入是一张图片：

```bash
python3 demo.py \
  --face inputs/face.jpg \
  --audio inputs/speech.wav \
  --checkpoint ../livetalking_experiment/upstream/models/wav2lip.pth \
  --outfile outputs/result.mp4 \
  --static \
  --fps 25 \
  --img-size 256
```

## 关键参数

```text
--img-size
  Wav2Lip 输入人脸尺寸。LiveTalking 的 wav2lip256 权重通常用 256。

--pads top bottom left right
  人脸框额外扩展。下巴没包含进去时，可以增大 bottom。

--box top bottom left right
  手动指定人脸框。人脸检测失败时再用。

--resize-factor
  输入视频太大时缩小，减少检测和推理压力。

--batch-size
  推理 batch。显存不够就调小。
```

## 这一版帮助理解什么

这个 Demo 对应 LiveTalking 里最核心的部分：

```text
MelASR + Wav2Lip inference + paste_back_frame
```

等这条离线链路看懂后，再回头看 LiveTalking 的实时队列和 WebRTC，会清楚很多。
