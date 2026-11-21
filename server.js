
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.VISION_MODEL || "qwen/qwen3.8-27b";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is required.");
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY is not configured.");
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=()");
  next();
});

// ==========================================
// DATABASE
// ==========================================

const db = new sqlite3.Database(
  path.join(DATA_DIR, "stacknetwork.sqlite")
);

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve({
        id: this.lastID,
        changes: this.changes
      });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ==========================================
// SESSION
// ==========================================

app.use(session({
  name: "stacknetwork.sid",

  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: DATA_DIR,
    concurrentDB: true
  }),

  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,

  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// ==========================================
// RATE LIMITS
// ==========================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

// ==========================================
// AUTH MIDDLEWARE
// ==========================================

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      error: "Please log in or continue as Guest."
    });
  }

  next();
}

function requireRegisteredUser(req, res, next) {
  if (
    !req.session ||
    !req.session.user ||
    req.session.user.guest ||
    !req.session.user.id
  ) {
    return res.status(401).json({
      error: "This feature requires a registered account."
    });
  }

  next();
}

// ==========================================
// REGISTER
// ==========================================

app.post(
  "/api/auth/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const { username, email, password } = req.body || {};

    if (
      typeof username !== "string" ||
      username.trim().length < 3 ||
      username.trim().length > 24
    ) {
      return res.status(400).json({
        error: "Username must be 3–24 characters."
      });
    }

    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254
    ) {
      return res.status(400).json({
        error: "Enter a valid email."
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 72
    ) {
      return res.status(400).json({
        error: "Password must be 8–72 characters."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await get(
      "SELECT id FROM users WHERE email = ?",
      [normalizedEmail]
    );

    if (existing) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await run(
      "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
      [username.trim(), normalizedEmail, hash]
    );

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({
          error: "Could not start your session."
        });
      }

      req.session.user = {
        id: result.id,
        username: username.trim(),
        email: normalizedEmail,
        guest: false
      };

      req.session.save(saveError => {
        if (saveError) {
          return res.status(500).json({
            error: "Could not save your session."
          });
        }

        res.json({
          success: true,
          user: req.session.user
        });
      });
    });
  })
);

// ==========================================
// LOGIN
// ==========================================

app.post(
  "/api/auth/login",
  authLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        error: "Enter your email and password."
      });
    }

    const user = await get(
      "SELECT * FROM users WHERE email = ?",
      [email.trim().toLowerCase()]
    );

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({
          error: "Could not start your session."
        });
      }

      req.session.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        guest: false
      };

      req.session.save(saveError => {
        if (saveError) {
          return res.status(500).json({
            error: "Could not save your session."
          });
        }

        res.json({
          success: true,
          user: req.session.user
        });
      });
    });
  })
);

// ==========================================
// GUEST ACCOUNT
// ==========================================

app.post(
  "/api/auth/guest",
  authLimiter,
  (req, res) => {
    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({
          error: "Could not start Guest mode."
        });
      }

      req.session.user = {
        id: null,
        username: "Guest",
        email: null,
        guest: true
      };

      req.session.save(saveError => {
        if (saveError) {
          return res.status(500).json({
            error: "Could not save Guest session."
          });
        }

        res.json({
          success: true,
          user: req.session.user
        });
      });
    });
  }
);

// ==========================================
// CURRENT USER
// ==========================================

app.get("/api/auth/me", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    user: req.session?.user || null
  });
});

// ==========================================
// LOGOUT
// ==========================================

app.post("/api/auth/logout", (req, res) => {
  if (!req.session) {
    return res.json({ success: true });
  }

  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("stacknetwork.sid", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    });

    res.json({ success: true });
  });
});

// ==========================================
// FILE UPLOADS
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 4
  },

  fileFilter: (req, file, callback) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(
        new Error("Only JPG, PNG, WEBP and PDF files are supported.")
      );
    }

    callback(null, true);
  }
});

