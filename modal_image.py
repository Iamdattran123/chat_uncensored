import io
import os
import re
import json
import time
import base64
import urllib.parse
import urllib.request
import torch
import modal
from PIL import Image
from pydantic import BaseModel
from typing import Optional, List

# Modal App dành riêng cho Sinh Ảnh Uncensored Tối Ưu (Hỗ trợ IP-Adapter Face, Dịch Việt-Anh Sát Nghĩa & Batch 1-4 ảnh)
app = modal.App("private-image-studio")

# Volume lưu trữ weights model vĩnh viễn - Mount vào thư mục riêng /weights
weights_volume = modal.Volume.from_name("image-weights-cache", create_if_missing=True)

MODEL_NAME = "SG161222/RealVisXL_V5.0"
IP_ADAPTER_REPO = "h94/IP-Adapter"
IP_ADAPTER_WEIGHT = "ip-adapter-plus-face_sdxl_vit-h.safetensors"

# Image môi trường PyTorch + Diffusers tối tân nhất
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
    raw_prompt: Optional[str] = None
    negative_prompt: Optional[str] = "ugly, deformed, disfigured, poor details, bad anatomy, bad fingers, extra limbs, blurry, watermark, signature, low quality, censored, mosaic, bar censor"
    width: Optional[int] = 1024
    height: Optional[int] = 1024
    num_inference_steps: Optional[int] = 25
    guidance_scale: Optional[float] = 6.5
    seed: Optional[int] = -1
    model_id: Optional[str] = "SG161222/RealVisXL_V5.0"
    init_image: Optional[str] = None
    strength: Optional[float] = 0.65
    ref_mode: Optional[str] = "face"  # "face" (Giữ mặt + Tự tạo dáng mới qua IP-Adapter) | "pose" (Img2Img bám bố cục)
    num_images: Optional[int] = 1

class TranslateRequest(BaseModel):
    prompt: str
    model_id: Optional[str] = "SG161222/RealVisXL_V5.0"


def translate_vi_to_en_neural(text: str) -> str:
    """Dịch câu tiếng Việt bất kỳ sang tiếng Anh bằng Google Neural Translate API (Không kiểm duyệt từ nhạy cảm)."""
    if not text.strip():
        return ""
    try:
        q = urllib.parse.quote(text.strip())
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=vi&tl=en&dt=t&q={q}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            translated = "".join([part[0] for part in data[0] if part[0]])
            return translated.strip()
    except Exception as e:
        print(f"[Translator] Fallback local dict do lỗi mạng: {e}")
        return text.strip()


