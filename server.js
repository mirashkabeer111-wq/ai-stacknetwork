
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Developer information
app.get("/api/config", (req, res) => {
  res.json({
    developer: "Muhammad Ashmil"
  });
});

// AI Chat API
app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages,
      instructions = "",
      answerLength = "medium",
      mode = "fast",
      persona = "helpful",
      style = "balanced"
    } = req.body || {};

    // Validate messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Please enter a message."
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing from Render."
      });
    }

    const chatMessages = messages.slice(-30).map(message => {
      if (
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string"
      ) {
        throw new Error("Invalid message format.");
      }

      return {
        role: message.role,
        content: message.content.slice(0, 20000)
      };
    });

    // AI Personas
    const personas = {
      helpful: "You are a helpful and friendly AI assistant.",
      teacher: "You are a patient teacher who explains clearly.",
      coder: "You are an expert programming assistant.",
      creative: "You are a creative assistant.",
      professional: "You are a professional AI assistant.",
      gamer: "You are a gaming expert, especially in Minecraft."
    };

    // Answer Length
    const lengths = {
      short: "Give short and direct answers.",
      medium: "Give balanced answers with useful details.",
      long: "Give detailed answers with examples."
    };

    // Response Style
    const styles = {
      balanced: "Use a balanced natural writing style.",
      friendly: "Use a friendly conversational tone.",
      professional: "Use a professional tone.",
      simple: "Use simple language.",
      detailed: "Explain topics in detail."
    };

    // System Prompt
    const systemPrompt = `
You are StackNetwork AI.

Developer: Muhammad Ashmil.

PERSONALITY:
- Friendly, helpful and intelligent.
- Answer naturally.
- Understand the user's intent.
- Avoid unnecessary refusals.

SAFETY:
- Allow harmless educational discussions.
- Allow fictional crime stories and roleplay.
- Allow ethical cybersecurity learning.
- Do not provide actionable instructions for real-world violence,
  theft, fraud, malware deployment or unauthorized cyberattacks.
- If a request crosses these boundaries, briefly refuse that part.

ANSWER SETTINGS:
${lengths[answerLength] || lengths.medium}
${styles[style] || styles.balanced}
${personas[persona] || personas.helpful}

THINKING MODE:
${mode === "thinking"
  ? "Think carefully before answering. Do not reveal private reasoning."
  : "Answer quickly and directly."}

CUSTOM INSTRUCTIONS:
${String(instructions).slice(0, 4000)}

Always provide a visible final answer.
`;

    // Groq API request
    const model = "openai/gpt-oss-120b";

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            ...chatMessages
          ],
          max_completion_tokens: 4096,
          reasoning_effort: "low",
          include_reasoning: false,
          stream: false
        })
      }
    );

    // Read Groq response
    const data = await response.json();

    // Handle API errors
    if (!response.ok) {
      console.error(
        "GROQ API ERROR:",
        JSON.stringify(data, null, 2)
      );

      return res.status(502).json({
        error: data.error?.message || "Groq API request failed."
      });
    }

    const choice = data.choices?.[0];
    const message = choice?.message;

    let reply = message?.content;

    // Handle text blocks
    if (Array.isArray(reply)) {
      reply = reply
        .filter(item => item.type === "text")
        .map(item => item.text || "")
        .join("\n");
    }

    // Handle empty response
    if (typeof reply !== "string" || !reply.trim()) {
      console.error(
        "EMPTY GROQ RESPONSE:",
        JSON.stringify({
          model: data.model,
          finish_reason: choice?.finish_reason,
          message,
          usage: data.usage
        }, null, 2)
      );

      return res.status(502).json({
        error:
          "Groq returned no visible text. Finish reason: " +
          (choice?.finish_reason || "unknown") +
          ". Check Render Logs."
      });
    }

    // Successful response
    return res.json({
      reply: reply.trim()
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return res.status(500).json({
      error: error.message || "Internal server error."
    });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("⚡ StackNetwork AI Started");
  console.log("Developer: Muhammad Ashmil");
  console.log("Model: openai/gpt-oss-120b");
  console.log(`Port: ${PORT}`);
  console.log("--------------------------------");
});
