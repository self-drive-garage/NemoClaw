#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

MODEL="nvidia/nemotron-3-super-120b-a12b"
IMAGE="${NEMOCLAW_NEMOTRON_SUPER_NIM_IMAGE:-nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b:latest}"
CONTAINER_NAME="${NEMOCLAW_NEMOTRON_SUPER_NIM_CONTAINER:-nemoclaw-nim-nemotron-super}"
HOST_PORT="${NEMOCLAW_NEMOTRON_SUPER_NIM_PORT:-8000}"
GPU_DEVICES="${NEMOCLAW_NEMOTRON_SUPER_NIM_GPUS:-all}"
SHM_SIZE="${NEMOCLAW_NEMOTRON_SUPER_NIM_SHM_SIZE:-16g}"
CACHE_DIR="${NEMOCLAW_NEMOTRON_SUPER_NIM_CACHE_DIR:-$HOME/.cache/nim}"
CACHE_UID="${NEMOCLAW_NEMOTRON_SUPER_NIM_CACHE_UID:-1000}"
CACHE_GID="${NEMOCLAW_NEMOTRON_SUPER_NIM_CACHE_GID:-1000}"
READY_TIMEOUT="${NEMOCLAW_NEMOTRON_SUPER_NIM_READY_TIMEOUT:-1800}"
PULL_IMAGE=1
REPLACE=0
SKIP_GPU_CHECK=0
KILL_GPU_PROCESSES="${NEMOCLAW_NEMOTRON_SUPER_NIM_KILL_GPU_PROCESSES:-0}"
GPU_KILL_GRACE_SECONDS="${NEMOCLAW_NEMOTRON_SUPER_NIM_GPU_KILL_GRACE_SECONDS:-10}"
ALLOW_MISSING_NGC_API_KEY=0
TAIL_LOG=1
STOP_ONLY=0
STATUS_ONLY=0
DISABLE_CUDA_GRAPH="${NEMOCLAW_NEMOTRON_SUPER_NIM_DISABLE_CUDA_GRAPH:-0}"
DISABLE_NCCL_P2P="${NEMOCLAW_NEMOTRON_SUPER_NIM_DISABLE_NCCL_P2P:-0}"
NIM_PASSTHROUGH_ARGS_VALUE="${NEMOCLAW_NEMOTRON_SUPER_NIM_PASSTHROUGH_ARGS:-}"

