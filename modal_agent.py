import os
import subprocess
import tempfile
import shutil
import modal
from typing import Optional, Dict, Any

# Modal App dành riêng cho Agent AI (Coder 32B + Cloud Sandbox Cô Lập)
app = modal.App("private-agent-suite")

# 1. Model 32B Abliterated AWQ - Uncensored 100%, không rào cản đạo đức, vua coding & dịch ngược
MODEL_ID = os.environ.get(
    "AGENT_MODEL_ID", "zae029/Qwen2.5-32B-Instruct-abliterated-AWQ"
)

# Volume lưu trữ cache weights của HuggingFace - Tải 1 lần, khởi động tức thì
model_volume = modal.Volume.from_name("coder-32b-weights-cache", create_if_missing=True)

# Image cho vLLM chạy GPU A10G (vLLM v0.9.2 đã có sẵn CUDA/AWQ kernel tối ưu, không cần autoawq)
vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.11")
    .pip_install("vllm==0.9.2", "transformers==4.53.3")
)

# Image cho Cloud Sandbox (Kho vũ khí đầy đủ từ MẮT tới TAY cho Agent: C/C++, Python, Reverse, Network, Web, Crypto)
sandbox_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        # Bộ công cụ Developer & Build ("Tay"):
        "build-essential", "clang", "make", "git", "curl", "wget", "jq",
        # Bộ nén / giải nén đa định dạng:
        "p7zip-full", "unzip", "zip", "tar", "xz-utils", "zstd", "bzip2",
        # Bộ phân tích Binary & Reverse Engineering ("Mắt"):
        "file", "binutils", "strace", "lsof", "procps", "default-jre-headless",
        # Bộ điều tra Network, DNS, SSL & Reconnaissance ("Tai mắt mạng"):
        "dnsutils", "whois", "net-tools", "iputils-ping", "nmap"
    )
    .pip_install(
        # Binary & Decompilation:
        "pefile", "capstone", "pyelftools",
        # Networking & Scrape:
        "requests", "httpx", "urllib3", "scapy", "beautifulsoup4", "lxml",
        # Cryptography, Math & Image:
        "cryptography", "sympy", "numpy", "pillow",
        # Server endpoint:
        "fastapi"
    )
)

