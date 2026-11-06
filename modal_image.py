import os
import io
import time
import base64
import torch
import modal
from PIL import Image
from pydantic import BaseModel
from typing import Optional

# Modal App dành riêng cho Sinh Ảnh Uncensored Tối Ưu
app = modal.App("private-image-studio")

# Volume lưu trữ weights model để nạp tức thì
weights_volume = modal.Volume.from_name("image-weights-cache", create_if_missing=True)

MODEL_NAME = "SG161222/RealVisXL_V5.0"

# Hàm tải trước model vào Image cache để KHÔNG BỊ COLD START TIMEOUT
def download_models():
    from huggingface_hub import snapshot_download
    print(f"[Build] Đang tải sẵn weights model {MODEL_NAME} vào cache...")
    snapshot_download(
        repo_id=MODEL_NAME,
        allow_patterns=["*.safetensors", "*.json", "*.txt"],
        ignore_patterns=["*.bin", "*.onnx"]
    )
    print("[Build] Tải hoàn tất! Image đã sẵn sàng.")

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
        "invisible-watermark>=0.2.0",
        "huggingface_hub>=0.24.0"
    )
    .run_function(download_models)
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
    strength: Optional[float] = 0.65

@app.cls(
    image=image,
    gpu="A10G",  # Dùng A10G (24GB VRAM): Nguồn cung cực lớn trên Modal, không bao giờ bị nghẽn capacity chờ L4
    volumes={"/root/.cache/huggingface": weights_volume},
    secrets=[modal.Secret.from_name("model-auth")],
    timeout=600,
    min_containers=0,
    max_containers=1,
    scaledown_window=180,  # 3 phút không dùng tự scale về 0 để tiết kiệm chi phí
)
class ImageStudio:
    @modal.enter()
    def setup(self):
        from diffusers import AutopipelineForText2Image
        
        default_model = os.environ.get("IMAGE_MODEL_ID", MODEL_NAME)
        self.current_model_id = default_model
        print(f"[ImageStudio] Đang nạp pipeline model: {default_model}...")

        self.pipe = AutopipelineForText2Image.from_pretrained(
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
        
        model_id = req.model_id or MODEL_NAME
        self.load_model_if_needed(model_id)

        if req.seed is None or req.seed < 0:
            seed = torch.randint(0, 2**32 - 1, (1,)).item()
        else:
            seed = int(req.seed)
        generator = torch.Generator(device="cuda").manual_seed(seed)

        width = (req.width // 8) * 8
        height = (req.height // 8) * 8
        steps = max(4, min(req.num_inference_steps, 50))
        guidance = max(1.0, min(req.guidance_scale, 20.0))

        if "schnell" in model_id.lower():
            steps = min(steps, 6)
            guidance = 0.0

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

            strength = max(0.15, min(req.strength if req.strength is not None else 0.65, 0.95))

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

        image = output.images[0]

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
            "has_reference": bool(req.init_image),
        }

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {"status": "ok", "current_model": self.current_model_id}
