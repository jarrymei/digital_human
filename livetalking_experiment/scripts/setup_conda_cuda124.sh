#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="$ROOT_DIR/upstream"
ENV_NAME="${ENV_NAME:-livetalking}"

conda create -n "$ENV_NAME" python=3.10 -y

echo
echo "Conda 环境已创建：$ENV_NAME"
echo "继续执行："
echo
echo "  conda activate $ENV_NAME"
echo "  conda install pytorch==2.5.0 torchvision==0.20.0 torchaudio==2.5.0 pytorch-cuda=12.4 -c pytorch -c nvidia"
echo "  cd $UPSTREAM_DIR"
echo "  pip install -r requirements.txt"
echo
echo "如果你的 CUDA 不是 12.4，请根据 nvidia-smi 结果安装匹配版本的 PyTorch。"

