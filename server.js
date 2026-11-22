require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  "meta-llama/llama-4-scout-17b-16e-instruct";

if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY in .env");
  process.exit(1);
}

app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: "./"
    }),
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database("./stacknetwork.sqlite");

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

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("StackNetwork database ready.");
}

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
      error: "Please log in or continue as a guest."
    });
  }

  next();
}

function cleanText(value, maxLength = 12000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function safeFileText(file) {
  const allowed = [
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".js",
    ".html",
    ".css",
    ".xml",
    ".log"
  ];

  const ext = path.extname(file.originalname).toLowerCase();

  if (!allowed.includes(ext)) return "";

  return file.buffer.toString("utf8").slice(0, 20000);
}

function isImage(file) {
  return ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
}

function getSystemPrompt(mode) {
  const prompts = {
    balanced:
      "You are StackNetwork, a helpful, friendly and intelligent AI assistant. Give accurate and clear answers.",

    creative:
      "You are StackNetwork, a creative AI assistant. Give imaginative, original and engaging answers.",

    precise:
      "You are StackNetwork, a precise AI assistant. Give direct, factual and concise answers.",

    coding:
      "You are StackNetwork, an expert programming assistant. Provide correct code, explain important details, and use code blocks."
  };

  return prompts[mode] || prompts.balanced;
}

/* -------------------- AUTH -------------------- */

app.get("/api/me", (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

app.post("/api/guest", (req, res) => {
  req.session.user = {
    id: "guest_" + crypto.randomUUID(),
    username: "Guest",
    email: null,
    guest: true
  };

  res.json({
    success: true,
    user: req.session.user
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = cleanText(req.body.username, 30);
    const email = cleanText(req.body.email, 120).toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !email || password.length < 6) {
      return res.status(400).json({
        error: "Enter a username, valid email and password with at least 6 characters."
      });
    }

    const existing = await get(
      "SELECT id FROM users WHERE username = ? OR email = ?",
      [username, email]
    );

    if (existing) {
      return res.status(409).json({
        error: "Username or email is already registered."
      });
    }

    const id = crypto.randomUUID();
    const hashedPassword = await bcrypt.hash(password, 12);

    await run(
      "INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)",
      [id, username, email, hashedPassword]
    );

    req.session.user = {
      id,
      username,
      email,
      guest: false
    };

    res.json({
      success: true,
      user: req.session.user
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = cleanText(req.body.email, 120).toLowerCase();
    const password = String(req.body.password || "");

    const user = await get(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      guest: false
    };

    res.json({
      success: true,
      user: req.session.user
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

/* -------------------- CHAT HISTORY -------------------- */

app.get("/api/chats", requireAuth, async (req, res) => {
  try {
    if (req.session.user.guest) {
      return res.json({ chats: [] });
    }

    const chats = await all(
      `SELECT id, title, created_at, updated_at
       FROM chats
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
      [req.session.user.id]
    );

    res.json({ chats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load chat history." });
  }
});

app.get("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    if (req.session.user.guest) {
      return res.status(404).json({ error: "Chat not found." });
    }

    const chat = await get(
      "SELECT * FROM chats WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.user.id]
    );

    if (!chat) {
      return res.status(404).json({ error: "Chat not found." });
    }

    res.json({
      chat: {
        ...chat,
        messages: JSON.parse(chat.messages || "[]")
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not open chat." });
  }
});

app.delete("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    if (!req.session.user.guest) {
      await run(
        "DELETE FROM chats WHERE id = ? AND user_id = ?",
        [req.params.id, req.session.user.id]
      );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Could not delete chat." });
  }
});

/* -------------------- GROQ CHAT -------------------- */

app.post(
  "/api/chat",
  requireAuth,
  upload.array("files", 5),
  async (req, res) => {
    try {
      const message = cleanText(req.body.message, 12000);
      const files = req.files || [];

      if (!message && files.length === 0) {
        return res.status(400).json({
          error: "Please enter a message or attach a file."
        });
      }

      const user = req.session.user;
      const mode = cleanText(req.body.mode, 30) || "balanced";
      const requestedChatId = cleanText(req.body.chatId, 100);

      let chatId = requestedChatId || crypto.randomUUID();
      let previousMessages = [];

      if (!user.guest && requestedChatId) {
        const existingChat = await get(
          "SELECT * FROM chats WHERE id = ? AND user_id = ?",
          [requestedChatId, user.id]
        );

        if (existingChat) {
          previousMessages = JSON.parse(existingChat.messages || "[]");
        } else {
          chatId = crypto.randomUUID();
        }
      }

      let userContent = message || "Please analyze my attached file.";
      let imageParts = [];
      let fileText = "";

      for (const file of files) {
        if (isImage(file)) {
          imageParts.push({
            type: "image_url",
            image_url: {
              url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
            }
          });
        } else {
          const extracted = safeFileText(file);

          if (extracted) {
            fileText += `\n\n--- File: ${file.originalname} ---\n${extracted}`;
          } else {
            fileText += `\n\n[File "${file.originalname}" could not be read as supported text.]`;
          }
        }
      }

      if (fileText) {
        userContent += "\n\nAttached file contents:\n" + fileText;
      }

      const userMessage = imageParts.length
        ? {
            role: "user",
            content: [
              { type: "text", text: userContent },
              ...imageParts
            ]
          }
        : {
            role: "user",
            content: userContent
          };

      const conversation = [
        {
          role: "system",
          content: getSystemPrompt(mode)
        },
        ...previousMessages.slice(-20),
        userMessage
      ];

      const model = imageParts.length ? GROQ_VISION_MODEL : GROQ_MODEL;

      const groqResponse = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model,
            messages: conversation,
            temperature: mode === "creative" ? 0.9 : 0.6,
            max_tokens: 4096
          })
        }
      );

      const result = await groqResponse.json();

      if (!groqResponse.ok) {
        console.error("Groq error:", result);

        return res.status(groqResponse.status).json({
          error:
            result.error?.message ||
            "The AI provider could not complete your request."
        });
      }

      const reply = result.choices?.[0]?.message?.content;

      if (!reply) {
        return res.status(502).json({
          error: "The AI returned an empty response."
        });
      }

      const savedMessages = [
        ...previousMessages,
        {
          role: "user",
          content: userContent
        },
        {
          role: "assistant",
          content: reply
        }
      ].slice(-50);

      if (!user.guest) {
        const title = (message || files[0]?.originalname || "New chat")
          .slice(0, 70);

        const existing = await get(
          "SELECT id FROM chats WHERE id = ? AND user_id = ?",
          [chatId, user.id]
        );

        if (existing) {
          await run(
            `UPDATE chats
             SET messages = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ?`,
            [JSON.stringify(savedMessages), chatId, user.id]
          );
        } else {
          await run(
            `INSERT INTO chats (id, user_id, title, messages)
             VALUES (?, ?, ?, ?)`,
            [chatId, user.id, title, JSON.stringify(savedMessages)]
          );
        }
      }

      res.json({
        success: true,
        reply,
        answer: reply,
        chatId
      });
    } catch (error) {
      console.error("Chat error:", error);

      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: "Each file must be 10 MB or smaller."
        });
      }

      res.status(500).json({
        error: "Something went wrong while generating your response."
      });
    }
  }
);

/* -------------------- FALLBACK -------------------- */

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`StackNetwork running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
