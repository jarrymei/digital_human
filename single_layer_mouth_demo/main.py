"""
数字人 Demo 后端入口
------------------------------------------------------------
这个文件是学习项目里的最小 FastAPI 后端。

它只做三类事情：

1. 提供前端页面和静态资源
   浏览器访问 / 时返回 static/index.html。
   浏览器访问 /static/main.js、/static/avatar.png 等资源时，
   FastAPI 从 static/ 目录中读取文件并返回。

2. 提供文本转语音接口
   前端调用 /tts?text=你好。
   后端使用 edge-tts 生成 output.mp3。
   生成完成后把 mp3 文件返回给浏览器播放。

3. 保存调参配置
   前端滑块调整 ROI、轮廓、条带形变参数后，
   会调用 /config 保存到 tuning_config.json。
   页面刷新时再从 /config 读取回来。

这个后端刻意保持简单：
- 没有数据库
- 没有登录鉴权
- 没有任务队列
- 没有流式 TTS

这样做是为了让学习重点集中在：
“前端输入 -> 后端生成音频 -> 浏览器播放 -> 嘴型驱动”这条最小链路。
"""

from fastapi import FastAPI
from fastapi import Body
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import edge_tts
import json
from pathlib import Path

# FastAPI 是这个 Demo 的后端入口。
# 这个文件负责两件事：
# 1. 把前端页面提供给浏览器访问
# 2. 提供文本转语音接口，返回 mp3 给前端播放
app = FastAPI()

# tuning_config.json 放在 single_layer_mouth_demo/ 目录下。
# 注意这里使用相对路径，意味着运行 uvicorn 时工作目录要在 single_layer_mouth_demo。
# 推荐启动方式：
# uvicorn main:app --reload --host 127.0.0.1 --port 8000
CONFIG_PATH = Path("tuning_config.json")

# 默认调参配置。
# 如果 tuning_config.json 不存在、损坏或缺少字段，就用这些值兜底。
#
# roiX / roiY / roiWidth / roiHeight：
#   控制嘴巴贴图画在头像上的哪个矩形区域。
#
# contourHeightScale / contourWidthScale：
#   控制摄像头关键点模式下嘴部轮廓裁剪范围。
#
# segmentCount / splitStrength / bulgeStrength：
#   控制前端嘴型贴图的条带形变效果。
DEFAULT_CONFIG = {
    "roiX": 125,
    "roiY": 125,
    "roiWidth": 48,
    "roiHeight": 21,
    "contourHeightScale": 3.2,
    "contourWidthScale": 1.0,
    "segmentCount": 10,
    "splitStrength": 0.22,
    "bulgeStrength": 0.06,
}

# 挂载静态资源目录。
# 浏览器访问 /static/xxx 时，FastAPI 会到本地 static 目录中查找文件。
# 例如：
# - /static/index.html
# - /static/main.js
# - /static/avatar.png
app.mount("/static", StaticFiles(directory="static"), name="static")


# 首页路由。
# 当用户访问网站根路径 / 时，直接返回前端页面。
@app.get("/")
def index():
    # FileResponse 会把本地 HTML 文件作为 HTTP 响应返回。
    # 浏览器拿到 HTML 后，会继续请求里面引用的 CSS/JS/图片资源。
    return FileResponse("static/index.html")


# 生成语音文件的核心函数。
# 它是异步函数，因为调用 edge-tts 生成音频需要等待 I/O 完成。
async def generate(text):
    # 创建 edge-tts 会话：
    # - text 是要朗读的文本
    # - zh-CN-XiaoxiaoNeural 是中文女声音色
    communicate = edge_tts.Communicate(text, "zh-CN-XiaoxiaoNeural")

    # 把生成结果保存到本地 output.mp3。
    # 当前 Demo 为了简单，固定覆盖同一个文件。
    # 更完整的项目里通常会改成唯一文件名或直接流式返回。
    await communicate.save("output.mp3")


def load_config():
    # 配置文件不存在时，说明这是第一次运行或还没有保存过调参结果。
    # 返回 copy() 是为了避免调用方不小心修改 DEFAULT_CONFIG 本身。
    if not CONFIG_PATH.exists():
        return DEFAULT_CONFIG.copy()

    try:
        # 使用 utf-8 读取，是为了兼容未来配置里可能出现中文字段或注释类内容。
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # JSONDecodeError：文件存在但内容不是合法 JSON。
        # OSError：文件读取失败，例如权限或磁盘问题。
        # 学习 Demo 里不让这些错误中断页面，直接退回默认配置。
        return DEFAULT_CONFIG.copy()

    # 用默认配置和已保存配置合并：
    # - DEFAULT_CONFIG 提供完整字段
    # - saved 覆盖用户上次调过的值
    # 这样以后新增配置字段时，旧的 tuning_config.json 也能继续用。
    return {**DEFAULT_CONFIG, **saved}


def save_config(config):
    # ensure_ascii=False 让中文按原样写入文件，而不是转成 \uXXXX。
    # indent=2 让 JSON 文件更容易手动阅读。
    CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# 文本转语音接口。
# 前端通过 /tts?text=你好 这样的方式调用它。
# 整体流程是：
# 1. 接收文本
# 2. 生成 mp3
# 3. 把 mp3 返回给浏览器
@app.get("/tts")
async def tts(text: str):
    # 这里为了学习简单，固定覆盖 output.mp3。
    # 注意：如果多人同时访问，可能会互相覆盖。
    # 后续工程化阶段可以改成唯一文件名、临时文件或直接流式返回。
    await generate(text)
    # media_type="audio/mpeg" 告诉浏览器这是 mp3 音频。
    # 前端 fetch 到 blob 后，会创建 Audio 对象播放它。
    return FileResponse("output.mp3", media_type="audio/mpeg")


@app.get("/config")
def get_config():
    # 前端页面加载时调用。
    # 返回当前调参配置，用于恢复上次调整的 ROI 和形变参数。
    return load_config()


@app.post("/config")
def update_config(config: dict = Body(...)):
    # Body(...) 表示这个接口从请求体读取 JSON。
    # 前端 saveConfigToServer() 会 POST 一个对象过来。
    #
    # 这里也做一次默认值合并，避免前端只传部分字段时丢失其它字段。
    merged = {**DEFAULT_CONFIG, **config}
    save_config(merged)
    # 返回 ok 和最终保存的 config，方便前端未来做保存状态提示。
    return {"ok": True, "config": merged}
