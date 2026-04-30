#!/usr/bin/env python3
"""
离线版 Wav2Lip 核心 Demo。

这个脚本的目的不是替代 LiveTalking，而是把 LiveTalking 里最核心、最难
理解的一段单独拿出来学习：

    输入视频/图片 + 输入音频
        -> 把音频转成 mel 频谱片段
        -> 从每一帧里检测并裁出人脸
        -> 把“遮住下半脸的人脸 + 原始人脸 + 当前音频特征”送进 Wav2Lip
        -> 得到新的说话人脸区域
        -> 把这个区域贴回原视频帧
        -> 最后用 ffmpeg 合成音频，输出 result.mp4

和 LiveTalking 相比，这里故意去掉：

    - WebRTC
    - TTS
    - 多 session
    - 实时队列
    - 多线程
    - 前端页面

这样可以先看懂“Wav2Lip 到底怎么根据音频改嘴巴”，再回头理解
LiveTalking 的实时工程代码。
"""

from __future__ import annotations

import argparse
import math
import os
import platform
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from tqdm import tqdm


# 当前仓库根目录，例如：
# /mnt/e/workspace/myself/ai/digital_human
ROOT_DIR = Path(__file__).resolve().parents[1]

# 这个 Demo 不复制 Wav2Lip 源码，而是复用 LiveTalking 里已经下载好的实现。
# 这样学习代码可以保持很小，也避免同一套模型代码散落多份。
DEFAULT_UPSTREAM_DIR = ROOT_DIR / "livetalking_experiment" / "upstream"


def add_upstream_to_path(upstream_dir: Path) -> None:
    """把 LiveTalking 源码目录加入 Python import 搜索路径。

    后面会用到：

        from avatars.wav2lip import audio
        from avatars.wav2lip.models import Wav2Lip
        from avatars.wav2lip import face_detection

    这些模块都在 LiveTalking 的 upstream 目录中。
    """
    if not upstream_dir.exists():
        raise FileNotFoundError(f"LiveTalking upstream dir not found: {upstream_dir}")
    sys.path.insert(0, str(upstream_dir))


def parse_args() -> argparse.Namespace:
    """解析命令行参数。

    这个 Demo 只关心三个必需输入：

        --face       人脸图片或视频
        --audio      要驱动口型的音频
        --checkpoint Wav2Lip 权重

    其它参数都是为了处理常见素材问题，例如人脸框太小、视频太大、
    人脸检测失败等。
    """
    parser = argparse.ArgumentParser(description="Minimal offline Wav2Lip demo")
    parser.add_argument("--face", required=True, help="Input face image or video")
    parser.add_argument("--audio", required=True, help="Input audio file")
    parser.add_argument("--checkpoint", required=True, help="Wav2Lip checkpoint path")
    parser.add_argument("--outfile", default="outputs/result.mp4", help="Output mp4 path")
    parser.add_argument("--upstream-dir", default=str(DEFAULT_UPSTREAM_DIR), help="LiveTalking upstream dir")
    parser.add_argument("--img-size", type=int, default=256, help="Wav2Lip face crop size")
    parser.add_argument("--fps", type=float, default=25.0, help="FPS for static image input")
    parser.add_argument("--static", action="store_true", help="Use only the first frame")
    parser.add_argument("--batch-size", type=int, default=8, help="Wav2Lip inference batch size")
    parser.add_argument("--face-det-batch-size", type=int, default=16, help="Face detection batch size")
    parser.add_argument("--resize-factor", type=int, default=1, help="Downscale input video by this factor")
    parser.add_argument("--rotate", action="store_true", help="Rotate input frames 90 degrees clockwise")
    parser.add_argument("--nosmooth", action="store_true", help="Disable face box smoothing")
    parser.add_argument(
        "--pads",
        nargs=4,
        type=int,
        default=[0, 10, 0, 0],
        metavar=("TOP", "BOTTOM", "LEFT", "RIGHT"),
        help="Padding around detected face box",
    )
    parser.add_argument(
        "--crop",
        nargs=4,
        type=int,
        default=[0, -1, 0, -1],
        metavar=("TOP", "BOTTOM", "LEFT", "RIGHT"),
        help="Crop input frame before face detection",
    )
    parser.add_argument(
        "--box",
        nargs=4,
        type=int,
        default=[-1, -1, -1, -1],
        metavar=("TOP", "BOTTOM", "LEFT", "RIGHT"),
        help="Manual face box. Use only when detection fails.",
    )
    return parser.parse_args()


