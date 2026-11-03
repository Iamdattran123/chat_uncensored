# Khung Chat — không cần VPS

Kiến trúc cho 2 người dùng: GitHub Pages host giao diện tĩnh; Supabase Auth/Postgres giữ tài khoản và lịch sử riêng; Supabase Edge Function làm proxy bí mật tới Modal; Modal chỉ khởi động GPU khi có chat. Không dùng GitHub Actions như máy chủ.

## 1) Tạo Supabase project và bảng lịch sử

1. Tạo project tại Supabase.
2. Mở **SQL Editor**, chạy toàn bộ `supabase/schema.sql`.
3. Vào **Project Settings → API**; lấy Project URL và public anon/publishable key. Điền vào `config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_PUBLIC_ANON_KEY'
};
```

Public anon key được phép ở frontend; không bao giờ dùng `service_role` key ở đây. Bảo vệ dữ liệu bằng RLS trong schema.

4. Trong **Authentication → Users**, tạo riêng hai tài khoản (email/mật khẩu) cho bạn và bạn của bạn. Tắt public sign-ups nếu chỉ muốn hai tài khoản.

Mỗi dòng hội thoại có `user_id`; chính sách RLS buộc người đăng nhập chỉ đọc/sửa/xoá được hội thoại của chính mình. Lịch sử được đồng bộ trong database, không dùng chung `localStorage`.

## 2) Deploy proxy tới Modal — khoá chỉ nằm ở Supabase

Cài Supabase CLI, đăng nhập và liên kết project:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Đặt secrets cho Edge Function rồi deploy:

```bash
supabase secrets set MODAL_BASE_URL="https://YOUR-ENDPOINT.modal.run" MODAL_API_KEY="YOUR_LONG_RANDOM_TOKEN" MODEL_ID="Qwen/Qwen2.5-7B-Instruct"
supabase functions deploy chat
```

`MODAL_API_KEY` phải khớp với token của Modal. Không đưa token đó vào `config.js`, GitHub, hay trình duyệt. Function xác thực access token Supabase trước khi chuyển request tới endpoint model.

Nếu chưa deploy model, xem phần **Triển khai model lên Modal** bên dưới.

## 3) Host giao diện miễn phí trên GitHub Pages

Đưa các file giao diện (`index.html`, `styles.css`, `app.js`, `config.js`) lên một GitHub repository. Mở **Settings → Pages**, chọn deploy từ branch/folder chứa các file, rồi đợi GitHub cấp URL. Các đường dẫn asset đã dùng tương đối để chạy được ở URL dạng `username.github.io/repo/`.

Mở URL đó, đăng nhập bằng tài khoản Supabase. Bạn của bạn đăng nhập bằng tài khoản riêng; danh sách lịch sử hai người được cô lập ở database bằng RLS.

## 4) Model Modal theo nhu cầu

Cần tài khoản Modal và Modal CLI đã được `modal setup`. `modal_app.py` là mẫu vLLM, mặc định GPU L40S, `min_containers=0`, `max_containers=1` và idle timeout 60 giây. Deploy:

```bash
python -m pip install modal
modal setup
export MODEL_API_KEY="YOUR_LONG_RANDOM_TOKEN"
modal secret create model-auth MODEL_API_KEY="$MODEL_API_KEY"
export MODEL_ID="Qwen/Qwen2.5-7B-Instruct"
modal deploy modal_app.py
```

Sau khi deploy, copy URL endpoint Modal vào `MODAL_BASE_URL` của bước 2. `MODEL_ID` phải giống nhau ở Modal và Edge Function. Chỉ dùng model có giấy phép phù hợp. GPU/model cần chọn theo bộ nhớ và nhu cầu; chi phí tính theo tài nguyên Modal dùng khi model hoạt động.

## Dùng thử giao diện cục bộ

Giao diện tĩnh có thể preview bằng `node server.js` rồi mở `http://localhost:3000`; cần cấu hình `config.js` trước khi đăng nhập.

## Chi phí và giới hạn cần biết

- GitHub Pages không chạy backend hay model — chỉ host file giao diện tĩnh.
- Modal scale GPU về 0 khi không có request; tin nhắn đầu tiên sau lúc nghỉ cần chờ cold start/nạp model. Cấu hình cache model trên Modal có thể giảm thời gian chờ.
- Supabase Free phù hợp để thử với ít người, nhưng dự án Free ít hoạt động có thể bị tự pause; nếu cần đảm bảo luôn truy cập được, cần kiểm tra điều khoản/gói hiện tại hoặc chọn gói trả phí.
- App mẫu chưa thêm giới hạn tốc độ hay hạn mức chi tiêu; hãy bật billing alerts/rate limits phù hợp trước khi chia sẻ rộng. Không chia sẻ URL/token Modal ngoài Edge Function.
