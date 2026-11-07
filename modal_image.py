import os
import io
import time
import base64
import torch
import modal
from PIL import Image
from pydantic import BaseModel
from typing import Optional, List

# Modal App dành riêng cho Sinh Ảnh Uncensored Tối Ưu (Hỗ trợ Batch nhiều ảnh)
app = modal.App("private-image-studio")

# Volume lưu trữ weights model vĩnh viễn - Mount vào thư mục riêng /weights
weights_volume = modal.Volume.from_name("image-weights-cache", create_if_missing=True)

MODEL_NAME = "SG161222/RealVisXL_V5.0"

# Image môi trường PyTorch + Diffusers tối tân nhất (đã có libgl1 & libglib)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
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
        "invisible-watermark>=0.2.0",
        "huggingface_hub>=0.24.0"
    )
    .env({"HF_HOME": "/weights"})
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
    init_image: Optional[str] = None
    strength: Optional[float] = 0.70
    num_images: Optional[int] = 1  # Tùy chọn tạo 1, 2, 3 hoặc 4 ảnh cùng lúc

@app.cls(
    image=image,
    gpu="A10G",
    volumes={"/weights": weights_volume},
    secrets=[modal.Secret.from_name("model-auth")],
    timeout=600,
    min_containers=0,
    max_containers=1,
    scaledown_window=240,
)
class ImageStudio:
    @modal.enter()
    def setup(self):
        from diffusers import AutoPipelineForText2Image
        
        default_model = os.environ.get("IMAGE_MODEL_ID", MODEL_NAME)
        self.current_model_id = default_model
        print(f"[ImageStudio] Đang nạp pipeline model {default_model} từ /weights...")

        self.pipe = AutoPipelineForText2Image.from_pretrained(
            default_model,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        
        # TẮT HOÀN TOÀN BỘ LỌC ĐẠO ĐỨC (100% Uncensored)
        if hasattr(self.pipe, "safety_checker"):
            self.pipe.safety_checker = None
        if hasattr(self.pipe, "requires_safety_checker"):
            self.pipe.requires_safety_checker = False

        self.pipe.to("cuda")
        if hasattr(self.pipe, "enable_vae_tiling"):
            self.pipe.enable_vae_tiling()
            
        print("[ImageStudio] Pipeline khởi tạo thành công! Sẵn sàng tạo ảnh.")

    def load_model_if_needed(self, target_model: str):
        if self.current_model_id == target_model and self.pipe is not None:
            return
        from diffusers import AutoPipelineForText2Image
        from fastapi import HTTPException

        print(f"[ImageStudio] Đang chuyển đổi model sang: {target_model}...")
        hf_token = os.environ.get("HF_TOKEN") or None
        
        load_kwargs = {
            "torch_dtype": torch.float16,
            "variant": "fp16",
            "use_safetensors": True,
        }
        if hf_token:
            load_kwargs["token"] = hf_token

        try:
            new_pipe = AutoPipelineForText2Image.from_pretrained(target_model, **load_kwargs)
            if hasattr(new_pipe, "safety_checker"):
                new_pipe.safety_checker = None
            if hasattr(new_pipe, "requires_safety_checker"):
                new_pipe.requires_safety_checker = False
            new_pipe.to("cuda")
            if hasattr(new_pipe, "enable_vae_tiling"):
                new_pipe.enable_vae_tiling()

            self.pipe = new_pipe
            self.current_model_id = target_model
            print(f"[ImageStudio] Nạp thành công model: {target_model}")
        except Exception as e:
            err_str = str(e)
            print(f"[ImageStudio] Lỗi khi nạp model '{target_model}': {err_str}")
            if "GatedRepoError" in err_str or "401" in err_str:
                raise HTTPException(
                    status_code=400,
                    detail=f"Model '{target_model}' bị khóa bản quyền (Gated Repo 401 trên HuggingFace). Hãy chọn RealVisXL V5.0 hoặc Juggernaut XL V9 để tạo ảnh không giới hạn!"
                )
            if self.pipe is not None:
                print(f"[ImageStudio] Vẫn giữ nguyên model đang chạy: {self.current_model_id}")
                raise HTTPException(
                    status_code=400,
                    detail=f"Không thể tải model '{target_model}': {err_str[:120]}. Vui lòng thử lại với RealVisXL V5.0."
                )
            raise HTTPException(status_code=500, detail=f"Lỗi khởi tạo model: {err_str[:150]}")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, req: GenerateRequest):
        start_time = time.time()
        
        model_id = req.model_id or MODEL_NAME
        self.load_model_if_needed(model_id)

        # Xử lý số lượng ảnh cần tạo (1 đến 4 ảnh)
        num_images = max(1, min(req.num_images or 1, 4))

        if req.seed is None or req.seed < 0:
            base_seed = torch.randint(0, 2**32 - 10, (1,)).item()
        else:
            base_seed = int(req.seed)

        width = (req.width // 8) * 8
        height = (req.height // 8) * 8
        steps = max(4, min(req.num_inference_steps, 50))
        guidance = max(1.0, min(req.guidance_scale, 20.0))

        if "schnell" in model_id.lower():
            steps = min(steps, 6)
            guidance = 0.0

        # Chuẩn bị pipeline Img2Img nếu có ảnh mẫu
        img2img_pipe = None
        ref_image = None
        strength = 0.70

        if req.init_image:
            print("[ImageStudio] Kích hoạt chế độ Image-to-Image theo ảnh mẫu...")
            from diffusers import AutoPipelineForImage2Image

            img2img_pipe = AutoPipelineForImage2Image.from_pipe(self.pipe)
            if hasattr(img2img_pipe, "safety_checker"):
                img2img_pipe.safety_checker = None
            if hasattr(img2img_pipe, "requires_safety_checker"):
                img2img_pipe.requires_safety_checker = False

            raw_base64 = req.init_image
            if "," in raw_base64:
                raw_base64 = raw_base64.split(",", 1)[1]
            img_bytes = base64.b64decode(raw_base64)
            ref_image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            ref_image = ref_image.resize((width, height), Image.Resampling.LANCZOS)
            strength = max(0.15, min(req.strength if req.strength is not None else 0.70, 0.95))

        generated_images: List[str] = []
        seeds_used: List[int] = []

        # Sinh từng ảnh với Seed khác nhau để tạo đa dạng góc nhìn & tư thế
        for i in range(num_images):
            curr_seed = base_seed + i
            generator = torch.Generator(device="cuda").manual_seed(curr_seed)

            if req.init_image and img2img_pipe and ref_image:
                gen_kwargs = {
                    "prompt": req.prompt,
                    "image": ref_image,
                    "strength": strength,
                    "num_inference_steps": steps,
                    "guidance_scale": guidance,
                    "generator": generator,
                }
                if "flux" not in model_id.lower() and req.negative_prompt:
                    gen_kwargs["negative_prompt"] = req.negative_prompt
                output = img2img_pipe(**gen_kwargs)
            else:
                gen_kwargs = {
                    "prompt": req.prompt,
                    "width": width,
                    "height": height,
                    "num_inference_steps": steps,
                    "guidance_scale": guidance,
                    "generator": generator,
                }
                if "flux" not in model_id.lower() and req.negative_prompt:
                    gen_kwargs["negative_prompt"] = req.negative_prompt
                output = self.pipe(**gen_kwargs)

            img = output.images[0]
            buffered = io.BytesIO()
            img.save(buffered, format="PNG", optimize=True)
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            data_url = f"data:image/png;base64,{img_str}"

            generated_images.append(data_url)
            seeds_used.append(curr_seed)

        elapsed = round(time.time() - start_time, 2)
        print(f"[ImageStudio] Đã tạo thành công {num_images} ảnh ({width}x{height}, {steps} steps) trong {elapsed}s.")

        return {
            "image": generated_images[0],
            "images": generated_images,
            "seeds": seeds_used,
            "seed": base_seed,
            "num_images": num_images,
            "elapsed_seconds": elapsed,
            "model": model_id,
            "width": width,
            "height": height,
            "steps": steps,
            "guidance_scale": guidance,
            "has_reference": bool(req.init_image),
        }

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {"status": "ok", "current_model": self.current_model_id}

@app.function(
    image=image,
    volumes={"/weights": weights_volume},
    timeout=1200,
)
def warmup():
    from huggingface_hub import snapshot_download
    print(f"[Warmup] Đang tải sẵn model {MODEL_NAME} vào Volume /weights...")
    snapshot_download(
        repo_id=MODEL_NAME,
        allow_patterns=["*.safetensors", "*.json", "*.txt"],
        ignore_patterns=["*.bin", "*.onnx"]
    )
    weights_volume.commit()
    print("[Warmup] Hoàn tất 100%! Model đã nằm trong Volume, web khởi động sẽ tức thì.")
