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
const { rateLimit } = require("express-rate-limit");

const app = express();

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.VISION_MODEL || MODEL;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing.");
}

if (!process.env.GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY is not configured.");
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: DATA_DIR,
    concurrentDB: true
  }),
  name: "stacknetwork.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const db = new sqlite3.Database(
  path.join(DATA_DIR, "stacknetwork.sqlite")
);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) return reject(error);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      resolve(rows);
    });
  });
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      error: "Please log in or continue as Guest."
    });
  }
  next();
}

function requireRegisteredUser(req, res, next) {
  if (!req.session.user || req.session.user.guest) {
    return res.status(403).json({
      success: false,
      error: "Register or log in to use saved chat history."
    });
  }
  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const imageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 4
  },
  fileFilter(req, file, callback) {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Unsupported file type."));
    }

    callback(null, true);
  }
});

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS chats_user_id
    ON chats(user_id)
  `);
}

// ---------------------------------------------
// AUTHENTICATION
// ---------------------------------------------

app.post("/api/register", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
    return res.status(400).json({
      error: "Username must be 3–24 characters and use letters, numbers, dots, underscores or dashes."
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Password must be between 8 and 128 characters."
    });
  }

  const existing = await get(
    "SELECT id FROM users WHERE email = ?",
    [email]
  );

  if (existing) {
    return res.status(409).json({
      error: "An account with this email already exists."
    });
  }

  const hash = await bcrypt.hash(password, 12);

  const result = await run(
    "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
    [username, email, hash]
  );

  const user = {
    id: result.id,
    username,
    email,
    guest: false
  };

  await regenerateSession(req);
  req.session.user = user;
  await saveSession(req);

  res.json({ success: true, user });
}));

app.post("/api/login", authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const account = await get(
    "SELECT * FROM users WHERE email = ?",
    [email]
  );

  if (!account || !(await bcrypt.compare(password, account.password))) {
    return res.status(401).json({
      error: "Incorrect email or password."
    });
  }

  const user = {
    id: account.id,
    username: account.username,
    email: account.email,
    guest: false
  };

  await regenerateSession(req);
  req.session.user = user;
  await saveSession(req);

  res.json({ success: true, user });
}));

// IMPORTANT: This is the correct guest endpoint.
app.post("/api/guest", authLimiter, asyncRoute(async (req, res) => {
  await regenerateSession(req);

  req.session.user = {
    id: null,
    username: "Guest",
    email: null,
    guest: true
  };

  await saveSession(req);

  res.json({
    success: true,
    user: req.session.user
  });
}));

app.get("/api/me", (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

app.post("/api/logout", asyncRoute(async (req, res) => {
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
}));

// ---------------------------------------------
// HEALTH AND CONFIG
// ---------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "StackNetwork",
    status: "online"
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    success: true,
    imageGeneration: Boolean(process.env.POLLINATIONS_API_KEY)
  });
});

// ---------------------------------------------
// WEB SEARCH
// ---------------------------------------------

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) return [];

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
      search_depth: "basic"
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) return [];

  const data = await response.json();

  return (data.results || []).map(item => ({
    title: item.title,
    url: item.url,
    content: item.content
  }));
}

// ---------------------------------------------
// CHAT HISTORY
// ---------------------------------------------

app.get("/api/chats", requireRegisteredUser, asyncRoute(async (req, res) => {
  const chats = await all(
    `SELECT id, title, updated_at
     FROM chats
     WHERE user_id = ?
     ORDER BY updated_at DESC
     LIMIT 100`,
    [req.session.user.id]
  );

  res.json({ chats });
}));

app.get("/api/chats/:id", requireRegisteredUser, asyncRoute(async (req, res) => {
  const chat = await get(
    "SELECT * FROM chats WHERE id = ? AND user_id = ?",
    [req.params.id, req.session.user.id]
  );

  if (!chat) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  let messages = [];

  try {
    messages = JSON.parse(chat.messages);
  } catch {}

  res.json({
    chat: {
      ...chat,
      messages
    }
  });
}));

app.put("/api/chats/:id", requireRegisteredUser, asyncRoute(async (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 100);

  if (!title) {
    return res.status(400).json({ error: "Enter a conversation title." });
  }

  const result = await run(
    "UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
    [title, req.params.id, req.session.user.id]
  );

  if (!result.changes) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  res.json({ success: true });
}));

app.delete("/api/chats/:id", requireRegisteredUser, asyncRoute(async (req, res) => {
  await run(
    "DELETE FROM chats WHERE id = ? AND user_id = ?",
    [req.params.id, req.session.user.id]
  );

  res.json({ success: true });
}));

// ---------------------------------------------
// IMAGE GENERATION
// ---------------------------------------------

app.post("/api/images/generate", requireAuth, imageLimiter, asyncRoute(async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();

  if (!prompt || prompt.length > 1000) {
    return res.status(400).json({
      error: "Enter an image prompt of up to 1000 characters."
    });
  }

  if (!process.env.POLLINATIONS_API_KEY) {
    return res.status(503).json({
      error: "Image generation is not configured. Add POLLINATIONS_API_KEY in Render."
    });
  }

  const model = process.env.POLLINATIONS_IMAGE_MODEL || "flux";

  const url = new URL(
    "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt)
  );

  url.searchParams.set("model", model);
  url.searchParams.set("width", "1024");
  url.searchParams.set("height", "1024");
  url.searchParams.set("nologo", "true");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}`
    },
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    return res.status(502).json({
      error: "The image provider could not generate your image."
    });
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    return res.status(502).json({
      error: "The image provider returned an invalid response."
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > 15 * 1024 * 1024) {
    return res.status(502).json({
      error: "Generated image is too large."
    });
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}));