usage() {
  cat <<'EOF'
Usage: scripts/start-nemotron-super-nim.sh [options]

Start NVIDIA Nemotron 3 Super 120B locally as a NIM container.

Defaults:
  model:       nvidia/nemotron-3-super-120b-a12b
  image:       nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b:latest
  endpoint:    http://localhost:8000/v1
  GPUs:        all GPUs (intended for 8 x H100 80GB)
  container:   nemoclaw-nim-nemotron-super

Options:
  --port PORT             Host port mapped to container port 8000 (default: 8000).
  --gpus LIST|all         Docker GPU selector, for example all or 0,1,2,3.
  --container-name NAME   Docker container name.
  --image IMAGE           Override the NIM image.
  --cache-dir PATH        Host cache mounted at /opt/nim/.cache.
  --cache-uid UID         UID that should own the cache for the NIM container.
  --cache-gid GID         GID that should own the cache for the NIM container.
  --timeout SECONDS       Readiness timeout (default: 1800).
  --replace               Stop an existing container with the same name first.
  --no-pull               Skip docker pull.
  --skip-gpu-check        Skip the 8 x H100 / free-memory preflight.
  --kill-gpu-processes    Terminate processes using the selected GPUs before
                          the GPU preflight. Sends TERM, waits, then KILLs
                          remaining processes.
  --gpu-kill-grace SECONDS
                          Wait time between TERM and KILL (default: 10).
  --allow-missing-ngc-api-key
                          Start without NGC_API_KEY. Only useful when all
                          required model artifacts are already cached.
  --disable-cuda-graph    Set NIM_DISABLE_CUDA_GRAPH=true. This can avoid
                          CUDA graph/P2P failures on PCIe-only multi-GPU hosts.
  --disable-nccl-p2p      Set NCCL_P2P_DISABLE=1. This can avoid peer GPU
                          memory failures on topologies without NVLink/NVSwitch.
  --nim-passthrough-args ARGS
                          Extra vLLM args passed through NIM_PASSTHROUGH_ARGS.
  --no-tail               Do not follow docker logs after startup.
  --status                Show current container status and model endpoint state.
  --stop                  Stop and remove the container, then exit.
  -h, --help              Show this help.

If docker pull requires authentication, either run `docker login nvcr.io` first
or export NGC_API_KEY. When NGC_API_KEY is set, this script passes it to the
container as well. Docker login alone is not enough for first-run model
artifact downloads inside the NIM container.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

gpu_selected() {
  local index="$1"
  local selector="$2"
  local piece
  [ "$selector" = "all" ] && return 0
  IFS=',' read -ra pieces <<<"$selector"
  for piece in "${pieces[@]}"; do
    [ "$(trim "$piece")" = "$index" ] && return 0
  done
  return 1
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null \
      | awk -v suffix=":${HOST_PORT}" '$4 ~ suffix "$" { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"
}

container_running() {
  docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"
}

sudo_available() {
  command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null
}

stop_container() {
  if container_exists; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
    printf 'Stopped container: %s\n' "$CONTAINER_NAME"
  else
    printf 'Container is not present: %s\n' "$CONTAINER_NAME"
  fi
}

show_status() {
  if container_exists; then
    docker ps -a --filter "name=^/${CONTAINER_NAME}$" \
      --format 'container={{.Names}} status={{.Status}} image={{.Image}} ports={{.Ports}}'
  else
    printf 'container=%s status=absent\n' "$CONTAINER_NAME"
  fi

  if curl -sf --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HOST_PORT}/v1/models" >/tmp/nim-models.$$ 2>/dev/null; then
    printf 'endpoint=http://localhost:%s/v1 status=ready\n' "$HOST_PORT"
    cat /tmp/nim-models.$$
    printf '\n'
  else
    printf 'endpoint=http://localhost:%s/v1 status=not-ready\n' "$HOST_PORT"
  fi
  rm -f /tmp/nim-models.$$
}

process_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null && return 0
  if sudo_available; then
    sudo kill -0 "$pid" 2>/dev/null && return 0
  fi
  return 1
}

signal_process() {
  local signal="$1"
  local pid="$2"
  kill "-${signal}" "$pid" 2>/dev/null && return 0
  if sudo_available; then
    sudo kill "-${signal}" "$pid" 2>/dev/null && return 0
  fi
  return 1
}

kill_gpu_processes() {
  command -v nvidia-smi >/dev/null 2>&1 || fail "nvidia-smi was not found."

  local -a pids=()
  local -a descriptions=()
  local -A seen=()
  local index pid process_name used_memory
  while IFS= read -r index; do
    index="$(trim "$index")"
    if ! gpu_selected "$index" "$GPU_DEVICES"; then
      continue
    fi
    while IFS=',' read -r pid process_name used_memory; do
      pid="$(trim "$pid")"
      process_name="$(trim "${process_name:-unknown}")"
      used_memory="$(trim "${used_memory:-unknown}")"
      [ -n "$pid" ] || continue
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      [ "$pid" != "$$" ] || continue
      if [ -n "${seen[$pid]:-}" ]; then
        continue
      fi
      seen[$pid]=1
      pids+=("$pid")
      descriptions+=("pid=${pid} gpu=${index} mem=${used_memory}MiB cmd=${process_name}")
    done < <(
      nvidia-smi --id="$index" \
        --query-compute-apps=pid,process_name,used_memory \
        --format=csv,noheader,nounits 2>/dev/null || true
    )
  done < <(nvidia-smi --query-gpu=index --format=csv,noheader,nounits)

  if [ "${#pids[@]}" -eq 0 ]; then
    printf 'No GPU processes found on selected GPUs.\n'
    return
  fi

  printf 'Terminating GPU processes on selected GPUs:\n'
  printf '  %s\n' "${descriptions[@]}"

  local pid failed=0
  for pid in "${pids[@]}"; do
    if ! signal_process TERM "$pid"; then
      printf '  Could not send TERM to pid=%s.\n' "$pid" >&2
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || fail "failed to terminate one or more GPU processes."

  if [ "$GPU_KILL_GRACE_SECONDS" -gt 0 ]; then
    sleep "$GPU_KILL_GRACE_SECONDS"
  fi

  local -a remaining=()
  for pid in "${pids[@]}"; do
    if process_alive "$pid"; then
      remaining+=("$pid")
    fi
  done
  if [ "${#remaining[@]}" -eq 0 ]; then
    printf 'GPU processes terminated cleanly.\n'
    return
  fi

  printf 'Force killing remaining GPU processes: %s\n' "${remaining[*]}"
  for pid in "${remaining[@]}"; do
    if ! signal_process KILL "$pid"; then
      printf '  Could not send KILL to pid=%s.\n' "$pid" >&2
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || fail "failed to force kill one or more GPU processes."
}

