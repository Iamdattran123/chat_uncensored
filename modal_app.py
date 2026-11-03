import os
import subprocess
import modal

app = modal.App("private-chat-model")
MODEL_ID = os.environ.get(
    "MODEL_ID", "huihui-ai/Huihui-Qwen3-8B-abliterated-v2"
)

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.11")
    .pip_install("vllm==0.9.2")
)

@app.function(
    image=image,
    gpu="A10G",
    secrets=[modal.Secret.from_name("model-auth")],
    timeout=3600,
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
)
@modal.web_server(8000, startup_timeout=900)
def serve():
    subprocess.Popen([
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", MODEL_ID,
        "--host", "0.0.0.0",
        "--port", "8000",
        "--api-key", os.environ["MODEL_API_KEY"],
        "--max-model-len", "8192",
        "--gpu-memory-utilization", "0.88",
        "--trust-remote-code",
    ])
