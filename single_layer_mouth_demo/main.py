from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import edge_tts
import asyncio
import json
from pathlib import Path
from fastapi import Body

# FastAPI 是这个 Demo 的后端入口。
# 这个文件负责两件事：
# 1. 把前端页面提供给浏览器访问
# 2. 提供文本转语音接口，返回 mp3 给前端播放
app = FastAPI()
CONFIG_PATH = Path("tuning_config.json")

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
    if not CONFIG_PATH.exists():
        return DEFAULT_CONFIG.copy()

    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return DEFAULT_CONFIG.copy()

    return {**DEFAULT_CONFIG, **saved}


def save_config(config):
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
    await generate(text)
    return FileResponse("output.mp3", media_type="audio/mpeg")


@app.get("/config")
def get_config():
    return load_config()


@app.post("/config")
def update_config(config: dict = Body(...)):
    merged = {**DEFAULT_CONFIG, **config}
    save_config(merged)
    return {"ok": True, "config": merged}
