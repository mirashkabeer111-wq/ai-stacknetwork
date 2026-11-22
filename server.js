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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

const db = new sqlite3.Database(
  path.join(DATA_DIR, "stacknetwork.db")
);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) return reject(error);
      resolve({
        id: this.lastID,
        changes: this.changes
      });
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

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      password TEXT,
      guest INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT DEFAULT 'New chat',
      messages TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      settings TEXT DEFAULT '{}',
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
}

const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(session({
  store: new SQLiteStore({
    db: "sessions.db",
    dir: DATA_DIR
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5
  }
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in or continue as Guest."
    });
  }

  next();
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    guest: Boolean(user.guest)
  };
}

function makeId() {
  return crypto.randomBytes(16).toString("hex");
}

function cleanText(value, max = 12000) {
  return String(value || "").trim().slice(0, max);
}

async function getUserSettings(userId) {
  const row = await get(
    "SELECT settings FROM user_settings WHERE user_id = ?",
    [userId]
  );

  try {
    return JSON.parse(row?.settings || "{}");
  } catch {
    return {};
  }
}

async function saveUserSettings(userId, settings) {
  await run(
    `INSERT INTO user_settings (user_id, settings)
     VALUES (?, ?)
     ON CONFLICT(user_id)
     DO UPDATE SET settings = excluded.settings`,
    [userId, JSON.stringify(settings)]
  );
}

async function getChat(chatId, userId) {
  return get(
    "SELECT * FROM chats WHERE id = ? AND user_id = ?",
    [chatId, userId]
  );
}