// ---------------------------------------------
// MAIN GROQ CHAT
// ---------------------------------------------

app.post(
  "/api/chat",
  chatLimiter,
  requireAuth,
  upload.array("files", 4),
  asyncRoute(async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({
        error: "Groq API key is not configured."
      });
    }

    let messages;

    try {
      messages = JSON.parse(req.body.messages || "[]");
    } catch {
      return res.status(400).json({ error: "Invalid messages data." });
    }

    if (!Array.isArray(messages) || !messages.length || messages.length > 30) {
      return res.status(400).json({ error: "Invalid conversation." });
    }

    const last = messages[messages.length - 1];

    if (!last || last.role !== "user") {
      return res.status(400).json({
        error: "Your latest message must be a user message."
      });
    }

    const mode = req.body.mode === "thinking" ? "thinking" : "fast";
    const style = String(req.body.style || "balanced").slice(0, 30);
    const persona = String(req.body.persona || "helpful").slice(0, 30);
    const instructions = String(req.body.instructions || "").slice(0, 2000);
    const answerLength = String(req.body.answerLength || "medium");

    let webResults = [];

    if (req.body.webSearch === "true") {
      webResults = await searchWeb(
        String(last.content || "").slice(0, 1000)
      );
    }

    let attachmentText = "";
    const imageParts = [];

    for (const file of req.files || []) {
      if (file.mimetype === "application/pdf") {
        const parsed = await pdfParse(file.buffer);
        attachmentText +=
          `\n\nPDF: ${file.originalname}\n${parsed.text.slice(0, 25000)}`;
      } else if (file.mimetype.startsWith("image/")) {
        if (file.size > 5 * 1024 * 1024) {
          return res.status(400).json({
            error: "Images must be 5 MB or smaller."
          });
        }

        imageParts.push({
          type: "image_url",
          image_url: {
            url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
          }
        });
      }
    }

    const systemPrompt = `
You are StackNetwork, an AI assistant created for the StackNetwork project.
Your name is StackNetwork. Never claim that your name is ChatGPT.
Be helpful, accurate, friendly and clear.

Style: ${style}
Persona: ${persona}
Answer length: ${answerLength}
Mode: ${mode}

${instructions ? `Additional user instructions:\n${instructions}` : ""}

If you do not know something, say so honestly.
Do not invent facts, sources, or capabilities.
`;

    const conversation = messages.slice(-30).map(message => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").slice(0, 20000)
    }));

    if (attachmentText) {
      const latest = conversation[conversation.length - 1];

      latest.content +=
        "\n\nAttached document text:\n" + attachmentText.slice(0, 30000);
    }

    if (imageParts.length) {
      const latest = conversation[conversation.length - 1];
      latest.content = [
        { type: "text", text: String(latest.content || "") },
        ...imageParts
      ];
    }

    if (webResults.length) {
      const context = webResults.map((item, index) =>
        `${index + 1}. ${item.title}\n${item.url}\n${item.content}`
      ).join("\n\n");

      conversation[conversation.length - 1].content =
        typeof conversation[conversation.length - 1].content === "string"
          ? conversation[conversation.length - 1].content +
            "\n\nWeb search results:\n" + context
          : [
              ...conversation[conversation.length - 1].content,
              { type: "text", text: "\n\nWeb search results:\n" + context }
            ];
    }

    const selectedModel = imageParts.length ? VISION_MODEL : MODEL;

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...conversation
          ],
          temperature: 0.7,
          max_tokens: mode === "thinking" ? 5000 : 3000
        }),
        signal: AbortSignal.timeout(90000)
      }
    );

    const result = await groqResponse.json().catch(() => ({}));

    if (!groqResponse.ok) {
      console.error("Groq API error:", result);

      return res.status(502).json({
        error: result.error?.message || "Groq could not complete the request."
      });
    }

    const reply = result.choices?.[0]?.message?.content;

    if (!reply) {
      return res.status(502).json({
        error: "The AI returned an empty response."
      });
    }

    let chatId = null;

    if (!req.session.user.guest) {
      chatId = String(req.body.chatId || "").trim() || crypto.randomUUID();

      const title = String(
        messages.find(message => message.role === "user")?.content ||
        "New conversation"
      ).slice(0, 100);

      const savedMessages = [
        ...messages.slice(-30),
        { role: "assistant", content: reply }
      ];

      const existing = await get(
        "SELECT id FROM chats WHERE id = ? AND user_id = ?",
        [chatId, req.session.user.id]
      );

      if (existing) {
        await run(
          `UPDATE chats
           SET title = ?, messages = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`,
          [
            title,
            JSON.stringify(savedMessages),
            chatId,
            req.session.user.id
          ]
        );
      } else {
        chatId = crypto.randomUUID();

        await run(
          `INSERT INTO chats (id, user_id, title, messages)
           VALUES (?, ?, ?, ?)`,
          [
            chatId,
            req.session.user.id,
            title,
            JSON.stringify(savedMessages)
          ]
        );
      }
    }

    res.json({
      success: true,
      reply,
      chatId,
      webResults
    });
  })
);

// ---------------------------------------------
// STATIC WEBSITE
// ---------------------------------------------

app.use(express.static(PUBLIC_DIR, {
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "API endpoint not found."
  });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "File must be 8 MB or smaller."
        : error.message
    });
  }

  res.status(error.status || 500).json({
    success: false,
    error: error.message || "Internal server error."
  });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`StackNetwork is running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