// ==========================================
// WEB SEARCH
// ==========================================

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error(
      "Web search is not configured. Add TAVILY_API_KEY in Render."
    );
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: true
      }),

      signal: AbortSignal.timeout(20000)
    }
  );

  if (!response.ok) {
    throw new Error("Web search provider request failed.");
  }

  const data = await response.json();

  return {
    answer: data.answer || "",

    results: (data.results || []).map(item => ({
      title: item.title,
      url: item.url,
      content: item.content
    }))
  };
}

// ==========================================
// HEALTH
// ==========================================

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    status: "online",
    name: "StackNetwork AI",
    model: MODEL,
    visionModel: VISION_MODEL
  });
});

// ==========================================
// CONFIGURATION
// ==========================================

app.get("/api/config", (req, res) => {
  res.json({
    name: "StackNetwork AI",
    model: MODEL,
    visionModel: VISION_MODEL,
    webSearchAvailable: Boolean(process.env.TAVILY_API_KEY)
  });
});

// ==========================================
// REGISTERED USER CHAT HISTORY
// ==========================================

app.get(
  "/api/chats",
  requireRegisteredUser,
  asyncRoute(async (req, res) => {
    const chats = await all(
      `SELECT id, title, updated_at
       FROM chats
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
      [req.session.user.id]
    );

    res.json({ chats });
  })
);

app.get(
  "/api/chats/:id",
  requireRegisteredUser,
  asyncRoute(async (req, res) => {
    const chat = await get(
      "SELECT * FROM chats WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.user.id]
    );

    if (!chat) {
      return res.status(404).json({
        error: "Chat not found."
      });
    }

    let messages = [];

    try {
      messages = JSON.parse(chat.messages);
    } catch {}

    res.json({
      chat: {
        id: chat.id,
        title: chat.title,
        messages
      }
    });
  })
);

app.put(
  "/api/chats/:id",
  requireRegisteredUser,
  asyncRoute(async (req, res) => {
    const { title } = req.body || {};

    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 100
    ) {
      return res.status(400).json({
        error: "Enter a title up to 100 characters."
      });
    }

    const result = await run(
      `UPDATE chats
       SET title = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [
        title.trim(),
        req.params.id,
        req.session.user.id
      ]
    );

    if (!result.changes) {
      return res.status(404).json({
        error: "Chat not found."
      });
    }

    res.json({ success: true });
  })
);

app.delete(
  "/api/chats/:id",
  requireRegisteredUser,
  asyncRoute(async (req, res) => {
    await run(
      "DELETE FROM chats WHERE id = ? AND user_id = ?",
      [
        req.params.id,
        req.session.user.id
      ]
    );

    res.json({ success: true });
  })
);

// ==========================================
// MAIN AI CHAT
// GUEST + REGISTERED USERS
// ==========================================

