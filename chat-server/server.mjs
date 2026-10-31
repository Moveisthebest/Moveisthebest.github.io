// Chat proxy for the homepage "Chat with me" widget.
// Browser -> nginx (https://flash-api.top/kw-chat/) -> this server -> DeepSeek.
// The API key only lives in /etc/kw-chat.env on the server.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { buildSystemPrompt, TOOLS, runTool, describeTool } from "./knowledge.mjs";

const env = process.env;
const PORT = Number(env.PORT) || 8791;
const HOST = env.HOST || "127.0.0.1";
const UPSTREAM_URL = env.UPSTREAM_URL || "https://api.deepseek.com/chat/completions";
const MODEL = env.MODEL || "deepseek-chat";
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || "https://moveisthebest.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const LIMITS = {
  ipTokensPerDay: Number(env.IP_TOKENS_PER_DAY) || 150000,
  globalTokensPerDay: Number(env.GLOBAL_TOKENS_PER_DAY) || 3000000,
  ipRequestsPerMinute: Number(env.IP_REQUESTS_PER_MINUTE) || 6,
  maxConcurrent: Number(env.MAX_CONCURRENT) || 20,
};
// Cached input is much cheaper on DeepSeek, so it only counts at this fraction.
const CACHE_HIT_WEIGHT = env.CACHE_HIT_WEIGHT !== undefined ? Number(env.CACHE_HIT_WEIGHT) : 0.1;
const MAX_OUTPUT_TOKENS = Number(env.MAX_OUTPUT_TOKENS) || 800;
const MAX_TOOL_ROUNDS = 3;
const MAX_MESSAGES = 12;
const MAX_CHARS_PER_MESSAGE = 1500;
const MAX_BODY_BYTES = 32 * 1024;
const STATE_FILE = path.join(env.STATE_DIRECTORY || ".", "usage.json");

const ERRORS = {
  rate: "You're sending messages too quickly. Please wait a minute.",
  ip_quota: "You've used up today's chat quota. Please come back tomorrow, or email me directly.",
  global_quota: "The assistant has reached its daily budget. Please come back tomorrow, or email me directly.",
  busy: "The assistant is busy right now. Please try again in a moment.",
  bad_request: "Invalid request.",
  not_configured: "The assistant is not configured yet.",
  upstream: "The AI service is temporarily unavailable. Please try again later.",
};

const today = () => new Date().toISOString().slice(0, 10);

// Token budgets per IP and globally, reset daily (UTC). Node is single-threaded,
// so reserve() is atomic; usage is persisted so a restart does not reset it.
class Limiter {
  constructor(file) {
    this.file = file;
    this.recent = new Map(); // ip -> request timestamps in the last minute
    try {
      this.state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.state = null;
    }
    if (!this.state || this.state.day !== today()) this.state = { day: today(), ips: {}, global: 0 };
    setInterval(() => this.pruneRecent(), 5 * 60 * 1000).unref();
  }

  rollDay() {
    if (this.state.day !== today()) {
      this.state = { day: today(), ips: {}, global: 0 };
      this.markDirty();
    }
  }

  // Allowed while any quota is left; the estimate is held until settle() so that
  // a burst of parallel requests cannot all slip through.
  reserve(ip, estimate) {
    this.rollDay();
    const now = Date.now();
    const recent = (this.recent.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= LIMITS.ipRequestsPerMinute) return { ok: false, reason: "rate" };
    const ipUsed = this.state.ips[ip] || 0;
    if (ipUsed >= LIMITS.ipTokensPerDay) return { ok: false, reason: "ip_quota" };
    if (this.state.global >= LIMITS.globalTokensPerDay) return { ok: false, reason: "global_quota" };
    recent.push(now);
    this.recent.set(ip, recent);
    this.state.ips[ip] = ipUsed + estimate;
    this.state.global += estimate;
    this.markDirty();
    return { ok: true, day: this.state.day };
  }

  settle(ip, day, delta) {
    if (!delta || this.state.day !== day) return;
    this.state.ips[ip] = Math.max(0, (this.state.ips[ip] || 0) + delta);
    this.state.global = Math.max(0, this.state.global + delta);
    this.markDirty();
  }

  // Percentage of today's quota this IP has left.
  remaining(ip) {
    this.rollDay();
    if (this.state.global >= LIMITS.globalTokensPerDay) return 0;
    const used = this.state.ips[ip] || 0;
    return Math.max(0, Math.floor(100 * (1 - used / LIMITS.ipTokensPerDay)));
  }

  pruneRecent() {
    const now = Date.now();
    for (const [ip, times] of this.recent) {
      if (!times.some((t) => now - t < 60000)) this.recent.delete(ip);
    }
  }

  markDirty() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 2000);
  }

  save() {
    clearTimeout(this.timer);
    try {
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.state));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch (e) {
      console.error("failed to save usage:", e.message);
    }
  }
}

const limiter = new Limiter(STATE_FILE);
let active = 0;

function sendJson(res, status, data, headers) {
  res.writeHead(status, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res, status, code, headers, extra) {
  sendJson(res, status, { error: code, message: ERRORS[code], ...extra }, headers);
}

// nginx sets X-Real-IP; this server only listens on localhost, so it cannot be spoofed.
const clientIp = (req) => req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";

// Uncached input + output, plus cached input at CACHE_HIT_WEIGHT.
function billableTokens(usage) {
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
  return Math.ceil(miss + (usage.completion_tokens || 0) + hit * CACHE_HIT_WEIGHT);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // nginx already caps bodies at 64k; drain oversized ones so we can still reply.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) reject(new Error("too_large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const messages = raw
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: String((m && m.content) || "").slice(0, MAX_CHARS_PER_MESSAGE),
    }))
    .filter((m) => m.content.trim());
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return messages;
}

