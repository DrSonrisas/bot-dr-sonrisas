const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text.body;

    console.log(`Mensaje de ${from}: ${text}`);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: text }],
      system: "Eres un asistente amable de Dr Sonrisas, una clínica dental. Responde en español, sé conciso y útil. Ayuda con citas, preguntas sobre tratamientos y dudas generales.",
    });

    const reply = response.content[0].text;

    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: reply },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`Respuesta enviada a ${from}`);
  } catch (err) {
    console.error("Error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