def is_image(path: Path) -> bool:
    """判断输入是不是静态图片。

    图片输入和视频输入的区别：

        图片：只有一帧，会重复用这一帧生成说话视频
        视频：有多帧，会按时间顺序循环使用视频帧
    """
    return path.suffix.lower() in {".jpg", ".jpeg", ".png"}


def read_face_frames(face_path: Path, args: argparse.Namespace) -> tuple[list[np.ndarray], float]:
    """读取输入人脸素材，返回视频帧列表和 fps。

    返回的 frames 是 OpenCV 的 BGR 图像数组，每一项形状类似：

        [height, width, 3]

    Wav2Lip 最终不是生成整张新视频，而是先改人脸区域，再贴回这些
    原始帧，所以这里要保留完整帧。
    """
    if not face_path.exists():
        raise FileNotFoundError(f"Face input not found: {face_path}")

    if is_image(face_path):
        # 静态图片没有原始 fps，所以使用命令行传入的 --fps。
        frame = cv2.imread(str(face_path))
        if frame is None:
            raise ValueError(f"Could not read image: {face_path}")
        return [frame], args.fps

    video = cv2.VideoCapture(str(face_path))
    fps = video.get(cv2.CAP_PROP_FPS) or args.fps
    frames: list[np.ndarray] = []

    while True:
        ok, frame = video.read()
        if not ok:
            break

        if args.resize_factor > 1:
            # 大分辨率视频会增加人脸检测和贴回开销。
            # 学习阶段可以先缩小输入，确认流程跑通。
            frame = cv2.resize(
                frame,
                (frame.shape[1] // args.resize_factor, frame.shape[0] // args.resize_factor),
            )

        if args.rotate:
            # 手机竖屏视频有时元数据和实际方向不一致，可以用这个开关修正。
            frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)

        top, bottom, left, right = args.crop
        if bottom == -1:
            bottom = frame.shape[0]
        if right == -1:
            right = frame.shape[1]
        # crop 是在人脸检测前先裁画面。
        # 如果画面里有多个人，或者脸只在画面一角，可以先裁出目标区域。
        frames.append(frame[top:bottom, left:right])

    video.release()

    if not frames:
        raise ValueError(f"No frames read from: {face_path}")

    if args.static:
        # --static 表示即使输入是视频，也只取第一帧。
        # 这适合先验证“单张图 + 音频 -> 说话视频”的最小链路。
        frames = [frames[0]]

    return frames, fps


def build_mel_chunks(audio_path: Path, fps: float):
    """把音频转成 Wav2Lip 需要的 mel 频谱片段。

    Wav2Lip 不是直接吃 wav/mp3 原始波形，而是吃一个短时间窗口的
    mel spectrogram。可以把 mel 理解成：

        每个时间片上，不同频率区域的能量分布

    单个 mel chunk 的形状是：

        [80, 16]

    80 表示 mel 频率维度，16 表示当前视频帧附近的一小段时间窗口。
    """
    from avatars.wav2lip import audio

    if not audio_path.exists():
        raise FileNotFoundError(f"Audio input not found: {audio_path}")

    # Wav2Lip 训练和推理通常使用 16kHz 音频。
    # LiveTalking 实时链路里也会把 TTS 音频重采样到 16000。
    wav = audio.load_wav(str(audio_path), 16000)
    mel = audio.melspectrogram(wav)

    if np.isnan(mel.reshape(-1)).sum() > 0:
        raise ValueError("Mel contains NaN. Try another audio file or add tiny noise to the wav.")

    mel_step_size = 16
    # mel 的时间轴和视频帧率不是一个单位。
    # 这里用 80/fps 把“第几帧视频”映射到“mel 上的起始位置”。
    # 这是 Wav2Lip 原始推理脚本里的常用写法。
    mel_idx_multiplier = 80.0 / fps
    mel_chunks = []
    index = 0

    while True:
        start_idx = int(index * mel_idx_multiplier)
        if start_idx + mel_step_size > len(mel[0]):
            # 音频末尾不够 16 个 mel step 时，用最后一段补齐。
            mel_chunks.append(mel[:, len(mel[0]) - mel_step_size :])
            break
        mel_chunks.append(mel[:, start_idx : start_idx + mel_step_size])
        index += 1

    return mel_chunks


