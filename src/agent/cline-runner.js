/**
 * Cline CLI Runner for Sentinel Telegram Agent
 * Executes `npx cline` in headless mode and streams JSON output.
 */
const { spawn } = require("child_process");
const path = require("path");

const SANDBOX_DIR = "/opt/minitok/addons/invest";
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 300000); // 5 min
let agentRunning = false;

/**
 * Run a Cline agent task via CLI
 * @param {string} prompt - Natural language instruction
 * @param {object} opts - { apiKey, baseUrl, model, onChunk }
 * @returns {Promise<{success: boolean, summary: string}>}
 */
async function runClineTask(prompt, opts = {}) {
  if (agentRunning) {
    return { success: false, summary: "⚠️ Another agent task is already running." };
  }

  agentRunning = true;
  const startTime = Date.now();
  const chunks = [];

  try {
    const args = [
      prompt,
      "--json",
      "-c", SANDBOX_DIR,
      "--auto-approve", "true",
      "-t", String(Math.floor(TIMEOUT_MS / 1000)),
    ];

    // Provider config
    if (opts.apiKey) {
      args.push("-k", opts.apiKey);
    }
    if (opts.model) {
      args.push("-m", opts.model);
    }

    const env = Object.assign({}, process.env, {
      OPENAI_API_KEY: opts.apiKey || "",
      OPENAI_BASE_URL: opts.baseUrl || "https://api.profundoai.com/v1",
    });

    if (opts.onChunk) {
      opts.onChunk("🤖 *Agent Started*\nTask: " + prompt.substring(0, 200));
    }

    const child = spawn("cline", args, {
      cwd: SANDBOX_DIR,
      env: env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
      shell: true,
    });

    let stdoutBuf = "";
    child.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const text = extractText(msg);
          if (text && opts.onChunk) {
            chunks.push(text);
            opts.onChunk(text);
          }
        } catch {}
      }
    });

    child.stderr.on("data", (data) => {
      const errText = data.toString().trim();
      if (errText && opts.onChunk) {
        opts.onChunk("⚠️ " + errText.substring(0, 500));
      }
    });

    await new Promise((resolve, reject) => {
      child.on("close", (code) => resolve(code));
      child.on("error", reject);
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = "✅ *Agent Done* in " + elapsed + "s\nChunks: " + chunks.length;
    if (opts.onChunk) opts.onChunk("\n" + summary);

    return { success: true, summary: summary, chunks: chunks };
  } catch (e) {
    const errMsg = "❌ *Agent Error*: " + e.message;
    if (opts.onChunk) opts.onChunk(errMsg);
    return { success: false, summary: errMsg };
  } finally {
    agentRunning = false;
  }
}

function extractText(msg) {
  if (msg.type === "assistant" && msg.content) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    }
  }
  if (msg.type === "result" && msg.result) return msg.result;
  if (msg.message) return typeof msg.message === "string" ? msg.message : null;
  return null;
}

module.exports = { runClineTask };
