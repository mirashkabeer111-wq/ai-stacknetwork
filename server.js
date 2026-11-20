
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({
    name: "StackNetwork AI",
    developer: "Muhammad Ashmil"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "online", model: MODEL });
});

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

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing in Render Environment."
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Please enter a message."
      });
    }

    const validMessages = messages.slice(-30).map(message => {
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

    const personas = {
      helpful: "You are a helpful and friendly AI assistant.",
      teacher: "You are a patient teacher. Explain things clearly.",
      coder: "You are an expert programming and coding assistant.",
      creative: "You are a creative writing assistant.",
      professional: "You are a professional AI assistant.",
      gamer: "You are a gaming expert, especially in Minecraft."
    };

    const lengths = {
      short: "Keep answers short and direct.",
      medium: "Give balanced answers with useful details.",
      long: "Give detailed answers with examples when useful."
    };

    const styles = {
      balanced: "Use a natural balanced writing style.",
      friendly: "Use a friendly conversational tone.",
      professional: "Use a professional tone.",
      simple: "Use simple language that is easy to understand.",
      detailed: "Explain topics thoroughly with useful details."
    };

    const systemPrompt = `
You are StackNetwork AI.

Your developer is Muhammad Ashmil.

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
${personas[persona] || personas.helpful}

ANSWER LENGTH:
${lengths[answerLength] || lengths.medium}

RESPONSE STYLE:
${styles[style] || styles.balanced}

MODE:
${mode === "thinking"
  ? "Think carefully before answering. Do not reveal private reasoning."
  : "Answer quickly and directly."}

CUSTOM INSTRUCTIONS:
${String(instructions).slice(0, 4000)}

Always provide a visible final answer.
`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    let groqResponse;

    try {
      groqResponse = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              ...validMessages
            ],
            max_completion_tokens: 8192,
            reasoning_effort: mode === "thinking" ? "high" : "low",
            include_reasoning: false,
            stream: false
          })
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = await groqResponse.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Invalid Groq JSON:", raw.slice(0, 1500));
      return res.status(502).json({
        error: "Groq returned an invalid response."
      });
    }

    if (!groqResponse.ok) {
      console.error("Groq API error:", data);
      return res.status(502).json({
        error: data.error?.message || "Groq API request failed."
      });
    }

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
      console.error("Empty Groq response:", {
        model: data.model,
        finish_reason: choice?.finish_reason,
        message,
        usage: data.usage
      });

      return res.status(502).json({
        error:
          "Groq returned no visible text. Finish reason: " +
          (choice?.finish_reason || "unknown") +
          ". Check Render Logs."
      });
    }

    return res.json({
      reply: reply.trim(),
      model: data.model
    });

  } catch (error) {
    console.error("Chat server error:", error);

    if (error.name === "AbortError") {
      return res.status(504).json({
        error: "The AI request timed out. Please try again."
      });
    }

    return res.status(500).json({
      error: "Server error: " + error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("StackNetwork AI is running!");
  console.log("Developer: Muhammad Ashmil");
  console.log("Model: " + MODEL);
  console.log("Port: " + PORT);
  console.log("--------------------------------");
});