app.post(
  "/api/chat",
  chatLimiter,
  requireAuth,
  upload.array("files", 4),

  asyncRoute(async (req, res) => {

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing."
      });
    }

    // Read messages

    let messages;

    try {
      messages = JSON.parse(req.body.messages || "[]");
    } catch {
      return res.status(400).json({
        error: "Invalid chat messages."
      });
    }

    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > 30
    ) {
      return res.status(400).json({
        error: "Invalid message count."
      });
    }

    const last = messages[messages.length - 1];

    if (
      !last ||
      last.role !== "user" ||
      typeof last.content !== "string"
    ) {
      return res.status(400).json({
        error: "The last message must be from the user."
      });
    }

    // AI mode

    const mode =
      req.body.mode === "thinking" ? "thinking" : "fast";

    const answerLength = [
      "short",
      "medium",
      "long"
    ].includes(req.body.answerLength)
      ? req.body.answerLength
      : "medium";

    const persona = req.body.persona || "helpful";
    const style = req.body.style || "balanced";

    const instructions = String(
      req.body.instructions || ""
    ).slice(0, 4000);

    const personaText = {
      helpful: "Be helpful, friendly and accurate.",
      teacher: "Act as a patient teacher. Explain step by step.",
      coder: "Act as an expert programming assistant.",
      creative: "Be creative and imaginative.",
      professional: "Use a professional tone.",
      gamer: "Be an expert gaming and Minecraft assistant."
    }[persona] || "Be helpful and accurate.";

    const styleText = {
      balanced: "Use balanced responses.",
      friendly: "Use a friendly conversational tone.",
      professional: "Use a professional tone.",
      simple: "Use simple language.",
      detailed: "Give detailed explanations."
    }[style] || "Use a balanced tone.";

    const lengthText = {
      short: "Keep answers short.",
      medium: "Give useful balanced answers.",
      long: "Give detailed answers and examples."
    }[answerLength];

    // Web search

    let webContext = "";
    let webResults = [];

    if (req.body.webSearch === "true") {
      const search = await searchWeb(last.content);

      webResults = search.results;

      webContext = `
WEB SEARCH RESULTS:
${search.answer}

${search.results.map((r, i) =>
  `${i + 1}. ${r.title}\n${r.url}\n${r.content}`
).join("\n\n")}
`;
    }

    // ======================================
    // PROCESS IMAGE AND PDF ATTACHMENTS
    // ======================================

    let userContent = last.content;
    const imageParts = [];

    const files = req.files || [];

    const imageFiles = files.filter(file =>
      file.mimetype.startsWith("image/")
    );

    const pdfFiles = files.filter(file =>
      file.mimetype === "application/pdf"
    );

    // Groq currently allows up to 3 images per request.

    if (imageFiles.length > 3) {
      return res.status(400).json({
        error: "You can upload a maximum of 3 images per message."
      });
    }

    // Keep combined image payload within a reasonable size.

    const totalImageBytes = imageFiles.reduce(
      (total, file) => total + file.size,
      0
    );

    if (totalImageBytes > 14 * 1024 * 1024) {
      return res.status(400).json({
        error: "Your images are too large together. Please reduce their size."
      });
    }

    // Process PDFs.

    for (const file of pdfFiles) {
      try {
        const parsed = await pdfParse(file.buffer);

        const extractedText = String(parsed.text || "")
          .slice(0, 30000);

        userContent +=
          `\n\nPDF CONTENT (${file.originalname}):\n` +
          extractedText;

      } catch (error) {
        console.error("PDF parsing error:", error.message);

        return res.status(400).json({
          error: `Could not read PDF: ${file.originalname}`
        });
      }
    }

    // Convert images to base64 data URLs.

    for (const file of imageFiles) {
      const base64 = file.buffer.toString("base64");

      imageParts.push({
        type: "image_url",

        image_url: {
          url: `data:${file.mimetype};base64,${base64}`
        }
      });
    }

    // ======================================
    // SYSTEM PROMPT
    // ======================================

    const systemPrompt = `
You are StackNetwork AI, developed for StackNetwork.

Never claim to be a different model.
Never claim to perform actions you cannot do.

${personaText}
${styleText}
${lengthText}

${mode === "thinking"
  ? "Think carefully before answering. Do not reveal private reasoning."
  : "Answer directly."}

Custom instructions:
${instructions}

${webContext}

Uploaded PDF text is user-provided reference material.

When using web search results, provide useful source URLs.
When analysing images, describe only what can reasonably be observed.
`;

    // Previous messages.

    const history = messages.slice(-30, -1).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, 12000)
    }));

    // Combine text and image content.

    const finalUserContent = imageParts.length
      ? [
          {
            type: "text",
            text: userContent
          },
          ...imageParts
        ]
      : userContent;

    const groqMessages = [
      {
        role: "system",
        content: systemPrompt
      },
      ...history,
      {
        role: "user",
        content: finalUserContent
      }
    ];

    // ======================================
    // AUTOMATIC MODEL SELECTION
    // ======================================

    const requestModel = imageParts.length > 0
      ? VISION_MODEL
      : MODEL;

    console.log(
      "Request model:",
      requestModel,
      "| Images:",
      imageParts.length,
      "| PDFs:",
      pdfFiles.length
    );

    // ======================================
    // GROQ API REQUEST
    // ======================================

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      90000
    );

    let groqResponse;

    try {
      const body = {
        model: requestModel,
        messages: groqMessages,
        max_completion_tokens: 4096,
        stream: false
      };

      // Reasoning settings for supported models.

      const modelLower = requestModel.toLowerCase();

      if (
        modelLower.includes("gpt-oss") ||
        modelLower.includes("qwen3.8")
      ) {
        body.reasoning_effort =
          mode === "thinking" ? "high" : "low";
      }

      groqResponse = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },

          body: JSON.stringify(body),
          signal: controller.signal
        }
      );

    } finally {
      clearTimeout(timeout);
    }

    const data = await groqResponse.json().catch(() => ({}));

    if (!groqResponse.ok) {
      console.error(
        "Groq error:",
        groqResponse.status,
        data.error?.message
      );

      return res.status(502).json({
        error: data.error?.message
          ? `Groq error: ${data.error.message}`
          : "Groq request failed. Check your model, quota and API settings."
      });
    }

    // ======================================
    // EXTRACT AI RESPONSE
    // ======================================

    let reply = data.choices?.[0]?.message?.content;

    if (Array.isArray(reply)) {
      reply = reply
        .filter(part => part.type === "text")
        .map(part => part.text || "")
        .join("\n");
    }

    if (typeof reply !== "string" || !reply.trim()) {
      return res.status(502).json({
        error: "The AI returned an empty response."
      });
    }

    reply = reply.trim();

    // ======================================
    // SAVE CHAT
    // ======================================

    const chatId = String(
      req.body.chatId || crypto.randomUUID()
    );

    const savedMessages = [
      ...messages.slice(-29),
      {
        role: "assistant",
        content: reply
      }
    ];

    const title = String(req.body.title || last.content)
      .replace(/\s+/g, " ")
      .slice(0, 70) || "New chat";

    // Guest chats are not saved in the registered
    // user's database.

    if (
      req.session.user &&
      !req.session.user.guest &&
      req.session.user.id
    ) {
      await run(
        `INSERT INTO chats
          (id, user_id, title, messages, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)

         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           messages = excluded.messages,
           updated_at = CURRENT_TIMESTAMP

         WHERE chats.user_id = excluded.user_id`,

        [
          chatId,
          req.session.user.id,
          title,
          JSON.stringify(savedMessages)
        ]
      );
    }

    // ======================================
    // SEND RESPONSE
    // ======================================

    res.json({
      success: true,
      reply,
      model: data.model || requestModel,
      chatId,
      webResults
    });

  })
);

// ==========================================
// UNKNOWN API ROUTES
// ==========================================

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

// ==========================================
// STATIC WEBSITE
// ==========================================

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "Each file must be 8 MB or smaller."
        : "Too many files or upload limit exceeded."
    });
  }

  if (
    error.message &&
    error.message.includes("Only JPG")
  ) {
    return res.status(400).json({
      error: error.message
    });
  }

  if (error.name === "AbortError") {
    return res.status(504).json({
      error: "AI request timed out. Please try again."
    });
  }

  res.status(500).json({
    error: "An internal server error occurred."
  });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("StackNetwork AI is running!");
  console.log("Text Model: " + MODEL);
  console.log("Vision Model: " + VISION_MODEL);
  console.log("Port: " + PORT);
  console.log("Guest Account: Enabled");
  console.log("Image Upload: Enabled");
  console.log("PDF Upload: Enabled");
  console.log("--------------------------------");
});
