#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

MODEL="${NEMOCLAW_SLACK_ACTION_ITEMS_MODEL:-Qwen/Qwen2.5-VL-7B-Instruct}"
SERVED_MODEL_NAME="${NEMOCLAW_SLACK_ACTION_ITEMS_SERVED_MODEL_NAME:-qwen-action-items}"
HOST="${NEMOCLAW_SLACK_ACTION_ITEMS_HOST:-0.0.0.0}"
PORT="${NEMOCLAW_SLACK_ACTION_ITEMS_PORT:-8001}"
GPU_DEVICES="${NEMOCLAW_SLACK_ACTION_ITEMS_CUDA_VISIBLE_DEVICES:-0}"
TENSOR_PARALLEL_SIZE="${NEMOCLAW_SLACK_ACTION_ITEMS_TENSOR_PARALLEL_SIZE:-}"
DTYPE="${NEMOCLAW_SLACK_ACTION_ITEMS_DTYPE:-auto}"
MAX_MODEL_LEN="${NEMOCLAW_SLACK_ACTION_ITEMS_MAX_MODEL_LEN:-8192}"
GPU_MEMORY_UTILIZATION="${NEMOCLAW_SLACK_ACTION_ITEMS_GPU_MEMORY_UTILIZATION:-}"
DISABLE_THINKING="${NEMOCLAW_SLACK_ACTION_ITEMS_DISABLE_THINKING:-auto}"
VENV="${NEMOCLAW_SLACK_ACTION_ITEMS_VENV:-$HOME/.venv}"
VLLM_BIN="${NEMOCLAW_SLACK_ACTION_ITEMS_VLLM_BIN:-}"
LOG_DIR="${NEMOCLAW_SLACK_ACTION_ITEMS_LOG_DIR:-$HOME/.nemoclaw/logs}"
LOG_FILE="${NEMOCLAW_SLACK_ACTION_ITEMS_LOG_FILE:-$LOG_DIR/slack-action-items-vllm.log}"
PID_FILE="${NEMOCLAW_SLACK_ACTION_ITEMS_PID_FILE:-$LOG_DIR/slack-action-items-vllm.pid}"
REPLACE=0
TAIL_LOG=1
FOREGROUND=0

usage() {
  cat <<'EOF'
Usage: scripts/start-slack-action-items-vllm.sh [options]

Start a host-local vLLM server tuned for `nemoclaw slack-action-items`.

Defaults:
  model:              Qwen/Qwen2.5-VL-7B-Instruct
  served model name:  qwen-action-items
  endpoint:           http://localhost:8001/v1
  GPUs:               0
  tensor parallel:    inferred from --gpus, default 1
  max model length:   8192
  thinking mode:      auto-disabled for Qwen3-family models only

Options:
  --model NAME                Hugging Face model to serve.
  --served-model-name NAME    Model ID exposed by /v1/models.
  --host HOST                 Bind host (default: 0.0.0.0).
  --port PORT                 Bind port (default: 8001).
  --gpus LIST                 CUDA_VISIBLE_DEVICES list (default: 0).
  --tensor-parallel-size N    vLLM tensor parallel size.
  --dtype DTYPE               vLLM dtype (default: auto).
  --max-model-len N           Maximum model context length (default: 8192).
  --gpu-memory-utilization F  Optional vLLM GPU memory utilization fraction.
  --replace                   Stop the current listener on --port before starting.
  --foreground                Run vLLM in the foreground instead of nohup/background.
  --no-tail                   Do not tail the log after background start.
  -h, --help                  Show this help.

Environment variables with the NEMOCLAW_SLACK_ACTION_ITEMS_* prefix can also
override these defaults.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

infer_tensor_parallel_size() {
  local devices="$1"
  if [ -z "$devices" ]; then
    printf '1\n'
    return
  fi
  awk -F, '{ print NF }' <<<"$devices"
}

thinking_disabled() {
  case "$DISABLE_THINKING" in
    1 | true | yes)
      return 0
      ;;
    0 | false | no)
      return 1
      ;;
    auto | "")
      case "$MODEL" in
        *Qwen3* | *qwen3*)
          return 0
          ;;
        *)
          return 1
          ;;
      esac
      ;;
    *)
      fail "NEMOCLAW_SLACK_ACTION_ITEMS_DISABLE_THINKING must be auto, 1, or 0."
      ;;
  esac
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null \
      | awk -v suffix=":${PORT}" '$4 ~ suffix "$" { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

