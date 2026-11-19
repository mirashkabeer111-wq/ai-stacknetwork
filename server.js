
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const MODEL_OPTIONS = (
  process.env.GROQ_MODEL_OPTIONS ||
  DEFAULT_MODEL
).split(",").map(x => x.trim()).filter(Boolean);

app.get("/api/config", (req, res) => {
  res.json({
    models: MODEL_OPTIONS,
    defaultModel: DEFAULT_MODEL,
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
      persona = "assistant",
      style = "friendly",
      model = DEFAULT_MODEL
    } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing in Render environment variables."
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages provided." });
    }

    const selectedModel = MODEL_OPTIONS.includes(model)
      ? model
      : DEFAULT_MODEL;

    const personas = {
      assistant: "You are a helpful general AI assistant.",
      coder: "You are an expert programmer. Explain code clearly.",
      gaming: "You are a gaming expert, especially Minecraft.",
      teacher: "You are a patient teacher. Explain step by step.",
      creative: "You are a creative assistant.",
      professional: "You are a professional business assistant."
    };

    const styles = {
      friendly: "Use a friendly and natural tone.",
      professional: "Use a professional tone.",
      simple: "Use simple words and clear explanations.",
      formal: "Use formal language.",
      funny: "Use light humor when appropriate."
    };

    const lengths = {
      short: "Keep answers brief and direct.",
      medium: "Give a balanced answer with useful details.",
      long: "Give a detailed and thorough answer with examples when useful."
    };

    const systemPrompt = `
You are StackNetwork AI.
You were developed by Muhammad Ashmil.
If asked who developed you, answer: Muhammad Ashmil.

${personas[persona] || personas.assistant}
${styles[style] || styles.friendly}
${lengths[answerLength] || lengths.medium}

${mode === "thinking"
  ? "Carefully check the problem before answering. Give the conclusion and useful explanation, but do not reveal private chain-of-thought."
  : "Answer efficiently and directly."}

${instructions ? "Additional user instructions:\n" + instructions : ""}
`;

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages
          ],
          temperature: 0.7,
          max_tokens:
            answerLength === "long" ? 4096 :
            answerLength === "short" ? 1024 : 2048
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "Groq API request failed."
      });
    }

    res.json({
      reply: data.choices?.[0]?.message?.content || "",
      model: selectedModel
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Something went wrong. Please try again."
    });
  }
});

app.listen(PORT, () => {
  console.log(`StackNetwork AI running on port ${PORT}`);
});