check_gpus() {
  command -v nvidia-smi >/dev/null 2>&1 || fail "nvidia-smi was not found."

  local selected=0
  local busy=0
  local weak=0
  local line index name total used
  while IFS=',' read -r index name total used; do
    index="$(trim "$index")"
    name="$(trim "$name")"
    total="$(trim "$total")"
    used="$(trim "$used")"
    if ! gpu_selected "$index" "$GPU_DEVICES"; then
      continue
    fi
    selected=$((selected + 1))
    if ! [[ "$name" =~ H100 ]]; then
      weak=1
      printf '  GPU %s is %s, not H100.\n' "$index" "$name" >&2
    fi
    if [ "${total:-0}" -lt 80000 ]; then
      weak=1
      printf '  GPU %s has %s MiB, expected about 80GB.\n' "$index" "$total" >&2
    fi
    if [ "${used:-0}" -gt 2048 ]; then
      busy=1
      printf '  GPU %s is already using %s MiB.\n' "$index" "$used" >&2
    fi
  done < <(nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv,noheader,nounits)

  [ "$selected" -gt 0 ] || fail "no GPUs matched --gpus '$GPU_DEVICES'."
  if [ "$selected" -lt 8 ]; then
    fail "Nemotron 3 Super NIM is sized for 8 x H100 80GB; selected only ${selected} GPU(s). Use --skip-gpu-check only if this is intentional."
  fi
  [ "$weak" -eq 0 ] || fail "GPU preflight failed for the selected device set."
  [ "$busy" -eq 0 ] || fail "selected GPUs are not free enough. Stop existing GPU services or use --skip-gpu-check."
}

pull_image() {
  [ "$PULL_IMAGE" -eq 1 ] || return 0
  printf 'Pulling NIM image: %s\n' "$IMAGE"
  if docker pull "$IMAGE"; then
    return 0
  fi
  if [ -z "${NGC_API_KEY:-}" ]; then
    fail "docker pull failed. Run 'docker login nvcr.io' or export NGC_API_KEY, then retry."
  fi
  printf 'docker pull failed; retrying after nvcr.io login with NGC_API_KEY...\n'
  printf '%s' "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin
  docker pull "$IMAGE"
}

require_ngc_api_key() {
  if [ -n "${NGC_API_KEY:-}" ] || [ "$ALLOW_MISSING_NGC_API_KEY" -eq 1 ]; then
    return
  fi
  fail "NGC_API_KEY is required for first-run NIM model downloads. Export NGC_API_KEY or pass --allow-missing-ngc-api-key only if the model artifacts are already cached."
}

