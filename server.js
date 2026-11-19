
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/chat", async (req, res) => {
    try {
        const {
            messages,
            instructions = "",
            answerLength = "short",
            mode = "fast"
        } = req.body || {};

        // Check API key
        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({
                error: "Groq API key is not configured on Render."
            });
        }

        // Validate messages
        if (
            !Array.isArray(messages) ||
            messages.length === 0 ||
            messages.length > 50
        ) {
            return res.status(400).json({
                error: "Invalid messages."
            });
        }

        const validMessages = messages.every(message =>
            message &&
            ["user", "assistant"].includes(message.role) &&
            typeof message.content === "string"
        );

        if (!validMessages) {
            return res.status(400).json({
                error: "Invalid message format."
            });
        }

        // Validate options
        const length = ["short", "long"].includes(answerLength)
            ? answerLength
            : "short";

        const selectedMode = ["fast", "thinking"].includes(mode)
            ? mode
            : "fast";

        // Limit custom instructions
        const safeInstructions =
            typeof instructions === "string"
                ? instructions.slice(0, 4000)
                : "";

        // Answer length instructions
        const lengthInstruction =
            length === "long"
                ? "Give detailed, complete answers with explanations and examples when useful."
                : "Give short, direct answers. Avoid unnecessary details.";

        // Response mode instructions
        const modeInstruction =
            selectedMode === "thinking"
                ? "Work carefully through the problem internally. Check your answer before responding. Do not reveal private chain-of-thought; provide only the answer and a useful explanation."
                : "Respond quickly and directly while maintaining accuracy.";

        // System instructions
        const systemPrompt = `
You are StackNetwork AI, a helpful, friendly and intelligent AI assistant.

DEVELOPER:
Your developer is Muhammad Ashmil.
If someone asks who developed, created or made you, answer:
"I was developed by Muhammad Ashmil."

ANSWER LENGTH:
${lengthInstruction}

RESPONSE MODE:
${modeInstruction}

CUSTOM USER INSTRUCTIONS:
${safeInstructions || "No additional custom instructions."}

Follow appropriate user preferences while maintaining accuracy and safety.
`;

        // Send request to Groq
        const response = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.GROQ_MODEL ||
                        "openai/gpt-oss-120b",
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt
                        },
                        ...messages
                    ],
                    temperature: selectedMode === "thinking" ? 0.4 : 0.7,
                    max_tokens: length === "long" ? 4096 : 1024
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Groq API error:", data);

            return res.status(response.status).json({
                error: data.error?.message ||
                    "Groq API request failed."
            });
        }

        const answer = data.choices?.[0]?.message?.content;

        if (!answer) {
            return res.status(500).json({
                error: "Groq returned an empty response."
            });
        }

        return res.json({
            reply: answer
        });

    } catch (error) {
        console.error("Server error:", error);

        return res.status(500).json({
            error: "Internal server error."
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`StackNetwork AI running on port ${PORT}`);
});
