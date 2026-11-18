
const express = require("express");

const app = express();

app.use(express.json());
app.use(express.static("public"));

app.post("/api/chat", async (req, res) => {
    try {
        const { messages } = req.body;

        if (!Array.isArray(messages)) {
            return res.status(400).json({
                error: "Invalid messages"
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
                    model: "llama-3.3-70b-versatile",
                    messages: messages
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || "Groq API error"
            });
        }

        res.json({
            reply: data.choices[0].message.content
        });

    } catch (error) {
        res.status(500).json({
            error: "Server error"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`StackNetwork AI running on port ${PORT}`);
});