stop_port_listener() {
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
    return
  fi
  pkill -f "vllm serve .*--port ${PORT}" >/dev/null 2>&1 || true
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --served-model-name)
      SERVED_MODEL_NAME="${2:-}"
      shift 2
      ;;
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --gpus)
      GPU_DEVICES="${2:-}"
      shift 2
      ;;
    --tensor-parallel-size)
      TENSOR_PARALLEL_SIZE="${2:-}"
      shift 2
      ;;
    --dtype)
      DTYPE="${2:-}"
      shift 2
      ;;
    --max-model-len)
      MAX_MODEL_LEN="${2:-}"
      shift 2
      ;;
    --gpu-memory-utilization)
      GPU_MEMORY_UTILIZATION="${2:-}"
      shift 2
      ;;
    --replace)
      REPLACE=1
      shift
      ;;
    --foreground)
      FOREGROUND=1
      TAIL_LOG=0
      shift
      ;;
    --no-tail)
      TAIL_LOG=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ -n "$MODEL" ] || fail "--model must not be empty."
[ -n "$SERVED_MODEL_NAME" ] || fail "--served-model-name must not be empty."
[ -n "$HOST" ] || fail "--host must not be empty."
[ -n "$PORT" ] || fail "--port must not be empty."
[ -n "$MAX_MODEL_LEN" ] || fail "--max-model-len must not be empty."

if [ -z "$TENSOR_PARALLEL_SIZE" ]; then
  TENSOR_PARALLEL_SIZE="$(infer_tensor_parallel_size "$GPU_DEVICES")"
fi

if [ -f "$VENV/bin/activate" ]; then
  # shellcheck source=/dev/null
  source "$VENV/bin/activate"
fi

if [ -z "$VLLM_BIN" ]; then
  if command -v vllm >/dev/null 2>&1; then
    VLLM_BIN="$(command -v vllm)"
  elif [ -x "$HOME/.venv/bin/vllm" ]; then
    VLLM_BIN="$HOME/.venv/bin/vllm"
  else
    fail "vLLM was not found. Activate a vLLM environment or set NEMOCLAW_SLACK_ACTION_ITEMS_VLLM_BIN."
  fi
fi

if port_in_use; then
  if [ "$REPLACE" -ne 1 ]; then
    fail "port $PORT is already in use. Pass --replace to stop the current listener first."
  fi
  printf 'Stopping current listener on port %s...\n' "$PORT"
  stop_port_listener
  sleep 3
  if port_in_use; then
    fail "port $PORT is still in use after --replace."
  fi
fi

mkdir -p "$LOG_DIR"

cmd=(
  "$VLLM_BIN" serve "$MODEL"
  --served-model-name "$SERVED_MODEL_NAME"
  --host "$HOST"
  --port "$PORT"
  --dtype "$DTYPE"
  --max-model-len "$MAX_MODEL_LEN"
  --tensor-parallel-size "$TENSOR_PARALLEL_SIZE"
  --trust-remote-code
)

if [ -n "$GPU_MEMORY_UTILIZATION" ]; then
  cmd+=(--gpu-memory-utilization "$GPU_MEMORY_UTILIZATION")
fi

if thinking_disabled; then
  cmd+=(--reasoning-parser qwen3)
  cmd+=(--default-chat-template-kwargs '{"enable_thinking": false}')
fi

printf 'Starting Slack action-items vLLM server...\n'
printf '  Model: %s\n' "$MODEL"
printf '  Served name: %s\n' "$SERVED_MODEL_NAME"
printf '  Endpoint: http://localhost:%s/v1\n' "$PORT"
printf '  CUDA_VISIBLE_DEVICES: %s\n' "$GPU_DEVICES"
printf '  Tensor parallel size: %s\n' "$TENSOR_PARALLEL_SIZE"
printf '  Max model length: %s\n' "$MAX_MODEL_LEN"
printf '  Log: %s\n' "$LOG_FILE"

if [ "$FOREGROUND" -eq 1 ]; then
  exec env CUDA_VISIBLE_DEVICES="$GPU_DEVICES" "${cmd[@]}"
fi

CUDA_VISIBLE_DEVICES="$GPU_DEVICES" nohup "${cmd[@]}" >"$LOG_FILE" 2>&1 &
pid=$!
printf '%s\n' "$pid" >"$PID_FILE"
printf 'vLLM PID: %s\n' "$pid"
printf 'PID file: %s\n' "$PID_FILE"

if [ "$TAIL_LOG" -eq 1 ]; then
  printf 'Tailing log. Press Ctrl-C to stop tailing; vLLM keeps running.\n'
  tail -f "$LOG_FILE"
fi
