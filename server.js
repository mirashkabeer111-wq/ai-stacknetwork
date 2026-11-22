
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY is missing from your environment.");
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

const dataDirectory = path.join(__dirname, "data");

if (!fs.existsSync(dataDirectory)) {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

const db = new sqlite3.Database(
  path.join(dataDirectory, "stacknetwork.sqlite")
);

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chats_user
    ON chats(user_id, updated_at)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat
    ON messages(chat_id, id)
  `);
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      resolve(rows);
    });
  });
}

// --------------------------------------------------
// SESSION
// --------------------------------------------------

app.use(
  session({
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: dataDirectory,
      table: "sessions"
    }),
    secret: process.env.SESSION_SECRET || "replace-this-with-a-long-random-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function cleanText(value, maxLength = 12000) {
  return String(value || "").trim().slice(0, maxLength);
}

function createId() {
  return crypto.randomUUID();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    guest: !!user.guest
  };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({
      error: "Please log in or continue as a guest."
    });
  }

  next();
}

function requireRegisteredUser(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "Please log in." });
  }

  if (req.session.user.guest) {
    return res.status(403).json({
      error: "Create an account to use this feature."
    });
  }

  next();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --------------------------------------------------
// FILE UPLOADS
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 4
  },
  fileFilter(req, file, callback) {
    const allowed = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(
        new Error("Only PNG, JPG, WEBP and PDF files are supported.")
      );
    }

    callback(null, true);
  }
});

// --------------------------------------------------
// AUTH: CURRENT USER
// --------------------------------------------------

app.get("/api/me", (req, res) => {
  if (!req.session?.user) {
    return res.json({ user: null });
  }

  res.json({
    user: publicUser(req.session.user)
  });
});

// --------------------------------------------------
// AUTH: REGISTER
// --------------------------------------------------

app.post("/api/register", async (req, res) => {
  try {
    const username = cleanText(req.body.username, 24);
    const email = cleanText(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || "");

    if (username.length < 3) {
      return res.status(400).json({
        error: "Username must contain at least 3 characters."
      });
    }

    if (!validEmail(email)) {
      return res.status(400).json({
        error: "Please enter a valid email address."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters."
      });
    }

    const existing = await dbGet(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    const id = createId();
    const hashedPassword = await bcrypt.hash(password, 12);

    await dbRun(
      `INSERT INTO users (id, username, email, password, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, username, email, hashedPassword, Date.now()]
    );

    const user = {
      id,
      username,
      email,
      guest: false
    };

    req.session.user = user;

    req.session.save(error => {
      if (error) {
        console.error("Session save error:", error);
        return res.status(500).json({
          error: "Account created, but session could not be saved."
        });
      }

      res.json({
        success: true,
        user: publicUser(user)
      });
    });
  } catch (error) {
    console.error("Register error:", error);

    res.status(500).json({
      error: "Could not create your account."
    });
  }
});

// --------------------------------------------------
// AUTH: LOGIN
// --------------------------------------------------

app.post("/api/login", async (req, res) => {
  try {
    const email = cleanText(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || "");

    const user = await dbGet(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (!user) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatches) {
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

    req.session.save(error => {
      if (error) {
        console.error("Login session error:", error);

        return res.status(500).json({
          error: "Could not save login session."
        });
      }

      res.json({
        success: true,
        user: publicUser(req.session.user)
      });
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      error: "Login failed."
    });
  }
});

// --------------------------------------------------
// AUTH: GUEST
// --------------------------------------------------

app.post("/api/guest", (req, res) => {
  const guest = {
    id: "guest_" + createId(),
    username: "Guest",
    email: null,
    guest: true
  };

  req.session.user = guest;

  req.session.save(error => {
    if (error) {
      console.error("Guest session error:", error);

      return res.status(500).json({
        error: "Could not start guest session."
      });
    }

    res.json({
      success: true,
      user: publicUser(guest)
    });
  });
});

// --------------------------------------------------
// AUTH: LOGOUT
// --------------------------------------------------

app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      console.error("Logout error:", error);

      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("connect.sid");

    res.json({ success: true });
  });
});

// --------------------------------------------------
// CHAT HISTORY
// --------------------------------------------------