/* -------------------- AUTH -------------------- */

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const name = cleanText(req.body.name, 50);
    const email = cleanText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || password.length < 6) {
      return res.status(400).json({
        error: "Enter a name, valid email and password with at least 6 characters."
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
      "INSERT INTO users (name, email, password, guest) VALUES (?, ?, ?, 0)",
      [name, email, hash]
    );

    const user = await get(
      "SELECT * FROM users WHERE id = ?",
      [result.id]
    );

    req.session.user = safeUser(user);

    await saveUserSettings(user.id, {
      theme: "dark",
      sendOnEnter: true,
      responseStyle: "balanced",
      answerLength: "medium",
      customInstructions: ""
    });

    res.json({
      success: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const email = cleanText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    const user = await get(
      "SELECT * FROM users WHERE email = ? AND guest = 0",
      [email]
    );

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    req.session.user = safeUser(user);

    res.json({
      success: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/guest", async (req, res) => {
  try {
    const guestName = "Guest_" + crypto.randomBytes(3).toString("hex");

    const result = await run(
      "INSERT INTO users (name, email, password, guest) VALUES (?, NULL, NULL, 1)",
      [guestName]
    );

    const user = await get(
      "SELECT * FROM users WHERE id = ?",
      [result.id]
    );

    req.session.user = safeUser(user);

    await saveUserSettings(user.id, {
      theme: "dark",
      sendOnEnter: true,
      responseStyle: "balanced",
      answerLength: "medium",
      customInstructions: ""
    });

    res.json({
      success: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("Guest error:", error);
    res.status(500).json({ error: "Guest login failed." });
  }
});

app.get("/api/me", (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

/* -------------------- SETTINGS -------------------- */

app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    const settings = await getUserSettings(req.session.user.id);
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ error: "Could not load settings." });
  }
});

app.put("/api/settings", requireAuth, async (req, res) => {
  try {
    const incoming = req.body.settings || {};

    const allowed = {
      theme: ["dark", "light"],
      sendOnEnter: Boolean(incoming.sendOnEnter),
      responseStyle: cleanText(incoming.responseStyle, 30),
      answerLength: cleanText(incoming.answerLength, 20),
      customInstructions: cleanText(incoming.customInstructions, 3000)
    };

    if (!["dark", "light"].includes(allowed.theme)) {
      allowed.theme = "dark";
    }

    if (!["balanced", "friendly", "professional", "simple", "detailed", "creative"].includes(allowed.responseStyle)) {
      allowed.responseStyle = "balanced";
    }

    if (!["short", "medium", "long"].includes(allowed.answerLength)) {
      allowed.answerLength = "medium";
    }

    await saveUserSettings(req.session.user.id, allowed);

    res.json({
      success: true,
      settings: allowed
    });
  } catch (error) {
    console.error("Settings error:", error);
    res.status(500).json({ error: "Could not save settings." });
  }
});

/* -------------------- CHAT HISTORY -------------------- */

app.get("/api/chats", requireAuth, async (req, res) => {
  try {
    const chats = await all(
      `SELECT id, title, created_at, updated_at
       FROM chats
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
      [req.session.user.id]
    );

    res.json({ chats });
  } catch (error) {
    res.status(500).json({ error: "Could not load chats." });
  }
});

app.post("/api/chats", requireAuth, async (req, res) => {
  try {
    const id = makeId();
    const title = cleanText(req.body.title, 80) || "New chat";

    await run(
      "INSERT INTO chats (id, user_id, title, messages) VALUES (?, ?, ?, '[]')",
      [id, req.session.user.id, title]
    );

    res.json({
      success: true,
      chat: { id, title, messages: [] }
    });
  } catch (error) {
    res.status(500).json({ error: "Could not create chat." });
  }
});

app.get("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const chat = await getChat(
      req.params.id,
      req.session.user.id
    );

    if (!chat) {
      return res.status(404).json({ error: "Chat not found." });
    }

    let messages = [];

    try {
      messages = JSON.parse(chat.messages || "[]");
    } catch {}

    res.json({
      chat: {
        id: chat.id,
        title: chat.title,
        messages
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Could not open chat." });
  }
});

app.delete("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    await run(
      "DELETE FROM chats WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Could not delete chat." });
  }
});

app.delete("/api/chats", requireAuth, async (req, res) => {
  try {
    await run(
      "DELETE FROM chats WHERE user_id = ?",
      [req.session.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Could not clear history." });
  }
});

/* -------------------- GROQ AI -------------------- */

function getGroqModel(mode) {
  if (mode === "thinking") {
    return process.env.GROQ_THINKING_MODEL ||
      process.env.GROQ_MODEL ||
      "llama-3.3-70b-versatile";
  }

  return process.env.GROQ_FAST_MODEL ||
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile";
}

function buildSystemPrompt(settings, length) {
  const styles = {
    balanced: "Be helpful, clear and balanced.",
    friendly: "Be friendly, warm and conversational.",
    professional: "Use a professional and polished tone.",
    simple: "Explain things in simple language suitable for beginners.",
    detailed: "Give detailed explanations and useful examples.",
    creative: "Be imaginative and creative while staying accurate."
  };

  const lengths = {
    short: "Keep answers short and direct.",
    medium: "Give a moderate amount of useful detail.",
    long: "Give thorough and detailed answers."
  };

  return `
You are StackNetwork, an AI assistant created for the StackNetwork project.

Identity:
- Your name is StackNetwork.
- Never introduce yourself as ChatGPT.
- Do not claim to be another AI brand.
- Be honest about your capabilities.
- Do not claim that an action was completed unless it actually was.

Response style:
${styles[settings.responseStyle] || styles.balanced}

Answer length:
${lengths[length] || lengths.medium}

Personal instructions:
${settings.customInstructions || "None"}

Be accurate, useful and easy to understand.
`;
}

async function callGroq(messages, model, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is missing from the server environment.");
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Groq error:", data);
    throw new Error(
      data.error?.message || `Groq request failed (${response.status}).`
    );
  }

  return data.choices?.[0]?.message?.content || "";
}

async function extractUploadedFiles(files) {
  const output = [];

  for (const file of files || []) {
    const mime = file.mimetype || "";

    if (mime === "application/pdf") {
      try {
        const parsed = await pdfParse(file.buffer);
        output.push({
          type: "text",
          name: file.originalname,
          content: parsed.text.slice(0, 20000)
        });
      } catch {
        output.push({
          type: "text",
          name: file.originalname,
          content: "[Could not read this PDF.]"
        });
      }
    } else if (mime.startsWith("text/") ||
               mime === "application/json") {
      output.push({
        type: "text",
        name: file.originalname,
        content: file.buffer.toString("utf8").slice(0, 20000)
      });
    } else if (mime.startsWith("image/")) {
      output.push({
        type: "image",
        name: file.originalname,
        mime,
        base64: file.buffer.toString("base64")
      });
    } else {
      output.push({
        type: "text",
        name: file.originalname,
        content: "[This file type is not supported for text extraction.]"
      });
    }
  }

  return output;
}

async function searchWeb(query) {
  const key = process.env.TAVILY_API_KEY;

  if (!key) return "";

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: true
      })
    });

    if (!response.ok) {
      throw new Error("Web search request failed.");
    }

    const data = await response.json();

    return [
      data.answer || "",
      ...(data.results || []).map(item =>
        `${item.title}\n${item.content}\n${item.url}`
      )
    ].filter(Boolean).join("\n\n");
  } catch (error) {
    console.error("Search error:", error.message);
    return "";
  }
}

app.post(
  "/api/chat",
  requireAuth,
  chatLimiter,
  upload.array("files", 5),
  async (req, res) => {
    try {
      const userId = req.session.user.id;
      const message = cleanText(req.body.message, 12000);
      const mode = req.body.mode === "thinking" ? "thinking" : "fast";
      const length = ["short", "medium", "long"].includes(req.body.length)
        ? req.body.length
        : "medium";

      if (!message && (!req.files || !req.files.length)) {
        return res.status(400).json({
          error: "Please enter a message or attach a file."
        });
      }

      let chatId = cleanText(req.body.chatId, 100);
      let chat = chatId ? await getChat(chatId, userId) : null;

      if (!chat) {
        chatId = makeId();

        const title = message.slice(0, 55) || "New chat";

        await run(
          "INSERT INTO chats (id, user_id, title, messages) VALUES (?, ?, ?, '[]')",
          [chatId, userId, title]
        );

        chat = await getChat(chatId, userId);
      }

      let history = [];

      try {
        history = JSON.parse(chat.messages || "[]");
      } catch {}

      const settings = await getUserSettings(userId);
      const files = await extractUploadedFiles(req.files);

      let userContent = message;

      for (const file of files) {
        if (file.type === "text") {
          userContent += `\n\nFile: ${file.name}\n${file.content}`;
        }
      }

      if (req.body.webSearch === "true" && message) {
        const results = await searchWeb(message);

        if (results) {
          userContent += `\n\nWeb search results:\n${results}`;
        }
      }

      const imageFiles = files.filter(file => file.type === "image");

      const apiMessages = [
        {
          role: "system",
          content: buildSystemPrompt(settings, length)
        },
        ...history.slice(-20).map(item => ({
          role: item.role,
          content: item.content
        })),
        {
          role: "user",
          content: imageFiles.length
            ? [
                { type: "text", text: userContent || "Describe this image." },
                ...imageFiles.map(file => ({
                  type: "image_url",
                  image_url: {
                    url: `data:${file.mime};base64,${file.base64}`
                  }
                }))
              ]
            : userContent
        }
      ];

      const answer = await callGroq(
        apiMessages,
        getGroqModel(mode)
      );

      const updatedHistory = [
        ...history,
        {
          role: "user",
          content: message || "Uploaded file",
          timestamp: new Date().toISOString()
        },
        {
          role: "assistant",
          content: answer,
          timestamp: new Date().toISOString()
        }
      ];

      const title = history.length
        ? chat.title
        : (message.slice(0, 55) || "New chat");

      await run(
        `UPDATE chats
         SET messages = ?, title = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`,
        [
          JSON.stringify(updatedHistory),
          title,
          chatId,
          userId
        ]
      );

      res.json({
        success: true,
        chatId,
        title,
        answer,
        message: answer
      });
    } catch (error) {
      console.error("Chat error:", error);

      res.status(500).json({
        error: error.message || "Something went wrong while generating your response."
      });
    }
  }
);

/* -------------------- IMAGE GENERATION -------------------- */

app.post("/api/images/generate", requireAuth, async (req, res) => {
  try {
    const prompt = cleanText(req.body.prompt, 1500);

    if (!prompt) {
      return res.status(400).json({
        error: "Enter an image description."
      });
    }

    const apiKey = process.env.POLLINATIONS_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "Image generation is not configured. Add POLLINATIONS_API_KEY to your server environment."
      });
    }

    const model = process.env.POLLINATIONS_IMAGE_MODEL ||
      "black-forest-labs/flux.1-schnell";

    const url =
      "https://gen.pollinations.ai/image/" +
      encodeURIComponent(prompt) +
      "?model=" + encodeURIComponent(model) +
      "&width=1024&height=1024&nologo=true";

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Pollinations error:", errorText);

      return res.status(502).json({
        error: `Image provider returned an error (${response.status}).`
      });
    }

    const contentType = response.headers.get("content-type") ||
      "image/jpeg";

    if (!contentType.startsWith("image/")) {
      return res.status(502).json({
        error: "The image provider did not return an image."
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    res.json({
      success: true,
      image: `data:${contentType};base64,${buffer.toString("base64")}`,
      contentType
    });
  } catch (error) {
    console.error("Image generation error:", error);

    res.status(500).json({
      error: error.message || "Image generation failed."
    });
  }
});

/* -------------------- ACCOUNT DELETION -------------------- */

app.delete("/api/account", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    await run("DELETE FROM chats WHERE user_id = ?", [userId]);
    await run("DELETE FROM user_settings WHERE user_id = ?", [userId]);
    await run("DELETE FROM users WHERE id = ?", [userId]);

    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  } catch (error) {
    res.status(500).json({ error: "Could not delete account." });
  }
});

/* -------------------- HEALTH / CONFIG -------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "StackNetwork",
    version: "5.1.0"
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    appName: "StackNetwork",
    version: "5.1.0",
    imageGeneration: Boolean(process.env.POLLINATIONS_API_KEY),
    webSearch: Boolean(process.env.TAVILY_API_KEY)
  });
});

/* -------------------- SPA FALLBACK -------------------- */

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* -------------------- START SERVER -------------------- */

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`StackNetwork running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
