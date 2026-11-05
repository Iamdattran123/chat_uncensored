import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Hàm gọi Modal Sandbox OCR để phân tích hình ảnh đa ngôn ngữ
async function analyzeImageViaSandbox(
  sandboxUrl: string,
  modalKey: string,
  imageData: string
): Promise<string> {
  try {
    const isUrl = imageData.startsWith("http://") || imageData.startsWith("https://");
    const payload = isUrl
      ? { action: "analyze_image", url: imageData }
      : { action: "analyze_image", image_base64: imageData };

    const res = await fetch(sandboxUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${modalKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(18000), // 18s cho OCR
    });

    if (!res.ok) {
      return `[Lỗi phân tích ảnh: HTTP ${res.status}]`;
    }

    const data = await res.json();
    if (data.error) {
      return `[Lỗi bóc tách ảnh: ${data.error}]`;
    }

    let report = `[KẾT QUẢ THỊ GIÁC & OCR HÌNH ẢNH]:\n- Định dạng: ${data.format || "Ảnh"} (${data.width || "?"}x${data.height || "?"}px)`;
    if (data.has_text && data.extracted_text) {
      report += `\n- Toàn bộ văn bản/mã code/log lỗi bóc tách được từ hình ảnh:\n"""\n${data.extracted_text}\n"""`;
    } else {
      report += `\n- Không phát hiện văn bản hoặc code rõ ràng trong ảnh (ảnh đồ họa/minh họa).`;
    }
    return report;
  } catch (err) {
    return `[Không thể kết nối OCR Sandbox: ${String(err)}]`;
  }
}

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

  let body: { messages?: Array<{ role: string; content: string; image?: string }> };
  try { body = await req.json(); } catch { return Response.json({ error: "JSON không hợp lệ." }, { status: 400, headers: cors }); }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 80) {
    return Response.json({ error: "Danh sách tin nhắn không hợp lệ." }, { status: 400, headers: cors });
  }

  const rawMessages = body.messages.filter((m) =>
    m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string"
  );
  if (rawMessages.length !== body.messages.length) {
    return Response.json({ error: "Nội dung tin nhắn không hợp lệ." }, { status: 400, headers: cors });
  }

  const baseUrl = Deno.env.get("MODAL_BASE_URL")?.replace(/\/$/, "");
  const modalKey = Deno.env.get("MODAL_API_KEY");
  const model = Deno.env.get("MODEL_ID") || "Huihui-AI/Huihui-Qwen3-8B-abliterated-v2";
  const sandboxUrl = (Deno.env.get("SANDBOX_BASE_URL") || Deno.env.get("AGENT_MODAL_BASE_URL") || baseUrl)?.replace(/\/$/, "");

  if (!baseUrl || !modalKey) return Response.json({ error: "Chưa cấu hình endpoint Modal." }, { status: 503, headers: cors });

  try {
    // 1. Xử lý ảnh đính kèm (nếu có) thông qua OCR Sandbox
    const processedMessages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      let textContent = msg.content;

      // Chỉ xử lý OCR cho ảnh ở tin nhắn của người dùng nếu có đính kèm
      if (msg.role === "user" && msg.image && sandboxUrl) {
        // Chỉ chạy OCR cho 2 ảnh gần nhất để tối ưu tốc độ
        if (i >= rawMessages.length - 3) {
          const ocrText = await analyzeImageViaSandbox(sandboxUrl, modalKey, msg.image);
          textContent = `${ocrText}\n\n[Câu hỏi/Yêu cầu của người dùng]:\n${msg.content || "Hãy đọc hiểu và phân tích hình ảnh này."}`;
        }
      }

      processedMessages.push({ role: msg.role, content: textContent });
    }

    // 2. System prompt chuẩn Staff chống nói dài dòng & tối ưu trí nhớ ngữ cảnh
    const systemPrompt = `Bạn là Trợ lý AI Thông minh, Sắc bén và Đa năng. Hãy suy nghĩ logic và đọc kỹ toàn bộ tiến trình lịch sử cuộc trò chuyện trước khi trả lời.

NGUYÊN TẮC HỘI THOẠI & BỘ NHỚ NGỮ CẢNH CỐT LÕI:
1. GHI NHỚ VÀ KẾ THỪA LỊCH SỬ 100%:
   - Luôn đọc lại các tin nhắn trước để nắm bắt chính xác người dùng đang hỏi gì, giải quyết vấn đề gì, đã đề cập đến các chi tiết hay đoạn mã nào.
   - Khi người dùng đưa ra câu hỏi ngắn, câu hỏi tiếp nối (ví dụ: "tại sao?", "sửa tiếp đi", "đoạn code trên chạy như thế nào?", "thử cách khác xem"): Bạn PHẢI hiểu ngay ngữ cảnh trước đó, nối tiếp câu chuyện liền mạch và giải quyết trực tiếp vấn đề, TUYỆT ĐỐI KHÔNG bắt người dùng nhắc lại và không bị lạc đề sang chủ đề khác!
2. CHỐNG NÓI DÀI DÒNG & LAN MAN:
   - Đi THẲNG VÀO TRỌNG TÂM câu hỏi. Cung cấp câu trả lời rõ ràng, sắc bén, có chiều sâu kỹ thuật.
   - TUYỆT ĐỐI KHÔNG mở bài rườm rà (cấm các câu chào hỏi kiểu "Chào bạn, tôi rất vui lòng giúp...", "Dưới đây là câu trả lời cho bạn...").
   - TUYỆT ĐỐI KHÔNG kết bài hoa mỹ, sáo rỗng hoặc giảng giải đạo đức (cấm các câu "Hy vọng thông tin này giúp ích cho bạn", "Nếu bạn có thắc mắc gì thêm hãy cho tôi biết...").
3. ĐỌC HIỂU HÌNH ẢNH (VISION & OCR):
   - Khi người dùng gửi hình ảnh (ảnh chụp màn hình lỗi, source code, giao diện, bảng biểu, tài liệu), hệ thống OCR thị giác đã bóc tách toàn bộ ký tự, cấu trúc và văn bản đưa vào tin nhắn.
   - Hãy đọc kỹ nội dung bóc tách này để chỉ ra đúng dòng lỗi, phân tích nguyên nhân và giải quyết chuẩn xác yêu cầu của người dùng dựa trên hình ảnh đó.
4. Mặc định trả lời bằng tiếng Việt tự nhiên, lưu loát. Không tự nhận mình là Qwen hay GPT; nếu được hỏi tên, bạn là Trợ lý Chat.`;

    // 3. Khử trùng lặp và làm sạch ngữ cảnh
    const modelMessages = [
      { role: "system", content: systemPrompt },
      ...processedMessages.filter((m) => m.role !== "system"),
    ];

    const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${modalKey}` },
      body: JSON.stringify({
        model,
        messages: modelMessages,
        stream: true,
        temperature: 0.3, // Nhiệt độ 0.3 giúp model 8B trả lời cực kỳ chuẩn xác, tránh loạn thông tin
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
