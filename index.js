const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CALENDARS = {
  torres_adalid: "citasprimeravez@gmail.com",
  division_del_norte: "citasprimeravezfim@gmail.com",
};

function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

async function agendarCita(sucursal, nombre, fecha, hora, telefono) {
  const calendar = getCalendarClient();
  const calendarId = sucursal === "torres_adalid"
    ? CALENDARS.torres_adalid
    : CALENDARS.division_del_norte;

  const fechaInicio = new Date(`${fecha}T${hora}:00-06:00`);
  const fechaFin = new Date(fechaInicio.getTime() + 60 * 60 * 1000);

  const evento = {
    summary: `Cita valoración - ${nombre}`,
    description: `Paciente: ${nombre}\nTeléfono: ${telefono}\nSucursal: ${sucursal === "torres_adalid" ? "Torres Adalid" : "División del Norte"}`,
    start: { dateTime: fechaInicio.toISOString(), timeZone: "America/Mexico_City" },
    end: { dateTime: fechaFin.toISOString(), timeZone: "America/Mexico_City" },
  };

  const res = await calendar.events.insert({ calendarId, requestBody: evento });

  programarRecordatorios(nombre, fecha, hora, sucursal, telefono);

  return res.data;
}

async function enviarWhatsApp(telefono, mensaje) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: { body: mensaje },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

function programarRecordatorios(nombre, fecha, hora, sucursal, telefono) {
  const sucursalNombre = sucursal === "torres_adalid" ? "Torres Adalid" : "División del Norte";
  const fechaCita = new Date(`${fecha}T${hora}:00-06:00`);

  const recordatorio24h = new Date(fechaCita.getTime() - 24 * 60 * 60 * 1000);
  const recordatorio2h = new Date(fechaCita.getTime() - 2 * 60 * 60 * 1000);

  const ahora = new Date();

  const msg24h = `Hola ${nombre}, te recordamos que mañana tienes tu cita de valoración a las ${hora} en nuestra sucursal ${sucursalNombre}. ¡Te esperamos! 😊`;
  const msg2h = `Hola ${nombre}, tu cita de valoración es en 2 horas a las ${hora} en ${sucursalNombre}. ¡Te esperamos! 😊`;

  const delay24h = recordatorio24h.getTime() - ahora.getTime();
  const delay2h = recordatorio2h.getTime() - ahora.getTime();

  if (delay24h > 0) {
    setTimeout(async () => {
      try {
        await enviarWhatsApp(telefono, msg24h);
        console.log(`Recordatorio 24h enviado a ${telefono}`);
      } catch (err) {
        console.error("Error recordatorio 24h:", err.message);
      }
    }, delay24h);
    console.log(`Recordatorio 24h programado para ${recordatorio24h.toISOString()}`);
  }

  if (delay2h > 0) {
    setTimeout(async () => {
      try {
        await enviarWhatsApp(telefono, msg2h);
        console.log(`Recordatorio 2h enviado a ${telefono}`);
      } catch (err) {
        console.error("Error recordatorio 2h:", err.message);
      }
    }, delay2h);
    console.log(`Recordatorio 2h programado para ${recordatorio2h.toISOString()}`);
  }
}

const conversaciones = {};

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

    if (!conversaciones[from]) conversaciones[from] = [];
    conversaciones[from].push({ role: "user", content: text });

    if (conversaciones[from].length > 20) {
      conversaciones[from] = conversaciones[from].slice(-20);
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
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
- Pregunta en qué sucursal prefiere: Torres Adalid o División del Norte
- Luego pide: nombre completo, fecha (YYYY-MM-DD) y hora (HH:MM)
- Cuando tengas todos los datos, responde EXACTAMENTE en este formato JSON y nada más:
AGENDAR:{"sucursal":"torres_adalid","nombre":"Nombre Apellido","fecha":"2024-01-15","hora":"10:00"}
- Usa "torres_adalid" o "division_del_norte" como valor de sucursal

REGLAS IMPORTANTES:
- Responde siempre en español de forma amable y profesional.
- Sé conciso pero completo.
- Si no sabes algo, di que lo consultarás con el equipo.`,
      messages: conversaciones[from],
    });

    let reply = response.content[0].text;

    if (reply.includes("AGENDAR:")) {
      try {
        const jsonStr = reply.split("AGENDAR:")[1].trim();
        const datos = JSON.parse(jsonStr);
        await agendarCita(datos.sucursal, datos.nombre, datos.fecha, datos.hora, from);
        const sucursalNombre = datos.sucursal === "torres_adalid" ? "Torres Adalid" : "División del Norte";
        reply = `✅ ¡Listo ${datos.nombre}! Tu cita de valoración quedó agendada en la sucursal ${sucursalNombre} el ${datos.fecha} a las ${datos.hora}. ¡Te esperamos! 😊`;
      } catch (err) {
        console.error("Error agendando:", err.message);
        reply = "Hubo un problema al agendar tu cita. Por favor intenta de nuevo.";
      }
    }

    conversaciones[from].push({ role: "assistant", content: reply });

    await enviarWhatsApp(from, reply);
    console.log(`Respuesta enviada a ${from}`);
  } catch (err) {
    console.error("Error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
