
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const personas = {
  assistant: "You are a helpful general AI assistant.",
  coder: "You are an expert programmer. Provide correct, clear code.",
  gaming: "You are a gaming expert, especially in Minecraft.",
  teacher: "You are a patient teacher. Explain things step by step.",
  creative: "You are a creative assistant with original ideas.",
  professional: "You are a professional business assistant."
};

const styles = {
  friendly: "Use a friendly and natural tone.",
  professional: "Use a professional and polished tone.",
  simple: "Use simple words and easy explanations.",
  formal: "Use formal language.",
  funny: "Use appropriate light humor when useful."
};

const lengths = {
  short: "Keep the answer short and direct.",
  medium: "Give a balanced answer with useful details.",
  long: "Give a detailed answer with explanations and examples when useful."
};

app.get("/api/config", (req, res) => {
  res.json({
    developer: "Muhammad Ashmil"
  });
});

app.post("/api/chat", async (req, res) => {
  const {
    messages,
    instructions = "",
    answerLength = "medium",
    mode = "fast",
    persona = "assistant",
    style = "friendly"
  } = req.body || {};

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      error: "GROQ_API_KEY is missing from Render environment variables."
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: "Please send a message."
    });
  }

  const safeMessages = messages
    .filter(item =>
      item &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string"
    )
    .slice(-30);

  if (!safeMessages.length) {
    return res.status(400).json({
      error: "No valid messages were provided."
    });
  }

  const systemPrompt = `
You are StackNetwork AI, a helpful AI assistant.
You were developed by Muhammad Ashmil.
If someone asks who developed you, say Muhammad Ashmil.

${personas[persona] || personas.assistant}
${styles[style] || styles.friendly}
${lengths[answerLength] || lengths.medium}

${mode === "thinking"
  ? "Think carefully before answering. Give a clear conclusion and useful explanation. Do not reveal private chain-of-thought."
  : "Respond efficiently and directly."}

${instructions
  ? "Additional user instructions:\n" + String(instructions).slice(0, 5000)
  : ""}
`;

  const controller = new AbortController();
  let clientDisconnected = false;

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort();
    }
  });

  try {
    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          stream: true,
          temperature: 0.7,
          max_tokens:
            answerLength === "long" ? 4096 :
            answerLength === "short" ? 1024 : 2048,
          messages: [
            { role: "system", content: systemPrompt },
            ...safeMessages
          ]
        })
      }
    );

    if (!groqResponse.ok) {
      const errorData = await groqResponse.json().catch(() => ({}));

      if (!res.headersSent) {
        return res.status(groqResponse.status).json({
          error: errorData.error?.message || "Groq API request failed."
        });
      }
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const reader = groqResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done || clientDisconnected) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();

        if (payload === "[DONE]") {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        try {
          const chunk = JSON.parse(payload);
          const token = chunk.choices?.[0]?.delta?.content;

          if (typeof token === "string" && token.length) {
            res.write(
              "data: " + JSON.stringify({ token }) + "\n\n"
            );
          }
        } catch {
          // Ignore incomplete or invalid stream chunks.
        }
      }
    }

    if (!res.writableEnded && !clientDisconnected) {
      res.write("data: [DONE]\n\n");
      res.end();
    }

  } catch (error) {
    if (error.name === "AbortError") return;

    console.error("Chat error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "Something went wrong. Please try again."
      });
    } else if (!res.writableEnded) {
      res.write(
        "data: " + JSON.stringify({
          error: "The response was interrupted."
        }) + "\n\n"
      );
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`StackNetwork AI running on port ${PORT}`);
});
