# Khung Chat & Studio Tạo Hình Ảnh Không Kiểm Duyệt (Serverless Modal + Supabase)

Kiến trúc tối ưu không cần thuê VPS cố định: GitHub Pages host giao diện tĩnh; Supabase Auth/Postgres lưu tài khoản và lịch sử riêng tư; Supabase Edge Functions làm proxy bảo mật; Modal Serverless GPU chỉ khởi động khi có request và tự động tắt (scale to 0) khi nghỉ để tiết kiệm tối đa chi phí.

- **Chế độ Chat (Dành cho mọi tài khoản)**: Trò chuyện văn bản với LLM qua `supabase/functions/chat` và `modal_app.py`.
- **Chế độ Studio Tạo Ảnh (Độc quyền `datviphero@gmail.com`)**: Tạo hình ảnh không kiểm duyệt (Uncensored 100%, nude, anatomy chi tiết) qua `supabase/functions/image` và `modal_image.py`.

---

## 1) Tạo Supabase Project và Bảng Lịch Sử

1. Tạo project tại Supabase.
2. Mở **SQL Editor**, chạy toàn bộ file `supabase/schema.sql`.
3. Vào **Project Settings → API**; lấy Project URL và public anon key điền vào `config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_PUBLIC_ANON_KEY'
};
```

4. Trong **Authentication → Users**, tạo tài khoản quản trị viên `datviphero@gmail.com` và các tài khoản người dùng khác nếu cần.

---

## 2) Triển Khai Model Lên Modal Serverless GPU

Cần tài khoản Modal và CLI đã cấu hình:

```bash
python -m pip install modal
modal setup
export MODEL_API_KEY="YOUR_LONG_RANDOM_TOKEN"
modal secret create model-auth MODEL_API_KEY="$MODEL_API_KEY"
```

### A. Deploy Chat thường (`modal_app.py`):
```bash
modal deploy modal_app.py
```
Copy URL cấp cho endpoint `serve` để điền vào `MODAL_BASE_URL`.

### B. Deploy Studio Tạo Ảnh Không Kiểm Duyệt (`modal_image.py`):
```bash
modal deploy modal_image.py
```
Sau khi deploy `modal_image.py`, Modal sẽ cấp URL endpoint dạng:
`https://<your-username>--private-image-studio-imagestudio-generate.modal.run`

---

## 3) Deploy Supabase Edge Functions & Secrets

Cài Supabase CLI, đăng nhập và liên kết project:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Cấu hình Secrets trong Supabase:

```bash
# 1. Cấu hình Chat thường
supabase secrets set MODAL_BASE_URL="https://YOUR-CHAT-ENDPOINT.modal.run" MODAL_API_KEY="YOUR_LONG_RANDOM_TOKEN"

# 2. Cấu hình Studio Tạo Ảnh (Độc quyền datviphero@gmail.com)
supabase secrets set IMAGE_MODAL_BASE_URL="https://YOUR-IMAGE-ENDPOINT.modal.run/generate"

# 3. Deploy functions
supabase functions deploy chat
supabase functions deploy image
```

---

## 4) Host Giao Diện Miễn Phí Trên GitHub Pages

Đưa các file (`index.html`, `styles.css`, `app.js`, `config.js`) lên GitHub repository, bật GitHub Pages trong **Settings → Pages**. Khi đăng nhập bằng `datviphero@gmail.com`, hệ thống sẽ tự động mở tab **Tạo Hình Ảnh**. Các tài khoản khác chỉ thấy tab Chat thông thường.

---

## 5) Bảng Đánh Giá Model & Phân Tích Chi Phí Chi Tiết

| Model | Đặc điểm & Khả năng Uncensored | GPU tối ưu | Thời gian render / ảnh | Chi phí Modal Serverless | Chi phí qua API bên ngoài |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RealVisXL V5.0** *(Khuyên dùng số 1 cho ảnh thật)* | Vua ảnh đời thực photorealistic, làn da thật, cơ thể người chi tiết, 100% Uncensored không có safety filter. | **Nvidia L4 (24GB)** | **2.5s – 3.5s** (25 steps) | **~$0.0007 / ảnh** (~18 VNĐ) | ~$0.005 – $0.008 / ảnh (Fal/Together) |
| **Pony Diffusion V6 XL** *(Khuyên dùng số 1 cho NSFW/Anime/2.5D)* | Chuyên trị mọi tư thế khó, giải phẫu người hoàn hảo, hỗ trợ tag Danbooru lẫn văn nói tự nhiên, không rào cản đạo đức. | **Nvidia L4 (24GB)** | **2.5s – 3.5s** (25 steps) | **~$0.0007 / ảnh** (~18 VNĐ) | ~$0.005 – $0.009 / ảnh |
| **FLUX.1 [schnell]** *(Khuyên dùng cho tốc độ siêu tốc)* | Kiến trúc Flow Matching 12B, chỉ cần 4 steps, ánh sáng, chi tiết tóc tai và bàn tay cực chuẩn. | **Nvidia L4 (24GB)** | **3.0s – 4.5s** (4 steps) | **~$0.0009 / ảnh** (~22 VNĐ) | $0.003 / ảnh (Together/Fal) |
| **FLUX.1 [dev]** *(Chất lượng tối thượng)* | 12B transformer chi tiết tối đa, độ bám prompt và giải phẫu phức tạp xuất sắc nhất hiện nay. | **Nvidia A10G / L40S** | **12s – 15s** (25 steps) | **~$0.0040 / ảnh** (~100 VNĐ) | $0.025 / ảnh (~625 VNĐ) |

### 💡 Tại sao tự host trên Modal là tối ưu nhất?
1. **Uncensored 100%**: Mã nguồn chạy `pipe.safety_checker = None`, không bị nhà cung cấp API bên thứ ba can thiệp hoặc gắn cờ tài khoản.
2. **Chi phí cực thấp**: Modal tính phí theo từng giây GPU hoạt động. Với GPU Nvidia L4 ($0.80/h ~ $0.00022/s), 1 USD (~25.000 VNĐ) có thể tạo được hơn **1.400 bức ảnh** chất lượng cao.
3. **Scale-to-zero**: Khi không dùng, sau 120 giây Modal tự động tắt toàn bộ GPU, chi phí duy trì là **0 USD**.