def smooth_boxes(boxes: np.ndarray, window_size: int = 5) -> np.ndarray:
    """平滑人脸检测框。

    人脸检测每一帧都会有一点抖动。如果直接用逐帧检测框贴回，
    嘴巴区域会轻微跳动。这里用一个小窗口取平均，让检测框更稳定。
    """
    for i in range(len(boxes)):
        if i + window_size > len(boxes):
            window = boxes[len(boxes) - window_size :]
        else:
            window = boxes[i : i + window_size]
        boxes[i] = np.mean(window, axis=0)
    return boxes


def detect_faces(frames: list[np.ndarray], args: argparse.Namespace, device: str):
    """检测每一帧的人脸区域。

    返回列表中的每一项是：

        [face_crop, (y1, y2, x1, x2)]

    face_crop 会被 resize 后送进 Wav2Lip；
    坐标 (y1, y2, x1, x2) 用于之后把模型输出贴回原图。
    """
    from avatars.wav2lip import face_detection

    if args.box[0] != -1:
        # 人脸检测失败时可以手动指定框。
        # 注意命令行里 box 的顺序是 top bottom left right，
        # 这里返回的 coords 使用后续贴回更方便的 y1 y2 x1 x2。
        top, bottom, left, right = args.box
        return [[frame[top:bottom, left:right], (top, bottom, left, right)] for frame in frames]

    detector = face_detection.FaceAlignment(
        face_detection.LandmarksType._2D,
        flip_input=False,
        device=device,
    )

    batch_size = args.face_det_batch_size
    while True:
        predictions = []
        try:
            for i in tqdm(range(0, len(frames), batch_size), desc="detect faces"):
                # 批量检测人脸比一帧一帧检测更快。
                predictions.extend(detector.get_detections_for_batch(np.array(frames[i : i + batch_size])))
        except RuntimeError:
            if batch_size == 1:
                raise
            # 显存不足时自动减小检测 batch。
            batch_size //= 2
            print(f"Face detection OOM. Retrying with batch size {batch_size}.")
            continue
        break

    top_pad, bottom_pad, left_pad, right_pad = args.pads
    boxes = []
    for rect, frame in zip(predictions, frames):
        if rect is None:
            raise ValueError("Face not detected in at least one frame. Try --box or clearer input.")

        # rect 是检测到的人脸框。pads 用来额外包含下巴、嘴周边等区域。
        # 对 Wav2Lip 来说，下巴和嘴周边没裁进去会明显影响贴回效果。
        y1 = max(0, rect[1] - top_pad)
        y2 = min(frame.shape[0], rect[3] + bottom_pad)
        x1 = max(0, rect[0] - left_pad)
        x2 = min(frame.shape[1], rect[2] + right_pad)
        boxes.append([x1, y1, x2, y2])

    boxes = np.array(boxes)
    if not args.nosmooth:
        boxes = smooth_boxes(boxes)

    results = []
    for frame, (x1, y1, x2, y2) in zip(frames, boxes):
        x1, y1, x2, y2 = map(int, [x1, y1, x2, y2])
        # 注意这里 coords 保存成 (y1, y2, x1, x2)，因为 NumPy 图像切片
        # 使用 frame[y1:y2, x1:x2] 这种顺序。
        results.append([frame[y1:y2, x1:x2], (y1, y2, x1, x2)])
    return results