prepare_cache_dir() {
  local sudo_cmd=()
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo_cmd=(sudo)
  fi

  if ! mkdir -p "$CACHE_DIR/tmp" 2>/dev/null; then
    if [ "${#sudo_cmd[@]}" -gt 0 ]; then
      "${sudo_cmd[@]}" mkdir -p "$CACHE_DIR/tmp"
    else
      fail "cache directory '$CACHE_DIR' could not be created. Run: sudo mkdir -p '$CACHE_DIR/tmp'"
    fi
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown -R "${CACHE_UID}:${CACHE_GID}" "$CACHE_DIR"
    chmod 0775 "$CACHE_DIR" "$CACHE_DIR/tmp"
    return
  fi
  if [ "${#sudo_cmd[@]}" -gt 0 ]; then
    "${sudo_cmd[@]}" chown -R "${CACHE_UID}:${CACHE_GID}" "$CACHE_DIR"
    "${sudo_cmd[@]}" chmod 0775 "$CACHE_DIR" "$CACHE_DIR/tmp"
    return
  fi
  chmod 0775 "$CACHE_DIR" "$CACHE_DIR/tmp" 2>/dev/null || true
  if [ -w "$CACHE_DIR/tmp" ]; then
    return
  fi
  fail "cache directory '$CACHE_DIR' is not writable by the NIM container. Run: sudo chown -R ${CACHE_UID}:${CACHE_GID} '$CACHE_DIR'"
}

wait_for_ready() {
  local start now elapsed
  start="$(date +%s)"
  printf 'Waiting for NIM readiness on http://localhost:%s/v1/models (timeout: %ss)...\n' "$HOST_PORT" "$READY_TIMEOUT"
  while true; do
    if curl -sf --connect-timeout 5 --max-time 10 "http://127.0.0.1:${HOST_PORT}/v1/models" >/dev/null; then
      printf 'NIM is ready: http://localhost:%s/v1\n' "$HOST_PORT"
      return 0
    fi
    if ! container_running; then
      docker logs --tail 120 "$CONTAINER_NAME" >&2 || true
      fail "NIM container exited before becoming ready."
    fi
    now="$(date +%s)"
    elapsed=$((now - start))
    if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then
      docker logs --tail 120 "$CONTAINER_NAME" >&2 || true
      fail "NIM did not become ready within ${READY_TIMEOUT}s."
    fi
    sleep 10
  done
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      HOST_PORT="${2:-}"
      shift 2
      ;;
    --gpus)
      GPU_DEVICES="${2:-}"
      shift 2
      ;;
    --container-name)
      CONTAINER_NAME="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --cache-dir)
      CACHE_DIR="${2:-}"
      shift 2
      ;;
    --cache-uid)
      CACHE_UID="${2:-}"
      shift 2
      ;;
    --cache-gid)
      CACHE_GID="${2:-}"
      shift 2
      ;;
    --timeout)
      READY_TIMEOUT="${2:-}"
      shift 2
      ;;
    --replace)
      REPLACE=1
      shift
      ;;
    --no-pull)
      PULL_IMAGE=0
      shift
      ;;
    --skip-gpu-check)
      SKIP_GPU_CHECK=1
      shift
      ;;
    --kill-gpu-processes)
      KILL_GPU_PROCESSES=1
      shift
      ;;
    --gpu-kill-grace)
      GPU_KILL_GRACE_SECONDS="${2:-}"
      shift 2
      ;;
    --allow-missing-ngc-api-key)
      ALLOW_MISSING_NGC_API_KEY=1
      shift
      ;;
    --disable-cuda-graph)
      DISABLE_CUDA_GRAPH=1
      shift
      ;;
    --disable-nccl-p2p)
      DISABLE_NCCL_P2P=1
      shift
      ;;
    --nim-passthrough-args)
      NIM_PASSTHROUGH_ARGS_VALUE="${2:-}"
      shift 2
      ;;
    --no-tail)
      TAIL_LOG=0
      shift
      ;;
    --status)
      STATUS_ONLY=1
      shift
      ;;
    --stop)
      STOP_ONLY=1
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