def compile_smart_prompt(user_text: str, model_id: str = "") -> dict:
    """
    Bộ biên dịch ngôn ngữ Tiếng Việt thông minh sang chuẩn Prompt AI Studio (SDXL):
    1. Tách bỏ các mệnh lệnh điều khiển (vd: 'giữ khuôn mặt còn dáng người tự sáng tạo', 'hãy vẽ cho tôi...')
    2. Phát hiện ý định đổi dáng (force_face_mode) để tự động chuyển sang IP-Adapter Face.
    3. Dịch Neural toàn bộ câu mô tả sang tiếng Anh chuẩn xác.
    4. Bổ sung trọng số giải phẫu học (Nude, Tư thế quỳ/đứng/ngồi, Góc máy toàn thân).
    """
    raw = (user_text or "").strip()
    if not raw:
        return {"compiled_prompt": "", "detected_mode": "face", "notes": []}

    lower_raw = raw.lower()
    notes = []
    detected_mode = "face"

    # 1. Phát hiện mệnh lệnh giữ mặt nhưng tự sáng tạo dáng người
    if re.search(r"(giữ\s*(khuôn\s*)?mặt|lấy\s*mặt|theo\s*mặt|dáng\s*(người)?\s*(thì\s*)?tự\s*(do\s*)?sáng\s*tạo|đổi\s*dáng|đổi\s*tư\s*thế)", lower_raw):
        detected_mode = "face"
        notes.append("Đã nhận diện yêu cầu: Giữ đường nét khuôn mặt & Tự do sáng tạo dáng người mới (IP-Adapter Face)")

    # 2. Loại bỏ các cụm từ mệnh lệnh thừa ở đầu và cuối câu để tránh làm nhiễu CLIP
    cleaned = raw
    meta_patterns = [
        r"^(hãy\s*)?(tạo|vẽ|làm|sinh|thiết kế)\s*(cho\s*(tôi|tao|mình|anh|em)\s*)?(một\s*|1\s*)?(bức\s*|tấm\s*)?(hình\s*ảnh|ảnh|hình)\s*(về\s*|của\s*)?",
        r"(,|\.|;|\s)*(nhưng\s*|mà\s*)?(vẫn\s*)?(giữ\s*(nguyên\s*)?(nét\s*|khuôn\s*)?mặt(\s*ảnh\s*mẫu)?)\s*(còn\s*|và\s*)?(dáng\s*(người|đứng|ngồi)?|tư\s*thế|body|cơ\s*thể)?\s*(thì\s*)?(tự\s*(do\s*)?sáng\s*tạo|tự\s*vẽ|tùy\s*ý|khác đi|mới hoàn toàn)[^,.]*",
        r"(,|\.|;|\s)*(dáng\s*(người)?|tư\s*thế)\s*(thì\s*)?(tự\s*(do\s*)?sáng\s*tạo|tùy\s*ý)[^,.]*",
        r"(,|\.|;|\s)*(giữ\s*(nguyên\s*)?(nét\s*|khuôn\s*)?mặt(\s*của\s*cô\s*gái|\s*ảnh\s*mẫu)?)[^,.]*",
    ]
    for pat in meta_patterns:
        cleaned = re.sub(pat, " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,.-;")
    if not cleaned:
        cleaned = raw

    # 3. Kiểm tra có phải tiếng Việt không và dịch Neural sang tiếng Anh
    has_vietnamese = bool(re.search(r"[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]", cleaned, re.IGNORECASE))
    if has_vietnamese:
        en_base = translate_vi_to_en_neural(cleaned)
    else:
        en_base = cleaned

    # 4. Phân tích ngữ nghĩa chuyên sâu để gắn thẻ trọng số (Weighted Tags) chuẩn SDXL
    boost_tags = []

    # Nhận diện giới tính / nhân vật
    if re.search(r"(phụ nữ|cô gái|cô em|gái xinh|em gái|thiếu nữ|woman|girl|female)", lower_raw):
        if "1girl" not in en_base.lower():
            boost_tags.append("1girl, gorgeous young woman")

    # Nhận diện Nude / Khỏa thân / 18+
    if re.search(r"(không mặc gì|khỏa thân|nude|cởi hết|trần truồng|trần như nhộng|không quần áo|lộ ngực|lộ vú|lộ hàng|cởi truồng|naked|wearing nothing|topless)", lower_raw):
        boost_tags.append("(completely naked, full body nude:1.35), (uncensored, explicit anatomy, bare breasts, exposed nipples, bare skin:1.25)")
        notes.append("Kích hoạt thẻ Uncensored 18+ (Full Nude / Explicit Anatomy)")
    elif re.search(r"(bikini|đồ bơi|áo tắm)", lower_raw):
        boost_tags.append("(sexy micro bikini, wet skin:1.2)")
    elif re.search(r"(nội y|đồ lót|lingerie)", lower_raw):
        boost_tags.append("(erotic lace lingerie:1.2)")

    # Nhận diện Tư thế (Pose) & Góc máy Toàn thân (Full Body Framing)
    if re.search(r"(quỳ gối|đang quỳ|quỳ trên sàn|quỳ xuống|kneel)", lower_raw):
        boost_tags.append("(kneeling on both knees on the floor, full body kneeling pose, wide angle shot from head to knees:1.35)")
        notes.append("Khóa góc máy rộng: Tư thế quỳ gối toàn thân")
    elif re.search(r"(đang đứng|đứng thẳng|đứng tạo dáng|standing)", lower_raw):
        boost_tags.append("(standing pose, full body shot from head to toe, wide angle view, showing legs and body:1.3)")
        notes.append("Khóa góc máy rộng: Tư thế đứng toàn thân")
    elif re.search(r"(ngồi xổm|squat)", lower_raw):
        boost_tags.append("(squatting pose, full body shot, wide angle:1.3)")
    elif re.search(r"(đang ngồi|ngồi trên|ngồi bệt|sitting|seated)", lower_raw):
        boost_tags.append("(sitting pose, full body shot, wide angle view showing whole body:1.3)")
        notes.append("Khóa góc máy rộng: Tư thế ngồi toàn thân")
    elif re.search(r"(đang nằm|nằm ngửa|nằm sấp|nằm trên|lying|reclining)", lower_raw):
        boost_tags.append("(lying down pose, full body view on bed/floor, wide angle:1.25)")
    elif re.search(r"(chổng mông|nhìn từ phía sau|quay lưng|doggy|from behind|back view)", lower_raw):
        boost_tags.append("(from behind, back view, arched back, looking back over shoulder, full body:1.3)")

    if re.search(r"(dang chân|mở rộng chân|banh chân|spread legs)", lower_raw):
        boost_tags.append("(spread legs, explicit pose:1.3)")

    # Nhận diện Bối cảnh (Environment)
    if re.search(r"(nhà vệ sinh|toilet|phòng vệ sinh|wc|restroom)", lower_raw):
        boost_tags.append("inside a public restroom stall, ceramic tile walls, toilet background, realistic indoor bathroom lighting")
    elif re.search(r"(bãi biển|bờ biển|ở biển|ngoài biển|beach)", lower_raw):
        boost_tags.append("on a sunny tropical beach, ocean waves in background, wet sand, bright natural sunlight")
    elif re.search(r"(phòng tắm|nhà tắm|bồn tắm|bathroom|shower)", lower_raw):
        boost_tags.append("inside a luxury modern bathroom, wet glass, warm steam lighting")
    elif re.search(r"(phòng ngủ|trên giường|khách sạn|bedroom|hotel)", lower_raw):
        boost_tags.append("inside a cozy luxury hotel bedroom, messy bedsheets, cinematic warm lamp lighting")

    # Tiền tố đặc biệt cho dòng Pony / CyberRealistic Pony
    prefix = ""
    if "pony" in (model_id or "").lower():
        prefix = "score_9, score_8_up, score_7_up, realistic, photorealistic, "

    # Hậu tố chất lượng cao
    quality_suffix = "masterpiece, raw photo, photorealistic, 8k uhd, dslr, ultra detailed skin texture, realistic pores, natural lighting"

    parts = [p for p in [en_base] + boost_tags + [quality_suffix] if p]
    final_prompt = prefix + ", ".join(parts)

    return {
        "compiled_prompt": final_prompt,
        "english_translation": en_base,
        "detected_mode": detected_mode,
        "notes": notes,
    }


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
        self.ip_adapter_loaded = False
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

        # Nạp sẵn IP-Adapter Face nếu đã có trong Volume
        self._ensure_ip_adapter()
        print("[ImageStudio] Pipeline khởi tạo thành công! Sẵn sàng tạo ảnh.")

    def _ensure_ip_adapter(self):
        if self.ip_adapter_loaded:
            return True
        try:
            print("[ImageStudio] Đang nạp IP-Adapter Plus Face SDXL (Giữ khuôn mặt & Đổi dáng tự do)...")
            self.pipe.load_ip_adapter(
                IP_ADAPTER_REPO,
                subfolder="sdxl_models",
                weight_name=IP_ADAPTER_WEIGHT,
                image_encoder_folder="models/image_encoder",
            )
            self.pipe.set_ip_adapter_scale(0.0)
            self.ip_adapter_loaded = True
            print("[ImageStudio] Đã kích hoạt thành công IP-Adapter Plus Face SDXL!")
            return True
        except Exception as e:
            print(f"[ImageStudio] Không thể nạp IP-Adapter Face (sẽ dùng Img2Img dự phòng): {e}")
            self.ip_adapter_loaded = False
            return False

    def load_model_if_needed(self, target_model: str):
        if self.current_model_id == target_model and self.pipe is not None:
            return
        from diffusers import AutoPipelineForText2Image
        from fastapi import HTTPException

        print(f"[ImageStudio] Đang chuyển đổi model sang: {target_model}...")
        hf_token = os.environ.get("HF_TOKEN") or None
        
        base_kwargs = {
            "torch_dtype": torch.float16,
            "use_safetensors": True,
        }
        if hf_token:
            base_kwargs["token"] = hf_token

        try:
            try:
                new_pipe = AutoPipelineForText2Image.from_pretrained(
                    target_model,
                    variant="fp16",
                    **base_kwargs
                )
            except Exception as first_err:
                if "GatedRepoError" in str(first_err) or "401" in str(first_err):
                    raise first_err
                print(f"[ImageStudio] Model '{target_model}' dùng safetensors chuẩn (không có hậu tố .fp16), đang nạp...")
                new_pipe = AutoPipelineForText2Image.from_pretrained(
                    target_model,
                    **base_kwargs
                )

            if hasattr(new_pipe, "safety_checker"):
                new_pipe.safety_checker = None
            if hasattr(new_pipe, "requires_safety_checker"):
                new_pipe.requires_safety_checker = False
            new_pipe.to("cuda")
            if hasattr(new_pipe, "enable_vae_tiling"):
                new_pipe.enable_vae_tiling()

            self.pipe = new_pipe
            self.current_model_id = target_model
            self.ip_adapter_loaded = False
            self._ensure_ip_adapter()
            weights_volume.commit()
            print(f"[ImageStudio] Nạp thành công model: {target_model}")
        except Exception as e:
            err_str = str(e)
            print(f"[ImageStudio] Lỗi khi nạp model '{target_model}': {err_str}")
            if "GatedRepoError" in err_str or "401" in err_str:
                raise HTTPException(
                    status_code=400,
                    detail=f"Model '{target_model}' bị khóa bản quyền (Gated Repo 401). Hãy chọn RealVisXL V5.0, CyberRealistic Pony V6.5 hoặc Juggernaut XL V9!"
                )
            if self.pipe is not None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Không thể tải model '{target_model}': {err_str[:120]}. Đang giữ nguyên model {self.current_model_id}."
                )
            raise HTTPException(status_code=500, detail=f"Lỗi khởi tạo model: {err_str[:150]}")

    @modal.fastapi_endpoint(method="POST")
    def translate(self, req: TranslateRequest):
        """Endpoint chuyên dụng để dịch & tối ưu hóa câu tiếng Việt sang Prompt chuẩn AI."""
        res = compile_smart_prompt(req.prompt, req.model_id or MODEL_NAME)
        return res

    @modal.fastapi_endpoint(method="POST")
    def generate(self, req: GenerateRequest):
        start_time = time.time()
        
        model_id = req.model_id or MODEL_NAME
        self.load_model_if_needed(model_id)

        # Biên dịch & tối ưu hóa Prompt tiếng Việt sát nghĩa nhất
        source_text = req.raw_prompt if req.raw_prompt else req.prompt
        prompt_info = compile_smart_prompt(source_text, model_id)
        final_prompt = prompt_info["compiled_prompt"] or req.prompt
        print(f"[ImageStudio] Prompt gốc: {source_text}")
        print(f"[ImageStudio] Prompt AI đã biên dịch: {final_prompt}")

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

        ref_image = None
        use_face_adapter = False
        img2img_pipe = None
        strength = max(0.20, min(req.strength if req.strength is not None else 0.65, 0.95))

        if req.init_image:
            raw_base64 = req.init_image
            if "," in raw_base64:
                raw_base64 = raw_base64.split(",", 1)[1]
            img_bytes = base64.b64decode(raw_base64)
            ref_image = Image.open(io.BytesIO(img_bytes)).convert("RGB")

            # Quyết định chế độ: "face" (IP-Adapter giữ mặt + tự sáng tạo dáng toàn thân) hay "pose" (Img2Img)
            desired_mode = req.ref_mode or prompt_info.get("detected_mode", "face")
            if desired_mode == "face" and self._ensure_ip_adapter():
                use_face_adapter = True
                # Scale cho IP-Adapter Face: 0.60 - 0.75 là điểm ngọt giữ giống mặt 90% mà vẫn đổi mọi tư thế quỳ/đứng/ngồi
                ip_scale = max(0.30, min(strength, 0.85))
                self.pipe.set_ip_adapter_scale(ip_scale)
                print(f"[ImageStudio] Chế độ IP-Adapter Face (scale={ip_scale}): Giữ khuôn mặt & Tự tạo dáng người theo Prompt!")
            else:
                print(f"[ImageStudio] Chế độ Img2Img (strength={strength})...")
                if self.ip_adapter_loaded:
                    self.pipe.set_ip_adapter_scale(0.0)
                from diffusers import AutoPipelineForImage2Image
                img2img_pipe = AutoPipelineForImage2Image.from_pipe(self.pipe)
                if hasattr(img2img_pipe, "safety_checker"):
                    img2img_pipe.safety_checker = None
                if hasattr(img2img_pipe, "requires_safety_checker"):
                    img2img_pipe.requires_safety_checker = False
                ref_image = ref_image.resize((width, height), Image.Resampling.LANCZOS)
        else:
            if self.ip_adapter_loaded:
                self.pipe.set_ip_adapter_scale(0.0)

        dummy_ip_img = Image.new("RGB", (224, 224), (0, 0, 0))
        generated_images: List[str] = []
        seeds_used: List[int] = []

        # Sinh từng ảnh với Seed khác nhau để tạo đa dạng góc nhìn & tư thế
        for i in range(num_images):
            curr_seed = base_seed + i
            generator = torch.Generator(device="cuda").manual_seed(curr_seed)

            if req.init_image and use_face_adapter and ref_image:
                # Chạy Text-to-Image tự do toàn thân kèm khóa khuôn mặt IP-Adapter
                gen_kwargs = {
                    "prompt": final_prompt,
                    "negative_prompt": req.negative_prompt,
                    "width": width,
                    "height": height,
                    "ip_adapter_image": ref_image,
                    "num_inference_steps": steps,
                    "guidance_scale": guidance,
                    "generator": generator,
                }
                output = self.pipe(**gen_kwargs)
            elif req.init_image and img2img_pipe and ref_image:
                gen_kwargs = {
                    "prompt": final_prompt,
                    "negative_prompt": req.negative_prompt,
                    "image": ref_image,
                    "strength": strength,
                    "num_inference_steps": steps,
                    "guidance_scale": guidance,
                    "generator": generator,
                }
                if self.ip_adapter_loaded:
                    gen_kwargs["ip_adapter_image"] = dummy_ip_img
                output = img2img_pipe(**gen_kwargs)
            else:
                gen_kwargs = {
                    "prompt": final_prompt,
                    "negative_prompt": req.negative_prompt,
                    "width": width,
                    "height": height,
                    "num_inference_steps": steps,
                    "guidance_scale": guidance,
                    "generator": generator,
                }
                if self.ip_adapter_loaded:
                    gen_kwargs["ip_adapter_image"] = dummy_ip_img
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
            "compiled_prompt": final_prompt,
            "english_translation": prompt_info.get("english_translation", ""),
            "notes": prompt_info.get("notes", []),
        }

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {
            "status": "ok",
            "current_model": self.current_model_id,
            "ip_adapter_face": self.ip_adapter_loaded,
        }

@app.function(
    image=image,
    volumes={"/weights": weights_volume},
    timeout=1800,
)
def warmup():
    from huggingface_hub import snapshot_download
    print(f"[Warmup] 1/2: Đang kiểm tra & lưu cache model chính {MODEL_NAME}...")
    snapshot_download(
        repo_id=MODEL_NAME,
        allow_patterns=["*.safetensors", "*.json", "*.txt"],
        ignore_patterns=["*.bin", "*.onnx"]
    )
    print(f"[Warmup] 2/2: Đang tải IP-Adapter Plus Face SDXL ({IP_ADAPTER_REPO}) vào Volume /weights...")
    snapshot_download(
        repo_id=IP_ADAPTER_REPO,
        allow_patterns=[
            f"sdxl_models/{IP_ADAPTER_WEIGHT}",
            "models/image_encoder/*.safetensors",
            "models/image_encoder/*.json",
        ],
    )
    weights_volume.commit()
    print("[Warmup] Hoàn tất 100%! Cả RealVisXL V5.0 và IP-Adapter Face đã nằm sẵn trong Volume.")
