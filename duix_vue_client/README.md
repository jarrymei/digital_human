# Duix.Avatar Vue Client

这是一个独立的 Vue3 Web 客户端，用来对接开源项目 `duixcom/Duix-Avatar` 的离线视频合成 API。页面流程是：

```text
填写 audio_url + video_url -> 提交 /easy/submit -> 轮询 /easy/query -> 播放生成视频
```

## 安装和运行

```bash
cd duix_vue_client
npm install
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:5174
```

当前开发代理默认指向你的服务器：

```text
154.93.109.240:8383  视频合成服务
154.93.109.240:18180 TTS 服务
```

## 视频合成参数

官方接口：

```text
POST /easy/submit
GET  /easy/query?code={taskCode}
```

页面会提交：

```json
{
  "audio_url": "{audioPath}",
  "video_url": "{videoPath}",
  "code": "{uuid}",
  "chaofen": 0,
  "watermark_switch": 0,
  "pn": 1
}
```

`audio_url` 和 `video_url` 要填写你在 Postman 已经验证过的路径。Duix.Avatar 的 Docker 服务通常需要的是容器可读路径或挂载目录里的相对文件名，而不是浏览器本地文件。

## TTS 试听

页面也保留了官方 TTS 接口的调试区：

```text
POST /v1/invoke
```

它需要训练返回的：

- `reference_audio`
- `reference_text`

注意：官方 TTS 接口返回的是音频二进制。桌面客户端会把音频保存到共享目录，再把文件名传给视频合成服务。纯浏览器不能直接把这个 wav 写入服务器 Docker 挂载目录，所以这里主要用于试听和接口调试。

## 环境变量

可以复制 `.env.example` 为 `.env.local`：

```bash
cp .env.example .env.local
```

可配置项：

```env
VITE_DUIX_VIDEO_API_BASE=/duix-video/easy
VITE_DUIX_TTS_API_BASE=/duix-tts
VITE_DUIX_OUTPUT_BASE_URL=http://154.93.109.240:8383
```

开发环境建议保留 `/duix-video` 和 `/duix-tts`，由 Vite 代理转发，避免 `8383` 接口没有 CORS 头导致浏览器拦截。

## 这一改动帮助理解了什么

这一步把客户端从“实时 SDK 渲染”改成了 Duix.Avatar 的真实开源链路：提交离线视频任务、轮询进度、拿到结果文件并播放。
