import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_ADMIN_EMAIL = "datviphero@gmail.com";

interface SearchResult {
  url: string;
  snippet: string;
}

// 1. Tool tìm kiếm Internet qua DuckDuckGo
async function searchWeb(query: string): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results: SearchResult[] = [];
    const regex = /<a class="result__snippet" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 5) {
      let rawUrl = match[1];
      if (rawUrl.includes("uddg=")) {
        const u = rawUrl.match(/uddg=([^&]+)/);
        if (u) rawUrl = decodeURIComponent(u[1]);
      }
      const cleanSnippet = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (cleanSnippet && !results.some(r => r.url === rawUrl)) {
        results.push({ url: rawUrl, snippet: cleanSnippet });
      }
    }
    return results;
  } catch (err) {
    console.error("Lỗi searchWeb:", err);
    return [];
  }
}

// 2. Tool đọc nội dung trang web qua Jina Reader
async function readWebpage(url: string): Promise<string> {
  try {
    const target = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LocalAIAgent/1.0)",
        "X-Return-Format": "text",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const text = await res.text();
      // Giới hạn độ dài để không làm tràn context model
      return text.slice(0, 3500);
    }
    // Fallback nếu Jina lỗi
    const rawRes = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!rawRes.ok) return `Không thể tải trang: HTTP ${rawRes.status}`;
    const rawHtml = await rawRes.text();
    const stripped = rawHtml.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, 3000);
  } catch (err) {
    return `Lỗi khi đọc trang: ${String(err)}`;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });

  // 1. Xác thực Supabase JWT
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Yêu cầu đăng nhập." }, { status: 401, headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) {
    return Response.json({ error: "Phiên đăng nhập không hợp lệ." }, { status: 401, headers: cors });
  }

  // 2. KHÓA BẢO MẬT: Chỉ cho phép admin datviphero@gmail.com
  if (user.email !== ALLOWED_ADMIN_EMAIL) {
    return Response.json(
      { error: "Forbidden: Tính năng Agent có kết nối Internet chỉ dành riêng cho tài khoản quản trị viên." },
      { status: 403, headers: cors }
    );
  }

  // 3. Kiểm tra payload
  let body: { messages?: Array<{ role: string; content: string }> };
  try { body = await req.json(); } catch { return Response.json({ error: "JSON không hợp lệ." }, { status: 400, headers: cors }); }
  if (!Array.isArray(body.messages) || body.messages.length < 1) {
    return Response.json({ error: "Danh sách tin nhắn không hợp lệ." }, { status: 400, headers: cors });
  }

  const baseUrl = Deno.env.get("MODAL_BASE_URL")?.replace(/\/$/, "");
  const modalKey = Deno.env.get("MODAL_API_KEY");
  const model = Deno.env.get("MODEL_ID") || "Qwen/Qwen2.5-7B-Instruct";
  if (!baseUrl || !modalKey) {
    return Response.json({ error: "Chưa cấu hình endpoint Modal." }, { status: 503, headers: cors });
  }

  // Thiết lập SSE Stream trả về cho client
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (data: Record<string, unknown> | string) => {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    await writer.write(encoder.encode(`data: ${payload}\n\n`));
  };

  // Chạy background Agent Loop
  (async () => {
    try {
      const agentSystemPrompt = `Bạn là Tác tử AI Độc Quyền (Agent AI) có khả năng kết nối Internet theo thời gian thực và phân tích thông tin sâu sắc.
Bạn có quyền tự hành sử dụng 2 công cụ (tools) khi cần tìm kiếm thông tin mới hoặc tra cứu tài liệu:

1. search: Tìm kiếm dữ liệu internet khi câu hỏi liên quan đến tin tức, thời sự, công nghệ mới, thông số, sự kiện gần đây hoặc bạn chưa chắc chắn.
   Cú pháp trả về: {"tool": "search", "query": "từ khóa ngắn gọn"}

2. read: Đọc nội dung chi tiết của một đường link / trang web.
   Cú pháp trả về: {"tool": "read", "url": "https://..."}

Quy tắc bắt buộc:
- Nếu bạn cần dùng công cụ, CHỈ trả về đúng chuỗi JSON chứa tool (không viết thêm bất kỳ lời dẫn nào).
- Nếu không cần dùng công cụ hoặc đã có đủ thông tin, hãy trả lời trực tiếp, rõ ràng, sâu sắc bằng tiếng Việt.
- Khi sử dụng thông tin từ internet, hãy dẫn nguồn hoặc trích link ở cuối bài viết.`;

      const workingMessages = [
        { role: "system", content: agentSystemPrompt },
        ...body.messages!.map(m => ({ role: m.role, content: m.content })),
      ];

      const collectedSources: Array<{ title?: string; url: string }> = [];
      let iterations = 0;
      const MAX_ITERATIONS = 3;

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        // Gọi model kiểm tra xem có cần dùng tool không
        const checkRes = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${modalKey}` },
          body: JSON.stringify({
            model,
            messages: workingMessages,
            temperature: 0.2,
            max_tokens: 300,
          }),
        });

        if (!checkRes.ok) {
          throw new Error(`Modal HTTP ${checkRes.status}: ${await checkRes.text()}`);
        }

        const checkJson = await checkRes.json();
        const rawContent = checkJson.choices?.[0]?.message?.content || "";

        // Kiểm tra xem model có gọi tool JSON không
        const toolMatch = rawContent.match(/\{\s*"tool"\s*:\s*"(search|read)"\s*,\s*"(query|url)"\s*:\s*"([^"]+)"\s*\}/i);

        if (toolMatch) {
          const toolType = toolMatch[1].toLowerCase();
          const toolArg = toolMatch[3];

          if (toolType === "search") {
            await sendEvent({ type: "step", text: `🔍 Đang tìm kiếm internet: "${toolArg}"` });
            const searchResults = await searchWeb(toolArg);
            
            searchResults.forEach(r => {
              if (!collectedSources.some(s => s.url === r.url)) {
                collectedSources.push({ url: r.url });
              }
            });

            const observation = searchResults.length > 0
              ? `Kết quả tìm kiếm cho "${toolArg}":\n` + searchResults.map((r, i) => `[${i + 1}] (${r.url})\n${r.snippet}`).join("\n\n")
              : `Không tìm thấy kết quả phù hợp cho "${toolArg}".`;

            await sendEvent({ type: "step", text: `✅ Đã thu thập ${searchResults.length} kết quả từ web` });
            workingMessages.push({ role: "assistant", content: rawContent });
            workingMessages.push({ role: "user", content: `[Hệ thống Observation]:\n${observation}` });
            continue;
          } else if (toolType === "read") {
            await sendEvent({ type: "step", text: `🌐 Đang đọc tài liệu: ${toolArg}` });
            const pageContent = await readWebpage(toolArg);
            if (!collectedSources.some(s => s.url === toolArg)) {
              collectedSources.push({ url: toolArg });
            }
            await sendEvent({ type: "step", text: `📄 Đã đọc nội dung từ trang web` });
            workingMessages.push({ role: "assistant", content: rawContent });
            workingMessages.push({ role: "user", content: `[Hệ thống Observation - Nội dung trang ${toolArg}]:\n${pageContent}` });
            continue;
          }
        }

        // Không cần tool nữa -> Stream câu trả lời cuối cùng
        break;
      }

      await sendEvent({ type: "step", text: "⚡ Đang tổng hợp câu trả lời chi tiết..." });

      // Gọi upstream stream câu trả lời hoàn chỉnh
      const finalRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${modalKey}` },
        body: JSON.stringify({
          model,
          messages: workingMessages,
          stream: true,
          temperature: 0.7,
        }),
      });

      if (!finalRes.ok || !finalRes.body) {
        throw new Error(`Modal stream HTTP ${finalRes.status}`);
      }

      const reader = finalRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta || {};
            const content = delta.content || "";
            const reasoning = delta.reasoning || delta.reasoning_content || "";
            if (content || reasoning) {
              await sendEvent({ type: "delta", content, reasoning });
            }
          } catch {
            // bỏ qua parse error của partial chunk
          }
        }
      }

      // Trả danh sách nguồn tham khảo nếu có
      if (collectedSources.length > 0) {
        await sendEvent({ type: "sources", sources: collectedSources });
      }

      await sendEvent("[DONE]");
    } catch (err) {
      await sendEvent({ type: "error", message: `Lỗi xử lý Agent: ${String(err)}` });
      await sendEvent("[DONE]");
    } finally {
      writer.close();
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