app.get("/api/chats", requireRegisteredUser, async (req, res) => {
  try {
    const chats = await dbAll(
      `SELECT id, title, created_at, updated_at
       FROM chats
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
      [req.session.user.id]
    );

    res.json({ chats });
  } catch (error) {
    console.error("Load chats error:", error);

    res.status(500).json({
      error: "Could not load chat history."
    });
  }
});

// --------------------------------------------------
// OPEN CHAT
// --------------------------------------------------

app.get("/api/chats/:id", requireRegisteredUser, async (req, res) => {
  try {
    const chat = await dbGet(
      `SELECT id, title, created_at, updated_at
       FROM chats
       WHERE id = ? AND user_id = ?`,
      [req.params.id, req.session.user.id]
    );

    if (!chat) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    const messages = await dbAll(
      `SELECT role, content, created_at
       FROM messages
       WHERE chat_id = ?
       ORDER BY id ASC`,
      [chat.id]
    );

    res.json({
      chat: {
        ...chat,
        messages
      }
    });
  } catch (error) {
    console.error("Open chat error:", error);

    res.status(500).json({
      error: "Could not open conversation."
    });
  }
});

// --------------------------------------------------
// RENAME CHAT
// --------------------------------------------------

app.put("/api/chats/:id", requireRegisteredUser, async (req, res) => {
  try {
    const title = cleanText(req.body.title, 70);

    if (!title) {
      return res.status(400).json({
        error: "Please enter a conversation title."
      });
    }

    const result = await dbRun(
      `UPDATE chats
       SET title = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [title, Date.now(), req.params.id, req.session.user.id]
    );

    if (!result.changes) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    res.json({ success: true, title });
  } catch (error) {
    console.error("Rename chat error:", error);

    res.status(500).json({
      error: "Could not rename conversation."
    });
  }
});

// --------------------------------------------------
// DELETE CHAT
// --------------------------------------------------

app.delete("/api/chats/:id", requireRegisteredUser, async (req, res) => {
  try {
    const chat = await dbGet(
      "SELECT id FROM chats WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.user.id]
    );

    if (!chat) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    await dbRun("DELETE FROM messages WHERE chat_id = ?", [chat.id]);

    await dbRun(
      "DELETE FROM chats WHERE id = ? AND user_id = ?",
      [chat.id, req.session.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Delete chat error:", error);

    res.status(500).json({
      error: "Could not delete conversation."
    });
  }
});

// --------------------------------------------------
// PDF TEXT EXTRACTION
// Requires pdf-parse 1.1.1
// --------------------------------------------------

async function extractPdfText(buffer) {
  try {
    const pdfParse = require("pdf-parse");
    const result = await pdfParse(buffer);

    return cleanText(result.text, 15000);
  } catch (error) {
    console.error("PDF extraction error:", error);
    return "[The PDF could not be read. Please describe the document or try another PDF.]";
  }
}

// --------------------------------------------------
// OPTIONAL WEB SEARCH (TAVILY)
// --------------------------------------------------

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) {
    return [];
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false
      })
    });

    if (!response.ok) {
      console.error("Tavily error:", await response.text());
      return [];
    }

    const data = await response.json();

    return (data.results || []).map(result => ({
      title: cleanText(result.title, 200),
      url: result.url,
      content: cleanText(result.content, 1200)
    }));
  } catch (error) {
    console.error("Web search error:", error);
    return [];
  }
}

// --------------------------------------------------
// GROQ AI
// --------------------------------------------------

async function askGroq(messages, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("Groq API key is missing. Add GROQ_API_KEY to your environment variables.");
  }

  const model =
    options.model ||
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile";

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
        temperature: 0.7,
        max_tokens: 4096
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Groq API error:", data);

    throw new Error(
      data.error?.message || "Groq could not generate a response."
    );
  }

  const answer = data.choices?.[0]?.message?.content;

  if (!answer) {
    throw new Error("Groq returned an empty response.");
  }

  return answer;
}

// --------------------------------------------------
// CHAT API
// --------------------------------------------------

