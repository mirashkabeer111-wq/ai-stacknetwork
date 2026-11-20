
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ developer: "Muhammad Ashmil" });
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

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Please enter a message." });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing from Render."
      });
    }

    const chatMessages = messages.slice(-30).map(m => {
      if (
        !m ||
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string"
      ) {
        throw new Error("Invalid message format.");
      }

      return {
        role: m.role,
        content: m.content.slice(0, 20000)
      };
    });

    const personas = {
      helpful: "You are a helpful and friendly AI assistant.",
      teacher: "You are a patient teacher.",
      coder: "You are an expert programming assistant.",
      creative: "You are a creative assistant.",
      professional: "You are a professional assistant.",
      gamer: "You are a gaming expert, especially in Minecraft."
    };

    const lengths = {
      short: "Give short and direct answers.",
      medium: "Give balanced answers with useful details.",
      long: "Give detailed answers with examples."
    };

    const styles = {
      balanced: "Use a balanced writing style.",
      friendly: "Use a friendly conversational tone.",
      professional: "Use a professional tone.",
      simple: "Use simple language.",
      detailed: "Explain topics in detail."
    };

    const systemPrompt = `
You are StackNetwork AI.
Developer: Muhammad Ashmil.

Be helpful, friendly and accurate.
Allow harmless educational, fictional and cybersecurity discussions.
Do not provide actionable instructions for real-world harm or crime.
Do not refuse harmless questions unnecessarily.

${personas[persona] || personas.helpful}
${lengths[answerLength] || lengths.medium}
${styles[style] || styles.balanced}

${mode === "thinking"
  ? "Think carefully before answering. Do not reveal private reasoning."
  : "Answer quickly and directly."}

Additional instructions:
${String(instructions).slice(0, 4000)}

Always provide a visible final answer.
`;

    const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

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
            { role: "system", content: systemPrompt },
            ...chatMessages
          ],
          temperature: 0.7,
          max_completion_tokens: 2048,
          stream: false
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("GROQ API ERROR:", JSON.stringify(data));

      return res.status(response.status).json({
        error: data.error?.message || "Groq API request failed."
      });
    }

    const choice = data.choices?.[0];
    const message = choice?.message;

    let reply = message?.content;

    // Handle text returned as content blocks
    if (Array.isArray(reply)) {
      reply = reply
        .filter(item => item.type === "text")
        .map(item => item.text || "")
        .join("\n");
    }

    if (typeof reply !== "string" || !reply.trim()) {
      console.error("EMPTY AI RESPONSE:", JSON.stringify({
        model: data.model,
        finish_reason: choice?.finish_reason,
        message,
        usage: data.usage
      }));

      return res.status(502).json({
        error: `The model returned no visible text. Finish reason: ${choice?.finish_reason || "unknown"}. Check Render logs.`
      });
    }

    return res.json({ reply: reply.trim() });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return res.status(500).json({
      error: error.message || "Internal server error."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`StackNetwork AI running on port ${PORT}`);
});