# =========================================================================
# DỊCH VỤ 1: GPU Inference Server (vLLM OpenAI Compatible API)
# =========================================================================
@app.function(
    image=vllm_image,
    gpu="L40S",  # 48GB VRAM Ada Lovelace - Tốc độ gấp đôi A10G, context 16K siêu mượt
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
        "--max-model-len", "16384",
        "--gpu-memory-utilization", "0.95",
        "--kv-cache-dtype", "auto",
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

    # Nếu có session_id thì giữ workspace liên tục giữa các bước, nếu không thì dùng tempdir dùng 1 lần
    session_id = payload.get("session_id", "").strip()
    is_ephemeral = not bool(session_id)
    if is_ephemeral:
        workdir = tempfile.mkdtemp(prefix="agent_sandbox_")
    else:
        # Làm sạch session_id để an toàn đường dẫn
        safe_sess = "".join(c for c in session_id if c.isalnum() or c in "-_")[:40]
        workdir = os.path.join(tempfile.gettempdir(), f"agent_sess_{safe_sess}")
        os.makedirs(workdir, exist_ok=True)

    try:
        if action == "inspect":
            target_url = payload.get("url", "").strip()
            if not target_url:
                return {"error": "Thiếu tham số url"}

            # Nếu là link web (http/https), bóc tách thêm thông tin HTTP Header, SSL và Server
            web_intel = {}
            if target_url.startswith("http://") or target_url.startswith("https://"):
                try:
                    import requests
                    head_res = requests.head(target_url, timeout=8, allow_redirects=True, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
                    web_intel["http_status"] = head_res.status_code
                    web_intel["final_url"] = head_res.url
                    web_intel["server"] = head_res.headers.get("Server", "Unknown")
                    web_intel["security_headers"] = {
                        "content_security_policy": bool(head_res.headers.get("Content-Security-Policy")),
                        "strict_transport_security": bool(head_res.headers.get("Strict-Transport-Security")),
                        "x_frame_options": head_res.headers.get("X-Frame-Options", "MISSING"),
                        "x_content_type_options": head_res.headers.get("X-Content-Type-Options", "MISSING"),
                    }
                except Exception as web_e:
                    web_intel["recon_note"] = f"Không lấy được HEAD headers: {str(web_e)}"

            target_file = os.path.join(workdir, "target.bin")
            # Tải file về sandbox (giới hạn tối đa 150MB để tránh tràn bộ nhớ)
            dl_cmd = f"curl -sL --max-filesize 157286400 '{target_url}' -o '{target_file}'"
            dl_res = subprocess.run(dl_cmd, shell=True, timeout=35, capture_output=True)
            if dl_res.returncode != 0 or not os.path.exists(target_file):
                return {"error": f"Không thể tải target từ URL: {dl_res.stderr.decode()}", "web_intel": web_intel}

            # 1. Phân loại định dạng file
            file_type = subprocess.getoutput(f"file -b '{target_file}'")

            # 2. Quét chuỗi văn bản (Strings: tìm link ngầm, API key, endpoint, thư viện import)
            raw_strings = subprocess.getoutput(f"strings -n 8 '{target_file}'").splitlines()
            interesting_strings = [
                s.strip()[:120] for s in raw_strings 
                if any(k in s.lower() for k in ["http://", "https://", "api", "token", "key", "secret", "password", "cmd", "exec", "eval", ".dll", ".so", ".py", ".lua", ".wasm", "flag"])
            ][:20]

            # 3. Nếu là file nén (Zip / Game Package / Archive / APK / IPA / JAR), duyệt cấu trúc tệp
            archive_tree = []
            if any(ext in file_type.lower() for ext in ["zip", "archive", "package", "apk", "jar", "tar"]):
                archive_tree = [line[:100] for line in subprocess.getoutput(f"7z l '{target_file}' | head -n 25").splitlines()]

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

            # 5. Phân tích ELF Header (nếu là Linux Binary / Shared Object)
            elf_info = {}
            if "elf" in file_type.lower():
                try:
                    elf_info["header"] = subprocess.getoutput(f"readelf -h '{target_file}' | head -n 12")
                    elf_info["dynamic_libs"] = [line.strip() for line in subprocess.getoutput(f"readelf -d '{target_file}' | grep NEEDED").splitlines()[:8]]
                except Exception as e:
                    elf_info["parse_error"] = str(e)

            return {
                "file_type": file_type,
                "file_size_bytes": os.path.getsize(target_file),
                "web_intel": web_intel if web_intel else None,
                "suspicious_strings": interesting_strings,
                "archive_structure": archive_tree if archive_tree else None,
                "pe_analysis": pe_info if pe_info else None,
                "elf_analysis": elf_info if elf_info else None,
            }

        elif action == "network":
            # Điều tra hạ tầng mạng, DNS, WHOIS, SSL
            target = payload.get("target", "").strip()
            target_clean = target.replace("https://", "").replace("http://", "").split("/")[0].split(":")[0]
            if not target_clean:
                return {"error": "Thiếu target (domain hoặc ip)"}

            dns_a = subprocess.getoutput(f"dig +short A '{target_clean}'").splitlines()[:4]
            dns_ns = subprocess.getoutput(f"dig +short NS '{target_clean}'").splitlines()[:3]
            dns_mx = subprocess.getoutput(f"dig +short MX '{target_clean}'").splitlines()[:3]
            dns_txt = subprocess.getoutput(f"dig +short TXT '{target_clean}'").splitlines()[:3]
            
            # Quét nhanh cert SSL
            ssl_info = subprocess.getoutput(
                f"echo | openssl s_client -connect '{target_clean}:443' -servername '{target_clean}' 2>/dev/null | openssl x509 -noout -issuer -subject -dates 2>/dev/null"
            )

            return {
                "domain": target_clean,
                "dns": { "A": dns_a, "NS": dns_ns, "MX": dns_mx, "TXT": dns_txt },
                "ssl_certificate": ssl_info if ssl_info else "Không có hoặc không hỗ trợ port 443"
            }

        elif action == "execute":
            # Thực thi script Python / Bash an toàn trong Sandbox
            code = payload.get("code", "")
            lang = payload.get("language", "python").lower()

            if lang == "python":
                script_path = os.path.join(workdir, "script.py")
                with open(script_path, "w", encoding="utf-8") as f:
                    f.write(code)
                res = subprocess.run(
                    ["python3", script_path],
                    timeout=30,
                    capture_output=True,
                    text=True,
                    cwd=workdir
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
                    timeout=30,
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
        return {"error": "Lệnh thực thi vượt quá thời gian cho phép (Timeout 30s)"}
    except Exception as err:
        return {"error": f"Lỗi trong Sandbox: {str(err)}"}
    finally:
        if is_ephemeral:
            shutil.rmtree(workdir, ignore_errors=True)