[ -n "$HOST_PORT" ] || fail "--port must not be empty."
[ -n "$GPU_DEVICES" ] || fail "--gpus must not be empty."
[ -n "$CONTAINER_NAME" ] || fail "--container-name must not be empty."
[ -n "$IMAGE" ] || fail "--image must not be empty."
[ -n "$CACHE_DIR" ] || fail "--cache-dir must not be empty."
[ -n "$CACHE_UID" ] || fail "--cache-uid must not be empty."
[ -n "$CACHE_GID" ] || fail "--cache-gid must not be empty."
[ -n "$READY_TIMEOUT" ] || fail "--timeout must not be empty."
[ -n "$GPU_KILL_GRACE_SECONDS" ] || fail "--gpu-kill-grace must not be empty."
[[ "$GPU_KILL_GRACE_SECONDS" =~ ^[0-9]+$ ]] || fail "--gpu-kill-grace must be a non-negative integer."

if [ "$STOP_ONLY" -eq 1 ]; then
  stop_container
  exit 0
fi

if [ "$STATUS_ONLY" -eq 1 ]; then
  show_status
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "docker was not found."
docker info >/dev/null 2>&1 || fail "docker is not running or is not accessible."

if container_exists; then
  if [ "$REPLACE" -ne 1 ]; then
    fail "container '$CONTAINER_NAME' already exists. Pass --replace or --stop."
  fi
  stop_container
fi

if [ "$KILL_GPU_PROCESSES" -eq 1 ]; then
  kill_gpu_processes
fi

if [ "$SKIP_GPU_CHECK" -ne 1 ]; then
  check_gpus
fi

require_ngc_api_key

if port_in_use; then
  fail "port $HOST_PORT is already in use. Stop that service or pass --port."
fi

pull_image

prepare_cache_dir

gpu_arg="$GPU_DEVICES"
if [ "$GPU_DEVICES" != "all" ]; then
  gpu_arg="device=${GPU_DEVICES}"
fi

env_args=()
if [ -n "${NGC_API_KEY:-}" ]; then
  env_args+=("-e" "NGC_API_KEY")
fi
if [ "$DISABLE_CUDA_GRAPH" -eq 1 ]; then
  env_args+=("-e" "NIM_DISABLE_CUDA_GRAPH=true")
fi
if [ "$DISABLE_NCCL_P2P" -eq 1 ]; then
  env_args+=("-e" "NCCL_P2P_DISABLE=1")
fi
if [ -n "$NIM_PASSTHROUGH_ARGS_VALUE" ]; then
  env_args+=("-e" "NIM_PASSTHROUGH_ARGS=$NIM_PASSTHROUGH_ARGS_VALUE")
fi

printf 'Starting Nemotron 3 Super NIM...\n'
printf '  Model: %s\n' "$MODEL"
printf '  Image: %s\n' "$IMAGE"
printf '  Container: %s\n' "$CONTAINER_NAME"
printf '  Endpoint: http://localhost:%s/v1\n' "$HOST_PORT"
printf '  GPUs: %s\n' "$GPU_DEVICES"
printf '  Cache: %s\n' "$CACHE_DIR"
if [ "$DISABLE_CUDA_GRAPH" -eq 1 ]; then
  printf '  NIM_DISABLE_CUDA_GRAPH: true\n'
fi
if [ "$DISABLE_NCCL_P2P" -eq 1 ]; then
  printf '  NCCL_P2P_DISABLE: 1\n'
fi
if [ -n "$NIM_PASSTHROUGH_ARGS_VALUE" ]; then
  printf '  NIM_PASSTHROUGH_ARGS: %s\n' "$NIM_PASSTHROUGH_ARGS_VALUE"
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --gpus "$gpu_arg" \
  -p "${HOST_PORT}:8000" \
  --shm-size "$SHM_SIZE" \
  --ulimit memlock=-1 \
  --ulimit stack=67108864 \
  -v "${CACHE_DIR}:/opt/nim/.cache" \
  "${env_args[@]}" \
  "$IMAGE" >/dev/null

wait_for_ready

printf '\nUse this endpoint with NemoClaw/OpenShell:\n'
printf '  http://localhost:%s/v1\n' "$HOST_PORT"
printf '  model: %s\n' "$MODEL"
printf '\n'

if [ "$TAIL_LOG" -eq 1 ]; then
  printf 'Tailing logs. Press Ctrl-C to stop tailing; the NIM container keeps running.\n'
  docker logs -f "$CONTAINER_NAME"
fi
