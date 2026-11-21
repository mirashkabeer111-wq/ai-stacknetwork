
const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

app.set("trust proxy", 1);

/* BASIC SECURITY HEADERS */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

/* REQUEST BODY */
app.use(express.json({
  limit: "1mb"
}));

/* STATIC WEBSITE */
app.use(express.static(path.join(__dirname, "public")));

/* HEALTH CHECK */
app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    status: "online",
    name: "StackNetwork AI",
    model: MODEL
  });
});

/* CONFIG */
app.get("/api/config", (req, res) => {
  res.json({
    name: "StackNetwork AI",
    developer: "Muhammad Ashmil"
  });
});

/* SIMPLE IN-MEMORY RATE LIMITER */
const rateLimits = new Map();

const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 1000;

function chatRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  let record = rateLimits.get(ip);

  if (!record || now - record.start > RATE_WINDOW) {
    record = {
      start: now,
      count: 0
    };
  }

  record.count++;
  rateLimits.set(ip, record);

  res.setHeader("X-RateLimit-Limit", RATE_LIMIT);
  res.setHeader(
    "X-RateLimit-Remaining",
    Math.max(0, RATE_LIMIT - record.count)
  );

  if (record.count > RATE_LIMIT) {
    const retryAfter = Math.ceil(
      (record.start + RATE_WINDOW - now) / 1000
    );

    res.setHeader("Retry-After", retryAfter);

    return res.status(429).json({
      error: "Too many requests. Please wait a minute and try again."
    });
  }

  next();
}

