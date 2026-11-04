import os
import subprocess
import tempfile
import shutil
import modal
from typing import Optional, Dict, Any

# Modal App dành riêng cho Agent AI (Coder 32B + Cloud Sandbox Cô Lập)
app = modal.App("private-agent-suite")

# 1. Model Coder 32B AWQ - Vua coding, dịch ngược & phân tích
MODEL_ID = os.environ.get(
    "AGENT_MODEL_ID", "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ"
)

# Volume lưu trữ cache weights của HuggingFace - Tải 1 lần, khởi động tức thì
model_volume = modal.Volume.from_name("coder-32b-weights-cache", create_if_missing=True)

# Image cho vLLM chạy GPU A10G (vLLM v0.9.2 đã có sẵn CUDA/AWQ kernel tối ưu, không cần autoawq)
vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.11")
    .pip_install("vllm==0.9.2", "transformers==4.53.3")
)

# Image cho Cloud Sandbox (CPU, cô lập 100%, cài sẵn bộ đồ nghề dịch ngược & điều tra nhẹ nhàng, build siêu nhanh)
sandbox_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git", "curl", "wget", "p7zip-full", "unzip",
        "file", "binutils"
    )
    .pip_install(
        "pefile", "capstone", "pyelftools", "requests", "fastapi"
    )
)

# =========================================================================
# DỊCH VỤ 1: GPU Inference Server (vLLM OpenAI Compatible API)
# =========================================================================
@app.function(
    image=vllm_image,
    gpu="A10G",  # 24GB VRAM (Hoặc đổi thành "L40S" nếu muốn bung 16K context)
    volumes={"/root/.cache/huggingface": model_volume},
    secrets=[modal.Secret.from_name("model-auth")],
    timeout=3600,
    min_containers=0,
    max_containers=1,
    scaledown_window=90,
)
@modal.web_server(8000, startup_timeout=900)
def serve():
    server_env = os.environ.copy()
    server_env["VLLM_API_KEY"] = server_env.pop("MODEL_API_KEY")
    subprocess.Popen([
        "python", "-m", "vllm.entrypoints.openai.api_server",
        "--model", MODEL_ID,
        "--host", "0.0.0.0",
        "--port", "8000",
        "--max-model-len", "4096",
        "--gpu-memory-utilization", "0.95",
        "--kv-cache-dtype", "fp8",
        "--quantization", "awq_marlin",
        "--enforce-eager",
        "--trust-remote-code",
    ], env=server_env)

# =========================================================================
# DỊCH VỤ 2: Cloud Sandbox Cô Lập (Chạy an toàn không ảnh hưởng máy local)
# =========================================================================
@app.function(
    image=sandbox_image,
    secrets=[modal.Secret.from_name("model-auth")],
    timeout=300,
    min_containers=0,
    max_containers=3,
    scaledown_window=30,
)
@modal.fastapi_endpoint(method="POST")
def sandbox(payload: Dict[str, Any]):
    """
    Endpoint Sandbox trên Cloud:
    - action = "inspect": Tải link/file/game về RAM cloud, trích xuất metadata, file type, strings, tree.
    - action = "execute": Chạy script Python/Bash trong container cô lập, trả về stdout/stderr.
    """
    auth_header = os.environ.get("MODEL_API_KEY", "")
    action = payload.get("action", "inspect")

    # Tạo thư mục tạm cô lập trong RAM cloud
    workdir = tempfile.mkdtemp(prefix="agent_sandbox_")
    try:
        if action == "inspect":
            target_url = payload.get("url", "").strip()
            if not target_url:
                return {"error": "Thiếu tham số url"}

            target_file = os.path.join(workdir, "target.bin")
            # Tải file về sandbox (giới hạn tối đa 150MB để tránh tràn bộ nhớ)
            dl_cmd = f"curl -sL --max-filesize 157286400 '{target_url}' -o '{target_file}'"
            dl_res = subprocess.run(dl_cmd, shell=True, timeout=60, capture_output=True)
            if dl_res.returncode != 0 or not os.path.exists(target_file):
                return {"error": f"Không thể tải target từ URL: {dl_res.stderr.decode()}"}

            # 1. Phân loại định dạng file
            file_type = subprocess.getoutput(f"file -b '{target_file}'")

            # 2. Quét chuỗi văn bản (Strings: tìm link ngầm, API key, endpoint, thư viện import)
            raw_strings = subprocess.getoutput(f"strings -n 8 '{target_file}'").splitlines()
            interesting_strings = [
                s for s in raw_strings 
                if any(k in s.lower() for k in ["http://", "https://", "api", "token", "key", "secret", "password", "cmd", "exec", "eval", ".dll", ".so", ".py", ".lua", ".wasm"])
            ][:40]

            # 3. Nếu là file nén (Zip / Game Package / Archive / APK), duyệt cấu trúc tệp
            archive_tree = []
            if any(ext in file_type.lower() for ext in ["zip", "archive", "package", "apk", "jar"]):
                archive_tree = subprocess.getoutput(f"7z l '{target_file}' | head -n 35").splitlines()

            # 4. Phân tích PE Header (nếu là file EXE / DLL Windows)
            pe_info = {}
            if "pe32" in file_type.lower() or "executable" in file_type.lower():
                try:
                    import pefile
                    pe = pefile.PE(target_file, fast_load=True)
                    pe_info["machine"] = hex(pe.FILE_HEADER.Machine)
                    pe_info["num_sections"] = pe.FILE_HEADER.NumberOfSections
                    pe.parse_data_directories()
                    imports = []
                    if hasattr(pe, "DIRECTORY_ENTRY_IMPORT"):
                        for entry in pe.DIRECTORY_ENTRY_IMPORT[:10]:
                            imports.append(entry.dll.decode(errors="ignore"))
                    pe_info["imported_dlls"] = imports
                except Exception as e:
                    pe_info["parse_error"] = str(e)

            return {
                "file_type": file_type,
                "file_size_bytes": os.path.getsize(target_file),
                "suspicious_strings": interesting_strings,
                "archive_structure": archive_tree if archive_tree else None,
                "pe_analysis": pe_info if pe_info else None,
            }

        elif action == "execute":
            # Thực thi script Python an toàn trong Sandbox
            code = payload.get("code", "")
            lang = payload.get("language", "python").lower()

            if lang == "python":
                script_path = os.path.join(workdir, "script.py")
                with open(script_path, "w", encoding="utf-8") as f:
                    f.write(code)
                res = subprocess.run(
                    ["python3", script_path],
                    timeout=45,
                    capture_output=True,
                    text=True
                )
                return {
                    "stdout": res.stdout[:5000],
                    "stderr": res.stderr[:5000],
                    "exit_code": res.returncode
                }
            elif lang == "bash":
                res = subprocess.run(
                    code,
                    shell=True,
                    timeout=45,
                    capture_output=True,
                    text=True,
                    cwd=workdir
                )
                return {
                    "stdout": res.stdout[:5000],
                    "stderr": res.stderr[:5000],
                    "exit_code": res.returncode
                }
            else:
                return {"error": f"Ngôn ngữ không hỗ trợ: {lang}"}

        return {"error": f"Action không hợp lệ: {action}"}

    except subprocess.TimeoutExpired:
        return {"error": "Lệnh thực thi vượt quá thời gian cho phép (Timeout 45s)"}
    except Exception as err:
        return {"error": f"Lỗi trong Sandbox: {str(err)}"}
    finally:
        # Tự động hủy sạch mọi tệp trong RAM cloud sau khi hoàn tất
        shutil.rmtree(workdir, ignore_errors=True)
