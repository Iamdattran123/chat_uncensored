import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AUTHORIZED_ADMIN = "datviphero@gmail.com";

function isAuthorizedAdmin(email?: string): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e === AUTHORIZED_ADMIN || e === "datviphero@mail.com" || e.startsWith("datviphero@");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Chỉ hỗ trợ phương thức POST." }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // 1. Kiểm tra xác thực Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Thiếu Authorization header." }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user || !user.email) {
    return new Response(
      JSON.stringify({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // 2. Bảo mật độc quyền: CHỈ DUY NHẤT datviphero@gmail.com
  if (!isAuthorizedAdmin(user.email)) {
    return new Response(
      JSON.stringify({
        error: "Quyền truy cập bị từ chối: Tính năng Tạo Ảnh độc quyền chỉ dành riêng cho tài khoản " + AUTHORIZED_ADMIN,
      }),
      { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // 3. Đọc dữ liệu yêu cầu tạo ảnh
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Dữ liệu JSON không hợp lệ." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const prompt = (body.prompt || "").trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: "Prompt mô tả hình ảnh không được để trống." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const modalBaseUrl = (Deno.env.get("IMAGE_MODAL_BASE_URL") || Deno.env.get("MODAL_BASE_URL") || "").replace(/\/$/, "");
  const modalApiKey = Deno.env.get("MODAL_API_KEY") || "";

  if (!modalBaseUrl) {
    return new Response(
      JSON.stringify({
        error: "IMAGE_MODAL_BASE_URL chưa được cấu hình trong Supabase Secrets.",
      }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  const payload = {
    prompt: prompt,
    negative_prompt: body.negative_prompt || "",
    width: Number(body.width) || 1024,
    height: Number(body.height) || 1024,
    num_inference_steps: Number(body.steps) || 25,
    guidance_scale: Number(body.guidance_scale) || 6.5,
    seed: body.seed !== undefined ? Number(body.seed) : -1,
    model_id: body.model_id || "SG161222/RealVisXL_V5.0",
  };

  try {
    const targetUrl = modalBaseUrl.endsWith("/generate") ? modalBaseUrl : `${modalBaseUrl}/generate`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (modalApiKey) {
      headers["Authorization"] = `Bearer ${modalApiKey}`;
      headers["X-API-Key"] = modalApiKey;
    }

    const modalRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // Cho phép timeout tối đa 300 giây (5 phút) để Modal khởi động GPU nếu cold start
      signal: AbortSignal.timeout(300000),
    });

    if (!modalRes.ok) {
      const errText = await modalRes.text();
      return new Response(
        JSON.stringify({
          error: `GPU Model trả về lỗi (${modalRes.status}): ${errText.slice(0, 300)}`,
        }),
        { status: modalRes.status, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const data = await modalRes.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    const isTimeout = err?.name === "TimeoutError";
    return new Response(
      JSON.stringify({
        error: isTimeout
          ? "Hết thời gian chờ (Timeout): GPU Modal khởi động quá lâu hoặc quá tải."
          : `Lỗi kết nối tới GPU Modal: ${err?.message || String(err)}`,
      }),
      { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
