# LiveTalking 学习路线

## 阶段定位

这个实验属于原学习路线里的“阶段 5：实时化与工程化”，但它不是对原 Canvas Demo 的小步增强，而是切换到另一条路线：

```text
2D Canvas 嘴型绘制
        ↓
AI 视频嘴部重绘 + WebRTC 实时输出
```

所以本目录先作为独立实验，不直接替换现有 Demo。

## 第一目标

先只完成一件事：

```text
跑通 wav2lip256_avatar1 的 WebRTC 实时数字人
```

完成标准：

1. 服务能启动。
2. 浏览器能打开 `dashboard.html` 或 `webrtcapi.html`。
3. 点击 start 后能看到数字人视频流。
4. 输入文本后，数字人能播报并产生口型。

## 暂时不做

第一轮暂时不做：

- 接入自己的头像
- 训练自定义 avatar
- 接 LLM 对话
- 换 MuseTalk
- 做公网部署
- 和原 FastAPI Demo 合并

这些都等官方示例跑通后再做。

## 跑通后的第二目标

跑通官方 avatar 后，再研究：

```text
自定义 avatar 制作流程
```

要重点看：

- avatar 原始视频要求
- 人脸裁剪和对齐流程
- `data/avatars/` 目录里每个文件的作用
- Wav2Lip 和 MuseTalk 对 avatar 数据的差异

## 跑通后的第三目标

再把原来的学习 Demo 经验迁移过来：

```text
原 Demo 的 TTS 文本输入
        ↓
LiveTalking 的 /human 或 /humanaudio API
        ↓
WebRTC 数字人输出
```

这时再考虑是否新建一个轻量控制页，而不是直接改 LiveTalking 官方前端。

