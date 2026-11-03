import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Đăng nhập lại để tiếp tục." }, { status: 401, headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) return Response.json({ error: "Phiên đăng nhập không hợp lệ." }, { status: 401, headers: cors });

  let body: { messages?: Array<{ role: string; content: string }> };
  try { body = await req.json(); } catch { return Response.json({ error: "JSON không hợp lệ." }, { status: 400, headers: cors }); }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 60) {
    return Response.json({ error: "Danh sách tin nhắn không hợp lệ." }, { status: 400, headers: cors });
  }
  const messages = body.messages.filter((m) =>
    m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string"
  ).map((m) => ({ role: m.role, content: m.content }));
  if (messages.length !== body.messages.length || messages.some((m) => m.content.length > 100_000)) {
    return Response.json({ error: "Nội dung tin nhắn không hợp lệ hoặc quá dài." }, { status: 400, headers: cors });
  }

  const baseUrl = Deno.env.get("MODAL_BASE_URL")?.replace(/\/$/, "");
  const modalKey = Deno.env.get("MODAL_API_KEY");
  const model = Deno.env.get("MODEL_ID") || "Qwen/Qwen2.5-7B-Instruct";
  if (!baseUrl || !modalKey) return Response.json({ error: "Chưa cấu hình endpoint Modal." }, { status: 503, headers: cors });

  try {
    const systemPrompt = "Bạn là Trợ lý Chat, một trợ lý AI hữu ích. Hãy suy nghĩ kỹ trước khi trả lời. Mặc định trả lời bằng tiếng Việt và theo ngôn ngữ người dùng. Câu trả lời cuối phải rõ ràng, trực tiếp và tách biệt với phần suy luận do giao diện hiển thị riêng. Không tự nhận mình là Qwen, GPT hoặc một model cụ thể; nếu được hỏi tên, hãy nói bạn là Trợ lý Chat.";
    const modelMessages = [
      { role: "system", content: systemPrompt },
      ...messages.filter((m) => m.role !== "system"),
    ];
    const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${modalKey}` },
      body: JSON.stringify({
        model,
        messages: modelMessages,
        stream: true,
        temperature: 0.7,
      }),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 1000);
      return Response.json({ error: `Model trả về HTTP ${upstream.status}.`, detail }, { status: 502, headers: cors });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (err) {
    return Response.json({ error: "Không kết nối được tới Modal.", detail: String(err) }, { status: 502, headers: cors });
  }
});