app.post(
  "/api/chat",
  requireAuth,
  upload.array("files", 4),
  async (req, res) => {
    try {
      const userId = req.session.user.id;

      let incomingMessages = [];

      try {
        incomingMessages = JSON.parse(req.body.messages || "[]");
      } catch {
        return res.status(400).json({
          error: "Invalid chat message format."
        });
      }

      if (!Array.isArray(incomingMessages)) {
        return res.status(400).json({
          error: "Invalid messages."
        });
      }

      incomingMessages = incomingMessages
        .filter(message =>
          message &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.content === "string"
        )
        .slice(-30)
        .map(message => ({
          role: message.role,
          content: cleanText(message.content, 12000)
        }));

      const files = req.files || [];

      if (!incomingMessages.length && !files.length) {
        return res.status(400).json({
          error: "Please enter a message or attach a file."
        });
      }

      const lastUserIndex = incomingMessages
        .map(message => message.role)
        .lastIndexOf("user");

      if (lastUserIndex === -1 && !files.length) {
        return res.status(400).json({
          error: "Please enter a message."
        });
      }

      let chatId = cleanText(req.body.chatId, 100);
      const now = Date.now();

      let chat = null;

      if (chatId) {
        chat = await dbGet(
          "SELECT id FROM chats WHERE id = ? AND user_id = ?",
          [chatId, userId]
        );
      }

      if (!chat) {
        chatId = createId();

        const title =
          cleanText(req.body.title, 70) ||
          incomingMessages.find(m => m.role === "user")?.content.slice(0, 70) ||
          "New chat";

        await dbRun(
          `INSERT INTO chats (id, user_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [chatId, userId, title, now, now]
        );
      } else {
        await dbRun(
          "UPDATE chats SET updated_at = ? WHERE id = ? AND user_id = ?",
          [now, chatId, userId]
        );
      }

      // Build a safe conversation for the AI.
      const aiMessages = [
        {
          role: "system",
          content:
            "You are StackNetwork, a helpful AI assistant. " +
            "Never claim to be ChatGPT or another AI brand. " +
            "Answer clearly, accurately, and helpfully. " +
            "When writing code, provide complete and usable examples when appropriate."
        },
        ...incomingMessages
      ];

      // Add uploaded file contents to the latest user message.
      let fileText = "";
      const imageParts = [];

      for (const file of files) {
        if (file.mimetype === "application/pdf") {
          const extracted = await extractPdfText(file.buffer);

          fileText +=
            `\n\nPDF FILE: ${file.originalname}\n${extracted}\n`;
        }

        if (file.mimetype.startsWith("image/")) {
          const visionModel = process.env.GROQ_VISION_MODEL;

          if (!visionModel) {
            fileText +=
              `\n\nImage attached: ${file.originalname}. ` +
              "Image understanding is not configured on this server. " +
              "Set GROQ_VISION_MODEL to a currently supported Groq vision model to analyze images.\n";
          } else {
            imageParts.push({
              type: "image_url",
              image_url: {
                url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
              }
            });
          }
        }
      }

      if (fileText || imageParts.length) {
        let userMessage = aiMessages
          .slice()
          .reverse()
          .find(message => message.role === "user");

        if (!userMessage) {
          userMessage = {
            role: "user",
            content: "Please analyze my attached files."
          };
          aiMessages.push(userMessage);
        }

        const originalText =
          typeof userMessage.content === "string"
            ? userMessage.content
            : "";

        if (imageParts.length) {
          userMessage.content = [
            {
              type: "text",
              text: originalText + fileText +
                "\nPlease analyze the attached image(s) and answer the user's request."
            },
            ...imageParts
          ];
        } else {
          userMessage.content =
            originalText + fileText;
        }
      }

      // Optional web search.
      let webResults = [];

      if (String(req.body.webSearch) === "true") {
        const query =
          incomingMessages
            .slice()
            .reverse()
            .find(message => message.role === "user")
            ?.content || "";

        if (query) {
          webResults = await searchWeb(query);

          if (webResults.length) {
            const webContext = webResults
              .map((result, index) =>
                `${index + 1}. ${result.title}\n${result.content}\nURL: ${result.url}`
              )
              .join("\n\n");

            aiMessages.splice(1, 0, {
              role: "system",
              content:
                "Use the following web search results when relevant. " +
                "Do not invent facts. Cite sources using their URLs.\n\n" +
                webContext
            });
          }
        }
      }

      // Thinking mode uses a configurable model.
      const mode = cleanText(req.body.mode, 30);

      const selectedModel =
        mode === "thinking" && process.env.GROQ_THINKING_MODEL
          ? process.env.GROQ_THINKING_MODEL
          : undefined;

      const reply = await askGroq(aiMessages, {
        model: selectedModel
      });

      // Save the conversation for registered and guest sessions.
      await dbRun(
        "DELETE FROM messages WHERE chat_id = ?",
        [chatId]
      );

      for (const message of incomingMessages) {
        await dbRun(
          `INSERT INTO messages (chat_id, role, content, created_at)
           VALUES (?, ?, ?, ?)`,
          [chatId, message.role, message.content, Date.now()]
        );
      }

      await dbRun(
        `INSERT INTO messages (chat_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`,
        [chatId, "assistant", reply, Date.now()]
      );

      res.json({
        success: true,
        chatId,
        reply,
        webResults
      });
    } catch (error) {
      console.error("Chat API error:", error);

      if (error instanceof multer.MulterError) {
        return res.status(400).json({
          error: error.code === "LIMIT_FILE_SIZE"
            ? "A file is too large. Maximum size is 8 MB."
            : "File upload limit exceeded."
        });
      }

      res.status(500).json({
        error: error.message || "Something went wrong while generating your response."
      });
    }
  }
);

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) return next(error);

  res.status(400).json({
    error: error.message || "Request failed."
  });
});

// --------------------------------------------------
// STATIC WEBSITE
// --------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log("       StackNetwork AI Server       ");
  console.log("====================================");
  console.log(`Server running on port ${PORT}`);
  console.log("Database: SQLite");
  console.log("AI provider: Groq");
  console.log("====================================");
});