// Reads one streamed DeepSeek reply: forwards text deltas, collects tool calls and usage.
async function readStream(body, onText) {
  const decoder = new TextDecoder();
  const toolCalls = [];
  let buffer = "";
  let content = "";
  let usage = null;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith("data:") || line === "data: [DONE]") continue;
      let data;
      try {
        data = JSON.parse(line.slice(5));
      } catch {
        continue; // keep-alive or partial line
      }
      if (data.usage) usage = data.usage;
      const delta = data.choices && data.choices[0] && data.choices[0].delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const call = (toolCalls[tc.index || 0] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) call.id = tc.id;
        if (tc.function && tc.function.name) call.function.name += tc.function.name;
        if (tc.function && tc.function.arguments) call.function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, usage, toolCalls: toolCalls.filter(Boolean) };
}

async function handleChat(req, res, cors) {
  if (!env.DEEPSEEK_API_KEY) return sendError(res, 503, "not_configured", cors);

  let messages;
  try {
    messages = sanitizeMessages(JSON.parse(await readBody(req)).messages);
  } catch {
    messages = null;
  }
  if (!messages) return sendError(res, 400, "bad_request", cors);
  if (active >= LIMITS.maxConcurrent) return sendError(res, 503, "busy", cors);

  const { prompt, papers } = buildSystemPrompt(messages);
  // Rough upper bound for one call (~0.6 token per char for mixed zh/en), held while the
  // request runs and replaced by the real usage afterwards.
  const chars = prompt.length + messages.reduce((n, m) => n + m.content.length, 0);
  const estimate = Math.ceil(chars * 0.6) + MAX_OUTPUT_TOKENS;

  const ip = clientIp(req);
  const reservation = limiter.reserve(ip, estimate);
  if (!reservation.ok) {
    return sendError(res, 429, reservation.reason, cors, { quota: limiter.remaining(ip) });
  }

  active++;
  const abort = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) abort.abort(); // visitor left the page: stop generating (and paying)
  });

  const conversation = [{ role: "system", content: prompt }, ...messages];
  const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const toolsUsed = [];
  let charged = 0; // billable tokens of finished DeepSeek calls
  let callInFlight = false;

  try {
    for (let round = 0; ; round++) {
      const useTools = TOOLS.length > 0 && round < MAX_TOOL_ROUNDS;
      callInFlight = true;
      const upstream = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: conversation,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0.3,
          stream: true,
          stream_options: { include_usage: true },
          ...(useTools && { tools: TOOLS }),
        }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      });

      if (!upstream.ok || !upstream.body) {
        callInFlight = false;
        console.error(`upstream ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`);
        if (!res.headersSent) return sendError(res, 502, "upstream", cors);
        event({ error: ERRORS.upstream });
        break;
      }

      if (!res.headersSent) {
        res.writeHead(200, {
          ...cors,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        });
      }

      const { content, usage, toolCalls } = await readStream(upstream.body, (text) =>
        event({ choices: [{ delta: { content: text } }] })
      );
      callInFlight = false;
      charged += usage ? billableTokens(usage) : estimate;
      if (!useTools || !toolCalls.length) break;

      // The model asked to read the original paper: run the tools and call it again.
      conversation.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        toolsUsed.push(call.function.name);
        event({ status: describeTool(call.function.name, call.function.arguments) });
        conversation.push({ role: "tool", tool_call_id: call.id, content: runTool(call.function.name, call.function.arguments) });
      }
    }
  } catch (e) {
    if (!res.headersSent) {
      callInFlight = false; // nothing was generated
      sendError(res, 502, "upstream", cors);
    } else if (e.name !== "AbortError") {
      event({ error: ERRORS.upstream });
    }
    if (e.name !== "AbortError") console.error("chat error:", e.message);
  } finally {
    finished = true;
    active--;
    // A call cut off mid-stream has no usage report, so it costs the full estimate.
    if (callInFlight) charged += estimate;
    limiter.settle(ip, reservation.day, charged - estimate);
    if (res.headersSent && !res.writableEnded) {
      event({ quota: limiter.remaining(ip) });
      res.end("data: [DONE]\n\n");
    }
    console.log(`${ip} papers=[${papers.join(",")}] tools=[${toolsUsed.join(",")}] billable=${charged}`);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const originOk = ALLOWED_ORIGINS.includes(origin);
  const cors = {
    "Access-Control-Allow-Origin": originOk ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  const { pathname } = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(originOk ? 204 : 403, cors);
    return res.end();
  }
  if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true }, {});
  if (req.method === "GET" && pathname === "/quota") {
    if (!originOk) return sendJson(res, 403, { error: "forbidden_origin" }, cors);
    return sendJson(res, 200, { quota: limiter.remaining(clientIp(req)) }, cors);
  }
  if (req.method !== "POST" || pathname !== "/chat") return sendJson(res, 404, { error: "not_found" }, cors);
  if (!originOk) return sendJson(res, 403, { error: "forbidden_origin" }, cors);

  try {
    await handleChat(req, res, cors);
  } catch (e) {
    console.error("unhandled:", e);
    if (!res.headersSent) sendError(res, 500, "upstream", cors);
  }
});

server.listen(PORT, HOST, () => console.log(`kw-chat listening on ${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    limiter.save();
    process.exit(0);
  });
}