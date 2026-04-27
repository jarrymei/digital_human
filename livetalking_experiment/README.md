# LiveTalking 实验目录

这个目录用于从当前 Canvas 嘴型 Demo 跳到“实时视频数字人”路线。

现有的 `single_layer_mouth_demo/` 作为单层嘴部贴图基线版本保留，不在这里继续改。LiveTalking 实验单独放在本目录，避免把 GPU 推理、WebRTC、模型权重等复杂依赖混进原来的学习 Demo。

## 目录结构

```text
livetalking_experiment/
├── README.md
├── docs/
│   └── learning-route.md
├── scripts/
│   ├── check_assets.sh
│   ├── run_wav2lip_webrtc.sh
│   └── setup_conda_cuda124.sh
└── upstream/
    └── LiveTalking 官方源码
```

## 当前选择

第一轮建议先跑：

```text
LiveTalking + wav2lip + WebRTC
```

原因：

- LiveTalking 官方快速开始默认就是 `wav2lip`。
- 官方性能表里 `wav2lip256` 对 GPU 要求低于 `musetalk`。
- WebRTC 可以直接在浏览器里看实时视频结果。

## 需要准备的东西

LiveTalking 不需要你手绘嘴部 PNG 素材，但需要准备模型权重和 avatar 数据：

```text
upstream/models/wav2lip.pth
upstream/data/avatars/wav2lip256_avatar1/
```

官方 README 的要求是：

1. 下载 `wav2lip256.pth`。
2. 放到 `upstream/models/`。
3. 重命名为 `wav2lip.pth`。
4. 下载 `wav2lip256_avatar1.tar.gz`。
5. 解压后把整个 `wav2lip256_avatar1/` 放到 `upstream/data/avatars/`。

模型下载地址以官方 README 为准：

- https://github.com/lipku/LiveTalking
- https://livetalking-doc.readthedocs.io/

## 环境要求

官方当前说明的测试环境：

```text
Ubuntu 24.04
Python 3.10
PyTorch 2.5.0
CUDA 12.4
```

如果本机 CUDA 不是 12.4，需要按你的 `nvidia-smi` 结果安装匹配版本的 PyTorch。

## 安装依赖

如果你使用 conda 且 CUDA 是 12.4，可以参考：

```bash
bash scripts/setup_conda_cuda124.sh
```

如果你已经有自己的 Python 3.10 + CUDA 环境，可以手动执行：

```bash
cd upstream
pip install -r requirements.txt
```

## 检查模型和 avatar

```bash
bash scripts/check_assets.sh
```

这个脚本只检查关键文件是否存在，不会下载模型。

## 启动 wav2lip WebRTC 实验

```bash
bash scripts/run_wav2lip_webrtc.sh
```

启动成功后浏览器访问：

```text
http://127.0.0.1:8010/dashboard.html
```

或者官方基础页面：

```text
http://127.0.0.1:8010/webrtcapi.html
```

WebRTC 远程访问时需要注意端口：

```text
TCP: 8010
UDP: 1-65536
```

本机 `127.0.0.1` 实验通常先不考虑公网端口问题。

## 和原 Demo 的关系

原来的 Canvas Demo 学的是：

```text
音频特征 -> 嘴型状态 -> Canvas 绘制嘴部贴图
```

LiveTalking 学的是：

```text
文本/音频 -> TTS/音频特征 -> Wav2Lip/MuseTalk 推理 -> 生成视频帧 -> WebRTC 播放
```

这一步帮助理解：当你选择算法库实时生成嘴部时，核心问题会从“怎么画嘴巴”变成“怎么准备模型、avatar、GPU 推理和实时视频传输”。