/* CLEAN OLD RATE LIMIT RECORDS */
setInterval(() => {
  const now = Date.now();

  for (const [ip, record] of rateLimits.entries()) {
    if (now - record.start > RATE_WINDOW * 2) {
      rateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

/* CHAT API */
app.post("/api/chat", chatRateLimit, async (req, res) => {
  let timeout;
  let controller;
  let clientDisconnected = false;
  let timedOut = false;

  try {
    const {
      messages,
      instructions = "",
      answerLength = "medium",
      mode = "fast",
      persona = "helpful",
      style = "balanced"
    } = req.body || {};

    /* API KEY CHECK */
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing in Render Environment."
      });
    }

    /* MESSAGE VALIDATION */
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Please enter a message."
      });
    }

    if (messages.length > 30) {
      return res.status(400).json({
        error: "Too many messages. Start a new conversation."
      });
    }

    const validMessages = [];

    for (const message of messages) {
      if (
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" ||
        !message.content.trim()
      ) {
        return res.status(400).json({
          error: "Invalid message format."
        });
      }

      if (message.content.length > 12000) {
        return res.status(400).json({
          error: "A message is too long. Please shorten it."
        });
      }

      validMessages.push({
        role: message.role,
        content: message.content
      });
    }

    /* LAST MESSAGE MUST BE FROM USER */
    if (validMessages[validMessages.length - 1].role !== "user") {
      return res.status(400).json({
        error: "The latest message must be from the user."
      });
    }

    /* SETTING VALIDATION */
    const allowedModes = ["fast", "thinking"];
    const allowedLengths = ["short", "medium", "long"];

    const allowedPersonas = [
      "helpful",
      "teacher",
      "coder",
      "creative",
      "professional",
      "gamer"
    ];

    const allowedStyles = [
      "balanced",
      "friendly",
      "professional",
      "simple",
      "detailed"
    ];

    const safeMode = allowedModes.includes(mode) ? mode : "fast";
    const safeLength = allowedLengths.includes(answerLength)
      ? answerLength
      : "medium";

    const safePersona = allowedPersonas.includes(persona)
      ? persona
      : "helpful";

    const safeStyle = allowedStyles.includes(style)
      ? style
      : "balanced";

    const safeInstructions =
      typeof instructions === "string"
        ? instructions.slice(0, 4000)
        : "";

    /* AI PERSONALITIES */
    const personas = {
      helpful: "You are a helpful and friendly AI assistant.",
      teacher: "You are a patient teacher. Explain things clearly.",
      coder: "You are an expert programming and coding assistant.",
      creative: "You are a creative writing assistant.",
      professional: "You are a professional AI assistant.",
      gamer: "You are a gaming expert, especially in Minecraft."
    };

    /* ANSWER LENGTH */
    const lengths = {
      short: "Keep answers short and direct.",
      medium: "Give balanced answers with useful details.",
      long: "Give detailed answers with examples when useful."
    };

    /* RESPONSE STYLE */
    const styles = {
      balanced: "Use a natural balanced writing style.",
      friendly: "Use a friendly conversational tone.",
      professional: "Use a professional tone.",
      simple: "Use simple language that is easy to understand.",
      detailed: "Explain topics thoroughly with useful details."
    };

    /* SYSTEM PROMPT */
    const systemPrompt = `
IDENTITY:
- Your official name is StackNetwork AI.
- You are StackNetwork AI, a friendly and intelligent AI assistant.
- Never introduce yourself as ChatGPT.
- If asked your name, say: "My name is StackNetwork AI."
- If asked who developed you, say:
  "I was developed for StackNetwork by Muhammad Ashmil."
- Your underlying language model is provided by Groq.
- Do not falsely claim to be a different AI model.

DEVELOPER:
Muhammad Ashmil

PERSONALITY:
- Be helpful, friendly, intelligent and accurate.
- Understand the user's actual question.
- Avoid unnecessary refusals.
- Do not claim to have performed actions you cannot perform.

SAFETY:
- Allow harmless educational discussions, fictional stories,
  historical discussions and cybersecurity learning.
- Do not provide actionable instructions for real-world violence,
  theft, fraud, malware deployment or unauthorized cyberattacks.
- If a request crosses these boundaries, briefly refuse that part.

PERSONA:
${personas[safePersona]}

ANSWER LENGTH:
${lengths[safeLength]}

RESPONSE STYLE:
${styles[safeStyle]}

MODE:
${safeMode === "thinking"
  ? "Think carefully before answering. Do not reveal private reasoning."
  : "Answer quickly and directly."}

CUSTOM INSTRUCTIONS:
${safeInstructions}

Always provide a visible final answer.
`;

    /* CANCEL GROQ IF CLIENT DISCONNECTS */
    controller = new AbortController();

    const onClientClose = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        controller.abort();
      }
    };

    res.on("close", onClientClose);

    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90000);

    /* GROQ REQUEST */
    const requestBody = {
      model: MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...validMessages
      ],
      max_completion_tokens: 8192,
      stream: false
    };

    /*
      GPT-OSS supports reasoning_effort.
      Other models receive the thinking instruction in the system prompt.
    */
    if (MODEL.toLowerCase().includes("gpt-oss")) {
      requestBody.reasoning_effort =
        safeMode === "thinking" ? "high" : "low";
    }

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    const raw = await groqResponse.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Invalid Groq JSON response.");

      return res.status(502).json({
        error: "Groq returned an invalid response."
      });
    }

    /* GROQ ERROR */
    if (!groqResponse.ok) {
      console.error("Groq API error:", {
        status: groqResponse.status,
        message: data.error?.message || "Unknown provider error"
      });

      return res.status(502).json({
        error: data.error?.message || "Groq API request failed."
      });
    }

    /* GET AI RESPONSE */
    const choice = data.choices?.[0];
    const message = choice?.message;

    let reply = message?.content;

    if (Array.isArray(reply)) {
      reply = reply
        .filter(part => part.type === "text")
        .map(part => part.text || "")
        .join("\n");
    }

    if (typeof reply !== "string" || !reply.trim()) {
      console.error("Groq returned an empty response:", {
        model: data.model,
        finish_reason: choice?.finish_reason,
        usage: data.usage
      });

      return res.status(502).json({
        error:
          "Groq returned no visible text. Finish reason: " +
          (choice?.finish_reason || "unknown") +
          ". Check Render Logs."
      });
    }

    /* SUCCESS */
    return res.json({
      reply: reply.trim(),
      model: data.model
    });

  } catch (error) {
    if (clientDisconnected) {
      console.log("Client disconnected. Groq request cancelled.");
      return;
    }

    if (timedOut || error.name === "AbortError") {
      console.error("Groq request timed out.");

      if (!res.headersSent && !res.destroyed) {
        return res.status(504).json({
          error: "The AI request timed out. Please try again."
        });
      }

      return;
    }

    console.error("Chat server error:", error.message);

    if (!res.headersSent && !res.destroyed) {
      return res.status(500).json({
        error: "An internal server error occurred. Please try again."
      });
    }

  } finally {
    if (timeout) clearTimeout(timeout);
    if (controller) {
      res.removeAllListeners("close");
    }
  }
});

/* UNKNOWN API ROUTES */
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

/* SERVER */
app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("StackNetwork AI is running!");
  console.log("Developer: Muhammad Ashmil");
  console.log("Model: " + MODEL);
  console.log("Port: " + PORT);
  console.log("--------------------------------");
});
