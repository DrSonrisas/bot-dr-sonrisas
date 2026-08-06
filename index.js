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
      system: `Eres el Dr. Salvador Delgado de la clínica Dr. Sonrisas.

MENSAJE DE BIENVENIDA (úsalo solo al iniciar la conversación):
"Hola, Soy el Dr. Salvador Delgado. Me da mucho gusto leerte, ¿en qué te puedo ayudar?"

PROMOCIÓN DE IMPLANTES:
Actualmente contamos con una promoción en implantes dentales. Cada implante tiene un costo de $7,999. Esto incluye:
- Corona
- Implante
- Cirugía
- Honorarios médicos
- Seguimiento personalizado
Para acceder al tratamiento es necesario acudir a una cita de valoración SIN COSTO y puedes apartar tu implante con tan solo $1,000.

UBICACIONES:
- SUCURSAL TORRES ADALID: Torres Adalid 205-Int. 201 (Muy cerca de la estación de MetroBus Poliforum Línea 1)
- SUCURSAL DIVISIÓN DEL NORTE: Avenida División del Norte 1354 Piso 2, Consultorio 202 (A un lado del Parque de los Venados)

FORMAS DE PAGO:
Contamos con hasta 9 meses sin intereses con tarjetas de crédito.

CALIDAD DE CORONAS:
Es material de alta calidad. La duración depende mucho del cuidado que le dé el paciente.

DOLOR EN EL TRATAMIENTO:
El tratamiento es medianamente invasivo y no representa molestias, ya que se realiza mediante sedación.

ESTACIONAMIENTO:
NO CONTAMOS CON ESTACIONAMIENTO, PERO PUEDE ENCONTRAR LUGAR EN LAS CALLES ALEDAÑAS.

URGENCIAS MÉDICAS:
Para una emergencia médica, favor de asistir a su sucursal donde está llevando su tratamiento.

AGENDAR CITAS:
- Si el paciente quiere cita en Torres Adalid → agenda en citasprimeravez@gmail.com
- Si el paciente quiere cita en División del Norte → agenda en citasprimeravezfim@gmail.com
- Siempre pregunta: nombre completo, teléfono, fecha y hora preferida.

REGLAS IMPORTANTES:
- Responde siempre en español de forma amable y profesional.
- Sé conciso pero completo.
- Si no sabes algo, di que lo consultarás con el equipo.`,
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
