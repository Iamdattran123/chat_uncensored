import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isAuthorizedAdmin(email?: string): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e === "datviphero@gmail.com" || e === "datviphero@mail.com" || e.startsWith("datviphero@");
}

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
      return text.slice(0, 3500);
    }
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

// 3. Tool tương tác Cloud Sandbox Cô Lập (Modal Sandbox Endpoint)
async function callCloudSandbox(sandboxUrl: string, modalKey: string, payload: Record<string, unknown>): Promise<string> {
  try {
    const res = await fetch(sandboxUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${modalKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000), // Timeout 60s cho các lệnh sandbox
    });

    if (!res.ok) {
      return `Lỗi Cloud Sandbox: HTTP ${res.status} - ${await res.text()}`;
    }
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch (err) {
    return `Lỗi kết nối Cloud Sandbox: ${String(err)}`;
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

  // 2. KHÓA BẢO MẬT: Chỉ cho phép admin datviphero@...
  if (!isAuthorizedAdmin(user.email)) {
    return Response.json(
      { error: "Forbidden: Tính năng Agent có kết nối Internet & Sandbox chỉ dành riêng cho tài khoản quản trị viên." },
      { status: 403, headers: cors }
    );
  }

  // 3. Kiểm tra payload
  let body: { messages?: Array<{ role: string; content: string }> };
  try { body = await req.json(); } catch { return Response.json({ error: "JSON không hợp lệ." }, { status: 400, headers: cors }); }
  if (!Array.isArray(body.messages) || body.messages.length < 1) {
    return Response.json({ error: "Danh sách tin nhắn không hợp lệ." }, { status: 400, headers: cors });
  }

  // Ưu tiên AGENT_MODAL_BASE_URL (Não 32B), fallback sang MODAL_BASE_URL (Không làm ảnh hưởng Chat thường)
  const baseUrl = (Deno.env.get("AGENT_MODAL_BASE_URL") || Deno.env.get("MODAL_BASE_URL"))?.replace(/\/$/, "");
  const modalKey = Deno.env.get("AGENT_MODAL_API_KEY") || Deno.env.get("MODAL_API_KEY");
  const model = Deno.env.get("AGENT_MODEL_ID") || "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ";
  const sandboxUrl = Deno.env.get("SANDBOX_BASE_URL")?.replace(/\/$/, "");

  if (!baseUrl || !modalKey) {
    return Response.json({ error: "Chưa cấu hình endpoint Modal cho Agent." }, { status: 503, headers: cors });
  }

  // Thiết lập SSE Stream trả về cho client
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (data: Record<string, unknown> | string) => {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    await writer.write(encoder.encode(`data: ${payload}\n\n`));
  };

  // Chạy background Agent Loop với Coder 32B & Cloud Sandbox
  (async () => {
    try {
      const agentSystemPrompt = `Bạn là Tác tử AI Cấp cao (Autonomous Coder & Security Investigation Agent) sở hữu não bộ Qwen 32B Coder siêu việt và hệ thống Cloud Sandbox cô lập an toàn 100%.
Bạn có quyền tự hành sử dụng các công cụ (tools) khi cần tìm kiếm, kiểm tra, dịch ngược hoặc chạy thử code:

1. search: Tìm kiếm thông tin trên internet khi cần tra cứu tài liệu mới, thông số, thư viện.
   Cú pháp: {"tool": "search", "query": "từ khóa ngắn gọn"}

2. read: Đọc tài liệu chi tiết từ một URL / trang web.
   Cú pháp: {"tool": "read", "url": "https://..."}

3. sandbox_inspect: Tải tệp/binary/game/kho lưu trữ từ đường link vào Cloud Sandbox cô lập để kiểm tra định dạng (file), trích xuất chuỗi nhạy cảm (strings), duyệt tệp bên trong zip/apk/archive, kiểm tra PE headers.
   Cú pháp: {"tool": "sandbox_inspect", "url": "https://..."}

4. sandbox_execute: Thực thi an toàn một script Python hoặc Bash trong Cloud Sandbox cô lập để giải mã, thử nghiệm giải thuật hoặc bóc tách dữ liệu.
   Cú pháp: {"tool": "sandbox_execute", "language": "python", "code": "mã code python cần chạy"}

QUY TẮC BẮT BUỘC:
- Mọi hoạt động dịch ngược, tải tệp lạ hoặc thực thi code BẮT BUỘC phải dùng sandbox_inspect / sandbox_execute để đảm bảo an toàn tuyệt đối, không chạm vào máy local.
- Khi cần dùng công cụ, CHỈ trả về đúng chuỗi JSON chứa tool (không viết thêm bất kỳ lời dẫn nào).
- Khi đã có dữ liệu hoặc không cần tool, hãy giải thích chi tiết, chuyên nghiệp ở cấp độ Staff Engineer bằng tiếng Việt, trình bày rõ logic, mã nguồn phục hồi và các phát hiện điều tra.`;

      const workingMessages = [
        { role: "system", content: agentSystemPrompt },
        ...body.messages!.map(m => ({ role: m.role, content: m.content })),
      ];

      const collectedSources: Array<{ title?: string; url: string }> = [];
      let iterations = 0;
      const MAX_ITERATIONS = 4;

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        // Gọi model kiểm tra xem có cần dùng tool không
        const checkRes = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${modalKey}` },
          body: JSON.stringify({
            model,
            messages: workingMessages,
            temperature: 0.1,
            max_tokens: 450,
          }),
        });

        if (!checkRes.ok) {
          throw new Error(`Modal HTTP ${checkRes.status}: ${await checkRes.text()}`);
        }

        const checkJson = await checkRes.json();
        const rawContent = checkJson.choices?.[0]?.message?.content || "";

        // Kiểm tra xem model có gọi tool JSON không
        let toolCall: { tool: string; [key: string]: unknown } | null = null;
        try {
          const jsonMatch = rawContent.match(/\{[\s\S]*?"tool"[\s\S]*?\}/);
          if (jsonMatch) {
            toolCall = JSON.parse(jsonMatch[0]);
          }
        } catch {
          toolCall = null;
        }

        if (toolCall && toolCall.tool) {
          const toolType = String(toolCall.tool).toLowerCase();

          if (toolType === "search") {
            const query = String(toolCall.query || "");
            await sendEvent({ type: "step", text: `🔍 Đang tìm kiếm internet: "${query}"` });
            const searchResults = await searchWeb(query);
            searchResults.forEach(r => {
              if (!collectedSources.some(s => s.url === r.url)) collectedSources.push({ url: r.url });
            });
            const observation = searchResults.length > 0
              ? `Kết quả tìm kiếm cho "${query}":\n` + searchResults.map((r, i) => `[${i + 1}] (${r.url})\n${r.snippet}`).join("\n\n")
              : `Không tìm thấy kết quả phù hợp cho "${query}".`;
            await sendEvent({ type: "step", text: `✅ Đã thu thập ${searchResults.length} kết quả từ web` });
            workingMessages.push({ role: "assistant", content: rawContent });
            workingMessages.push({ role: "user", content: `[Hệ thống Observation]:\n${observation}` });
            continue;
          } else if (toolType === "read") {
            const url = String(toolCall.url || "");
            await sendEvent({ type: "step", text: `🌐 Đang đọc tài liệu: ${url}` });
            const pageContent = await readWebpage(url);
            if (!collectedSources.some(s => s.url === url)) collectedSources.push({ url });
            await sendEvent({ type: "step", text: `📄 Đã đọc xong nội dung trang web` });
            workingMessages.push({ role: "assistant", content: rawContent });
            workingMessages.push({ role: "user", content: `[Hệ thống Observation - Nội dung ${url}]:\n${pageContent}` });
            continue;
          } else if (toolType === "sandbox_inspect") {
            const targetUrl = String(toolCall.url || "");
            await sendEvent({ type: "step", text: `🛡️ Cloud Sandbox: Đang tải tệp vào môi trường cách ly...` });
            let observation = "";
            if (sandboxUrl) {
              const sandboxRes = await callCloudSandbox(sandboxUrl, modalKey, { action: "inspect", url: targetUrl });
              observation = `[Kết quả phân tích Sandbox]:\n${sandboxRes}`;
              await sendEvent({ type: "step", text: `⚙️ Cloud Sandbox: Hoàn tất trích xuất strings & cấu trúc tệp` });
            } else {
              observation = `[Cloud Sandbox]: Chưa cấu hình biến môi trường SANDBOX_BASE_URL trên Supabase. Hãy triển khai modal_agent.py và điền SANDBOX_BASE_URL.`;
              await sendEvent({ type: "step", text: `⚠️ Cloud Sandbox: Chưa cấu hình endpoint SANDBOX_BASE_URL` });
            }
            workingMessages.push({ role: "assistant", content: rawContent });
            workingMessages.push({ role: "user", content: `[Hệ thống Observation]:\n${observation}` });
            continue;
          } else if (toolType === "sandbox_execute") {
            const code = String(toolCall.code || "");
            const language = String(toolCall.language || "python");
            await sendEvent({ type: "step", text: `💻 Cloud Sandbox: Đang thực thi mã ${language} trong môi trường cách ly...` });
            let observation = "";
            if (sandboxUrl) {
              const sandboxRes = await callCloudSandbox(sandboxUrl, modalKey, { action: "execute", language, code });
              observation = `[Kết quả thực thi Sandbox]:\n${sandboxRes}`;
              await sendEvent({ type: "step", text: `✅ Cloud Sandbox: Đã nhận stdout/stderr từ container` });
            } else {
              observation = `[Cloud Sandbox]: Chưa cấu hình SANDBOX_BASE_URL. Hãy deploy modal_agent.py để sử dụng tính năng chạy code cách ly.`;
              await sendEvent({ type: "step", text: `⚠️ Cloud Sandbox: Chưa cấu hình SANDBOX_BASE_URL` });
            }
            workingMessages.push({ role: "assistant", content: rawContent });
            workingMessages.push({ role: "user", content: `[Hệ thống Observation]:\n${observation}` });
            continue;
          }
        }

        // Không cần tool nữa -> Thoát vòng lặp để stream câu trả lời
        break;
      }

      await sendEvent({ type: "step", text: "⚡ Đang phân tích logic và tổng hợp báo cáo chi tiết..." });

      // Gọi upstream stream câu trả lời hoàn chỉnh từ Coder 32B
      const finalRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${modalKey}` },
        body: JSON.stringify({
          model,
          messages: workingMessages,
          stream: true,
          temperature: 0.6,
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
          } catch {}
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