def make_batches(
    frames: list[np.ndarray],
    mel_chunks: list[np.ndarray],
    face_results,
    args: argparse.Namespace,
):
    """把帧、人脸框、mel 特征组装成模型推理 batch。

    每个视频帧需要对应一个 mel chunk：

        第 i 帧图像 + 第 i 段音频特征 -> 第 i 帧说话结果

    batch 只是为了提高推理效率；概念上仍然是一帧一帧处理。
    """
    img_batch, mel_batch, frame_batch, coord_batch = [], [], [], []

    for i, mel in enumerate(mel_chunks):
        # 如果是静态图片，永远用第 0 帧；
        # 如果是视频，按时间顺序取帧，音频比视频长时会循环使用视频帧。
        frame_idx = 0 if args.static else i % len(frames)
        frame_to_save = frames[frame_idx].copy()
        face, coords = face_results[frame_idx]

        # Wav2Lip 的输入尺寸必须和权重匹配。
        # LiveTalking 的 wav2lip256 权重通常使用 256。
        face = cv2.resize(face, (args.img_size, args.img_size))
        img_batch.append(face)
        mel_batch.append(mel)
        frame_batch.append(frame_to_save)
        coord_batch.append(coords)

        if len(img_batch) >= args.batch_size:
            yield prepare_batch(img_batch, mel_batch), frame_batch, coord_batch
            img_batch, mel_batch, frame_batch, coord_batch = [], [], [], []

    if img_batch:
        yield prepare_batch(img_batch, mel_batch), frame_batch, coord_batch


def prepare_batch(img_batch, mel_batch):
    """把普通 NumPy 图像列表整理成 Wav2Lip 的输入格式。

    输入的人脸图像原始形状：

        [B, H, W, 3]

    Wav2Lip 需要的图像输入：

        [B, H, W, 6]

    这 6 个通道由两部分拼接而成：

        masked_face   遮住下半脸的人脸
        original_face 原始人脸

    为什么要遮住下半脸？

        这是给模型一个“填空题”：上半脸和身份信息保留，下半脸嘴部区域
        被遮住，模型根据音频特征预测嘴巴应该长什么样。
    """
    img_batch = np.asarray(img_batch)
    mel_batch = np.asarray(mel_batch)

    img_masked = img_batch.copy()
    # 直接把人脸下半部分置 0，近似遮住嘴巴和下巴区域。
    img_masked[:, img_batch.shape[1] // 2 :] = 0
    # 在通道维度拼接，得到 3 + 3 = 6 个通道。
    # 除以 255 是把像素从 0-255 归一化到 0-1。
    img_batch = np.concatenate((img_masked, img_batch), axis=3) / 255.0
    # mel 原始是 [B, 80, 16]，这里补一个 channel 维度：
    # [B, 80, 16, 1]
    mel_batch = np.reshape(mel_batch, [len(mel_batch), mel_batch.shape[1], mel_batch.shape[2], 1])

    return img_batch, mel_batch


def load_model(checkpoint_path: Path, device: str):
    """加载 Wav2Lip 权重。

    checkpoint 里通常保存的是训练时的 state_dict。
    如果模型是多卡训练保存的，参数名前面会带 module.，
    所以这里统一去掉这个前缀。
    """
    from avatars.wav2lip.models import Wav2Lip

    model = Wav2Lip()
    # GPU 可用时直接加载到默认 CUDA 设备；否则映射到 CPU。
    checkpoint = torch.load(
        str(checkpoint_path),
        map_location=None if device == "cuda" else lambda storage, loc: storage,
    )
    state_dict = checkpoint["state_dict"]
    model.load_state_dict({key.replace("module.", ""): value for key, value in state_dict.items()})
    # eval() 会关闭训练态行为，例如 dropout/batchnorm 的训练更新。
    return model.to(device).eval()


def run_inference(model, img_batch: np.ndarray, mel_batch: np.ndarray, device: str):
    """执行一次 Wav2Lip batch 推理。

    prepare_batch() 输出的是 NHWC：

        img_batch: [B, H, W, 6]
        mel_batch: [B, 80, 16, 1]

    PyTorch 卷积模型通常使用 NCHW，所以需要转成：

        img_tensor: [B, 6, H, W]
        mel_tensor: [B, 1, 80, 16]

    模型输出：

        pred: [B, 3, H, W]

    再转回 OpenCV 更习惯的 NHWC：

        [B, H, W, 3]
    """
    img_tensor = torch.FloatTensor(np.transpose(img_batch, (0, 3, 1, 2))).to(device)
    mel_tensor = torch.FloatTensor(np.transpose(mel_batch, (0, 3, 1, 2))).to(device)

    # 这是纯推理，不需要梯度，关闭梯度能减少显存和计算开销。
    with torch.no_grad():
        pred = model(mel_tensor, img_tensor)

    # 模型输出通常是 0-1 范围，乘 255 转回图像像素范围。
    return pred.cpu().numpy().transpose(0, 2, 3, 1) * 255.0


def paste_prediction(frame: np.ndarray, pred: np.ndarray, coords) -> np.ndarray:
    """把模型预测的人脸区域贴回原始视频帧。

    Wav2Lip 只预测裁剪后的人脸区域，不直接输出整张视频帧。
    因此需要：

        1. 把 pred resize 回原检测框大小
        2. 用 pred 覆盖原图对应区域

    LiveTalking 里的 paste_back_frame 做的也是同类事情。
    """
    y1, y2, x1, x2 = coords
    pred = cv2.resize(pred.astype(np.uint8), (x2 - x1, y2 - y1))
    frame[y1:y2, x1:x2] = pred
    return frame


def mux_audio(video_path: Path, audio_path: Path, outfile: Path) -> None:
    """用 ffmpeg 把无声视频和原音频合成为最终 mp4。

    OpenCV 的 VideoWriter 只负责写视频帧，不方便处理音频。
    所以前面先生成一个无声视频，这里再交给 ffmpeg 合成。
    """
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        str(outfile),
    ]
    # check=True 表示 ffmpeg 失败时直接抛异常，避免生成一个坏文件还误以为成功。
    subprocess.run(command, check=True)


