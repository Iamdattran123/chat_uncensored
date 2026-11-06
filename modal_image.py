import os
import io
import time
import base64
import torch
import modal
from pydantic import BaseModel
from typing import Optional

# Modal App dành riêng cho Sinh Ảnh Uncensored Tối Ưu
app = modal.App("private-image-studio")

# Volume lưu trữ weights model - Tải 1 lần trên Hugging Face, các lần sau khởi động tức thì
weights_volume = modal.Volume.from_name("image-weights-cache", create_if_missing=True)

# Image môi trường PyTorch + Diffusers tối tân nhất
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.4.0",
        "diffusers>=0.30.0",
        "transformers>=4.44.0",
        "accelerate>=0.34.0",
        "safetensors>=0.4.4",
        "sentencepiece",
        "protobuf",
        "fastapi[standard]>=0.115.0",
        "pillow>=10.4.0",
        "invisible-watermark>=0.2.0"
    )
)

class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = "ugly, deformed, disfigured, poor details, bad anatomy, bad fingers, blurry, watermark, signature, low quality"
    width: Optional[int] = 1024
    height: Optional[int] = 1024
    num_inference_steps: Optional[int] = 25
    guidance_scale: Optional[float] = 6.5
    seed: Optional[int] = -1
    model_id: Optional[str] = "SG161222/RealVisXL_V5.0"

@app.cls(
    image=image,
    gpu="L4",  # GPU Nvidia L4 24GB VRAM: Siêu tối ưu chi phí (~$0.80/h), render SDXL ~3s, Flux Schnell ~4s
    volumes={"/root/.cache/huggingface": weights_volume},
    secrets=[modal.Secret.from_name("model-auth")],
    timeout=600,
    min_containers=0,
    max_containers=1,
    scaledown_window=120,  # 2 phút không có request tự động tắt GPU về 0 để tiết kiệm tối đa chi phí
)
class ImageStudio:
    @modal.enter()
    def setup(self):
        from diffusers import AutopipelineForText2Image, DPMSolverMultistepScheduler
        
        default_model = os.environ.get("IMAGE_MODEL_ID", "SG161222/RealVisXL_V5.0")
        self.current_model_id = default_model
        print(f"[ImageStudio] Đang nạp model mặc định: {default_model}...")

        # Nạp pipeline tự động cho SDXL hoặc Flux với torch.float16 tối ưu bộ nhớ
        self.pipe = AutopipelineForText2Image.from_pretrained(
            default_model,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        
        # TẮT HOÀN TOÀN TẤT CẢ BỘ LỌC ĐẠO ĐỨC & SAFETY CHECKER (100% Uncensored)
        if hasattr(self.pipe, "safety_checker"):
            self.pipe.safety_checker = None
        if hasattr(self.pipe, "requires_safety_checker"):
            self.pipe.requires_safety_checker = False

        # Tối ưu hóa bộ nhớ và tốc độ
        self.pipe.to("cuda")
        if hasattr(self.pipe, "enable_vae_tiling"):
            self.pipe.enable_vae_tiling()
            
        print("[ImageStudio] Pipeline khởi tạo thành công! Sẵn sàng tạo ảnh.")

    def load_model_if_needed(self, target_model: str):
        if self.current_model_id == target_model:
            return
        from diffusers import AutopipelineForText2Image
        print(f"[ImageStudio] Chuyển đổi model sang: {target_model}...")
        self.pipe = AutopipelineForText2Image.from_pretrained(
            target_model,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        if hasattr(self.pipe, "safety_checker"):
            self.pipe.safety_checker = None
        if hasattr(self.pipe, "requires_safety_checker"):
            self.pipe.requires_safety_checker = False
        self.pipe.to("cuda")
        if hasattr(self.pipe, "enable_vae_tiling"):
            self.pipe.enable_vae_tiling()
        self.current_model_id = target_model

    @modal.fastapi_endpoint(method="POST")
    def generate(self, req: GenerateRequest):
        start_time = time.time()
        
        # Kiểm tra và nạp đúng model người dùng chọn
        model_id = req.model_id or "SG161222/RealVisXL_V5.0"
        self.load_model_if_needed(model_id)

        # Xử lý Seed
        if req.seed is None or req.seed < 0:
            seed = torch.randint(0, 2**32 - 1, (1,)).item()
        else:
            seed = int(req.seed)
        generator = torch.Generator(device="cuda").manual_seed(seed)

        # Chuẩn hóa kích thước chia hết cho 8
        width = (req.width // 8) * 8
        height = (req.height // 8) * 8
        steps = max(4, min(req.num_inference_steps, 50))
        guidance = max(1.0, min(req.guidance_scale, 20.0))

        # Nếu model là Flux Schnell: chỉ cần 4 steps và guidance 0.0 - 1.0
        if "schnell" in model_id.lower():
            steps = min(steps, 6)
            guidance = 0.0

        gen_kwargs = {
            "prompt": req.prompt,
            "width": width,
            "height": height,
            "num_inference_steps": steps,
            "guidance_scale": guidance,
            "generator": generator,
        }
        
        # Chỉ truyền negative_prompt nếu pipeline hỗ trợ
        if "flux" not in model_id.lower() and req.negative_prompt:
            gen_kwargs["negative_prompt"] = req.negative_prompt

        # Thực thi sinh ảnh
        output = self.pipe(**gen_kwargs)
        image = output.images[0]

        # Chuyển đổi ảnh sang Base64 PNG
        buffered = io.BytesIO()
        image.save(buffered, format="PNG", optimize=True)
        img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
        data_url = f"data:image/png;base64,{img_str}"

        elapsed = round(time.time() - start_time, 2)
        print(f"[ImageStudio] Đã tạo ảnh thành công ({width}x{height}, {steps} steps) trong {elapsed}s.")

        return {
            "image": data_url,
            "seed": seed,
            "elapsed_seconds": elapsed,
            "model": model_id,
            "width": width,
            "height": height,
            "steps": steps,
            "guidance_scale": guidance,
        }

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {"status": "ok", "current_model": self.current_model_id}
