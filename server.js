
const express = require("express");
const path = require("path");

const app = express();

// Middleware
app.use(express.json({ limit: "1mb" }));

// Serve website files from public folder
app.use(express.static(path.join(__dirname, "public")));

// Groq AI Chat API
app.post("/api/chat", async (req, res) => {
    try {
        const { messages } = req.body;

        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({
                error: "Groq API key is not configured on Render."
            });
        }

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
                        "llama-3.3-70b-versatile",
                    messages: [
                        {
                            role: "system",
                            content: "You are StackNetwork AI, a helpful and friendly AI assistant."
                        },
                        ...messages
                    ],
                    temperature: 0.7,
                    max_tokens: 2048
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Groq API error:", data);

            return res.status(response.status).json({
                error: data.error?.message || "Groq API request failed."
            });
        }

        const answer = data.choices?.[0]?.message?.content;

        if (!answer) {
            return res.status(500).json({
                error: "Groq returned an empty response."
            });
        }

        res.json({
            reply: answer
        });

    } catch (error) {
        console.error("Server error:", error);

        res.status(500).json({
            error: "Internal server error."
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`StackNetwork AI running on port ${PORT}`);
});