def main() -> None:
    """主流程。

    这个函数按学习顺序串起来：

        1. 解析参数
        2. 读取视频/图片帧
        3. 读取音频并切 mel
        4. 检测人脸
        5. 加载模型
        6. 分 batch 推理
        7. 贴回并写无声视频
        8. 合成音频
    """
    args = parse_args()
    upstream_dir = Path(args.upstream_dir).resolve()
    add_upstream_to_path(upstream_dir)

    face_path = Path(args.face)
    audio_path = Path(args.audio)
    checkpoint_path = Path(args.checkpoint)
    outfile = Path(args.outfile)
    temp_dir = outfile.parent / "_tmp"
    # outputs/_tmp 保存中间无声视频，方便需要时排查“推理帧是否正常”。
    temp_dir.mkdir(parents=True, exist_ok=True)
    outfile.parent.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using {device} for inference.")

    # frames 是完整视频帧，后面会被用作最终贴回的背景。
    frames, fps = read_face_frames(face_path, args)
    # mel_chunks 的数量基本决定最终输出视频有多少帧。
    mel_chunks = build_mel_chunks(audio_path, fps)
    # 视频比音频长时，只保留音频对应长度；
    # 图片模式下 frames 只有一帧，会在 make_batches 里重复使用。
    frames = frames[: len(mel_chunks)] if not args.static else frames
    print(f"frames: {len(frames)}, mel chunks: {len(mel_chunks)}, fps: {fps:.2f}")

    # 人脸检测只做一次，后续 batch 推理直接复用检测结果。
    face_results = detect_faces(frames, args, device)
    model = load_model(checkpoint_path, device)

    frame_h, frame_w = frames[0].shape[:2]
    silent_video = temp_dir / "result_silent.mp4"
    writer = cv2.VideoWriter(
        str(silent_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (frame_w, frame_h),
    )

    total_batches = math.ceil(len(mel_chunks) / args.batch_size)
    # batches 每次产出：
    #
    #   (img_batch, mel_batch)  -> 给模型
    #   frame_batch            -> 原始帧，用于贴回
    #   coord_batch            -> 贴回坐标
    batches = make_batches(frames, mel_chunks, face_results, args)

    for (img_batch, mel_batch), frame_batch, coord_batch in tqdm(batches, total=total_batches, desc="wav2lip"):
        predictions = run_inference(model, img_batch, mel_batch, device)
        for pred, frame, coords in zip(predictions, frame_batch, coord_batch):
            # 每个 pred 只是一块人脸区域，需要贴回整张 frame 后才能写入视频。
            writer.write(paste_prediction(frame, pred, coords))

    writer.release()
    # 最终输出带音频的 mp4。
    mux_audio(silent_video, audio_path, outfile)
    print(f"Done: {outfile}")


if __name__ == "__main__":
    main()
