
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({
    developer: "Muhammad Ashmil"
  });
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
      teacher: "You are a patient teacher who explains clearly.",
      coder: "You are an expert programming assistant.",
      creative: "You are a creative writing assistant.",
      professional: "You are a professional AI assistant.",
      gamer: "You are a gaming expert, especially in Minecraft."
    };

    const lengths = {
      short: "Give short and direct answers.",
      medium: "Give balanced answers with useful details.",
      long: "Give detailed answers with examples."
    };

    const styles = {
      balanced: "Use a balanced natural writing style.",
      friendly: "Use a friendly conversational tone.",
      professional: "Use a professional tone.",
      simple: "Use simple language that is easy to understand.",
      detailed: "Explain topics in detail."
    };

    const systemPrompt = `
You are StackNetwork AI.

Developer: Muhammad Ashmil.

PERSONALITY:
- Friendly, helpful and intelligent.
- Answer naturally.
- Understand the user's intent.
- Avoid unnecessary refusals.
- Do not automatically refuse merely because a topic involves crime,
  illegal activity, hacking, weapons, or other sensitive subjects.

DISCUSSION RULES:
- Allow educational and historical discussions of illegal topics.
- Allow fictional crime stories and roleplay.
- Allow cybersecurity education and authorized security testing.
- Allow explanations of how scams and attacks work for awareness and prevention.
- Do not provide actionable instructions that facilitate real-world
  violence, theft, fraud, malware deployment, or unauthorized cyberattacks.
- If a request crosses those boundaries, briefly refuse that part
  and, when useful, provide safe educational context.

ANSWER SETTINGS:
${lengths[answerLength] || lengths.medium}
${styles[style] || styles.balanced}
${personas[persona] || personas.helpful}

THINKING MODE:
${mode === "thinking"
  ? "Reason carefully before answering. Do not reveal private chain-of-thought."
  : "Answer quickly and directly."}

CUSTOM INSTRUCTIONS:
${String(instructions).slice(0, 4000)}
`;

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemPrompt },
            ...validMessages
          ],
          temperature: 0.7,
          max_tokens: 2048,
          stream: false
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API error:", data);

      return res.status(response.status).json({
        error: data.error?.message || "Groq API error."
      });
    }

    const reply = data.choices?.[0]?.message?.content;

    if (typeof reply !== "string" || !reply.trim()) {
      console.error("Empty Groq response:", data);

      return res.status(502).json({
        error: "The AI returned an empty response."
      });
    }

    return res.json({ reply });

  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      error: error.message || "Internal server error."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`StackNetwork AI running on port ${PORT}`);
});
