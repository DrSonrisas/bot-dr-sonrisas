const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const { createServer } = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CALENDARS = {
  torres_adalid: "citasprimeravez@gmail.com",
  division_del_norte: "citasprimeravezfim@gmail.com",
};

// Horario de atención para citas
const HORA_APERTURA = 10; // 10:00 am
const HORA_CIERRE = 18; // 6:00 pm
const DURACION_CITA_MIN = 60; // duración de cada cita en minutos

// Valida que una hora "HH:MM" esté dentro del horario de atención
// y que la cita (con su duración) no se pase de la hora de cierre.
function horaDentroDeHorario(hora) {
  if (!/^\d{2}:\d{2}$/.test(hora)) return false;
  const [h, m] = hora.split(":").map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return false;

  const inicioMin = h * 60 + m;
  const aperturaMin = HORA_APERTURA * 60;
  const cierreMin = HORA_CIERRE * 60;

  return inicioMin >= aperturaMin && inicioMin + DURACION_CITA_MIN <= cierreMin;
}

// Devuelve la fecha/hora actual en la zona horaria de la clínica (CDMX),
// tanto en formato ISO (YYYY-MM-DD) como en formato legible para el prompt.
function obtenerFechaHoyCDMX() {
  const ahora = new Date();
  const iso = ahora.toLocaleDateString("sv-SE", { timeZone: "America/Mexico_City" }); // "YYYY-MM-DD"
  const legible = ahora.toLocaleDateString("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { iso, legible };
}

// Rechaza fechas que ya pasaron (comparando contra "hoy" en CDMX),
// como red de seguridad por si el modelo se equivoca de año.
function fechaEsFutura(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const { iso: hoyISO } = obtenerFechaHoyCDMX();
  return fecha >= hoyISO; // comparación de strings YYYY-MM-DD es válida cronológicamente
}

// Días en los que la clínica no agenda citas (vacaciones, días festivos, etc.).
// Agrega o quita fechas aquí en formato "YYYY-MM-DD" según se necesite.
const FECHAS_BLOQUEADAS = ["2026-09-15", "2026-09-16", "2026-09-24"];

function fechaBloqueada(fecha) {
  return FECHAS_BLOQUEADAS.includes(fecha);
}

const conversaciones = {};
const historialPanel = {};

function getCalendarClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

function calendarIdDeSucursal(sucursal) {
  return sucursal === "torres_adalid" ? CALENDARS.torres_adalid : CALENDARS.division_del_norte;
}

// Color amarillo ("Banana") para los eventos creados por el bot.
// colorId de Google Calendar: 1 Lavanda, 2 Salvia, 3 Uva, 4 Flamenco, 5 Plátano (amarillo),
// 6 Mandarina, 7 Pavo real, 8 Grafito, 9 Arándano, 10 Albahaca, 11 Tomate.
const COLOR_ID_AMARILLO = "5";

// Revisa en Google Calendar (vía freebusy) si el calendario de la sucursal
// ya tiene algo agendado en ese rango de tiempo.
async function horarioOcupado(sucursal, fecha, hora) {
  const calendar = getCalendarClient();
  const calendarId = calendarIdDeSucursal(sucursal);

  const fechaInicio = new Date(`${fecha}T${hora}:00-06:00`);
  const fechaFin = new Date(fechaInicio.getTime() + DURACION_CITA_MIN * 60 * 1000);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: fechaInicio.toISOString(),
      timeMax: fechaFin.toISOString(),
      timeZone: "America/Mexico_City",
      items: [{ id: calendarId }],
    },
  });

  const ocupado = res.data.calendars?.[calendarId]?.busy || [];
  return ocupado.length > 0;
}

async function agendarCita(sucursal, nombre, fecha, hora, telefono) {
  const calendar = getCalendarClient();
  const calendarId = calendarIdDeSucursal(sucursal);

  const fechaInicio = new Date(`${fecha}T${hora}:00-06:00`);
  const fechaFin = new Date(fechaInicio.getTime() + DURACION_CITA_MIN * 60 * 1000);

  const evento = {
    summary: `Cita valoración - ${nombre}`,
    description: `Paciente: ${nombre}\nTeléfono: ${telefono}\nSucursal: ${sucursal === "torres_adalid" ? "Torres Adalid" : "División del Norte"}`,
    start: { dateTime: fechaInicio.toISOString(), timeZone: "America/Mexico_City" },
    end: { dateTime: fechaFin.toISOString(), timeZone: "America/Mexico_City" },
    colorId: COLOR_ID_AMARILLO,
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
  const ahora = new Date();

  const msg24h = `Hola ${nombre}, te recordamos que mañana tienes tu cita de valoración a las ${hora} en nuestra sucursal ${sucursalNombre}. ¡Te esperamos! 😊`;
  const msg2h = `Hola ${nombre}, tu cita de valoración es en 2 horas a las ${hora} en ${sucursalNombre}. ¡Te esperamos! 😊`;

  const delay24h = fechaCita.getTime() - 24 * 60 * 60 * 1000 - ahora.getTime();
  const delay2h = fechaCita.getTime() - 2 * 60 * 60 * 1000 - ahora.getTime();

  if (delay24h > 0) {
    setTimeout(async () => {
      try {
        await enviarWhatsApp(telefono, msg24h);
        guardarMensajePanel(telefono, msg24h, "bot");
        console.log(`Recordatorio 24h enviado a ${telefono}`);
      } catch (err) {
        console.error("Error recordatorio 24h:", err.message);
      }
    }, delay24h);
  }

  if (delay2h > 0) {
    setTimeout(async () => {
      try {
        await enviarWhatsApp(telefono, msg2h);
        guardarMensajePanel(telefono, msg2h, "bot");
        console.log(`Recordatorio 2h enviado a ${telefono}`);
      } catch (err) {
        console.error("Error recordatorio 2h:", err.message);
      }
    }, delay2h);
  }
}

function guardarMensajePanel(telefono, texto, tipo) {
  if (!historialPanel[telefono]) historialPanel[telefono] = [];
  const mensaje = { texto, tipo, timestamp: Date.now(), leido: false };
  historialPanel[telefono].push(mensaje);
  io.emit("nuevo_mensaje", { telefono, mensaje });
}

io.on("connection", (socket) => {
  console.log("Panel conectado");
  socket.emit("historial", historialPanel);
});

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

    guardarMensajePanel(from, text, "usuario");

    if (!conversaciones[from]) conversaciones[from] = [];
    conversaciones[from].push({ role: "user", content: text });

    if (conversaciones[from].length > 20) {
      conversaciones[from] = conversaciones[from].slice(-20);
    }

    const { iso: fechaHoyISO, legible: fechaHoyLegible } = obtenerFechaHoyCDMX();
    // Un ejemplo de fecha futura (7 días adelante) solo para mostrar el formato,
    // así el modelo nunca copia un año fijo/desactualizado del prompt.
    const fechaEjemplo = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toLocaleDateString("sv-SE", { timeZone: "America/Mexico_City" });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `Eres el Dr. Salvador Delgado de la clínica Dr. Sonrisas.

FECHA Y HORA ACTUAL: Hoy es ${fechaHoyLegible} (${fechaHoyISO}), zona horaria Ciudad de México. Usa SIEMPRE esta fecha como referencia real para interpretar "hoy", "mañana", "el próximo lunes", etc. Si el paciente no menciona el año, asume el año actual (o el siguiente si esa fecha ya pasó este año). NUNCA agendes ni ofrezcas una fecha anterior a hoy.

DÍAS SIN CITAS: La clínica NO agenda citas los siguientes días: ${FECHAS_BLOQUEADAS.join(", ")}. Si el paciente pide una cita en alguno de esos días, explícale que ese día no hay citas disponibles y pídele que elija otra fecha.

MENSAJE DE BIENVENIDA (úsalo solo al iniciar la conversación):
"Hola, Soy el Dr. Salvador Delgado. Me da mucho gusto leerte, ¿en qué te puedo ayudar?"

PROMOCIÓN DE IMPLANTES:
Actualmente contamos con una promoción en implantes dentales. Cada implante tiene un costo de $12,800. Esto incluye:
- Corona
- Implante
- Cirugía
- Honorarios médicos
- Seguimiento personalizado
Para acceder al tratamiento es necesario acudir primero a una consulta de valoración, y puedes apartar tu implante con tan solo $1,000.

CONSULTA DE VALORACIÓN:
La consulta de valoración tiene un costo de $500 pesos. En esta consulta de valoración haremos:
- Radiografía panorámica
- Escaneo facial
- Diagnóstico
- Expediente
- Presupuesto
En caso de que usted decida iniciar su tratamiento, este pago de su consulta se tomará en cuenta para su tratamiento.

UBICACIONES:
- SUCURSAL TORRES ADALID: Torres Adalid 205-Int. 201 (Muy cerca de la estación de MetroBus Poliforum Línea 1)
Actualmente solo damos consultas y citas en la sucursal Torres Adalid.

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
- Todas las citas son en la sucursal Torres Adalid (es la única sucursal disponible actualmente). No preguntes por otra sucursal ni la ofrezcas.
- Pide: nombre completo, fecha (YYYY-MM-DD) y hora (HH:MM)
- HORARIO DE CITAS: Solo se agendan citas de 10:00 am a 6:00 pm (18:00 hrs), de manera que la cita termine a más tardar a las 18:00. NUNCA ofrezcas ni aceptes un horario fuera de este rango (por ejemplo, no ofrezcas las 8:00, las 19:00, ni citas de madrugada). Si el paciente pide un horario fuera de este rango, explícale amablemente el horario disponible y pídele que elija otra hora dentro de 10:00-18:00.
- DISPONIBILIDAD: El sistema revisa automáticamente si el horario solicitado ya está ocupado en el calendario de esa sucursal. Si te llega un aviso de que el horario ya está ocupado, pídele amablemente al paciente otra fecha y/o hora.
- Cuando tengas todos los datos, responde EXACTAMENTE en este formato JSON y nada más (el valor de "fecha" es solo un ejemplo de formato, siempre usa la fecha real que te dio el paciente con el año correcto):
AGENDAR:{"sucursal":"torres_adalid","nombre":"Nombre Apellido","fecha":"${fechaEjemplo}","hora":"10:00"}
- El valor de "sucursal" siempre debe ser "torres_adalid"

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

        if (!fechaEsFutura(datos.fecha)) {
          // No se agenda: la fecha ya pasó (o el modelo puso un año incorrecto).
          const { legible } = obtenerFechaHoyCDMX();
          reply = `Esa fecha ya pasó (hoy es ${legible}). ¿Podrías darme una fecha a partir de hoy?`;
        } else if (fechaBloqueada(datos.fecha)) {
          // No se agenda: es un día bloqueado (sin citas disponibles).
          reply = `Lo siento, el ${datos.fecha} no tenemos citas disponibles. ¿Podrías elegir otra fecha?`;
        } else if (!horaDentroDeHorario(datos.hora)) {
          // No se agenda: la hora solicitada cae fuera del horario de atención.
          reply = `Lo siento, nuestro horario para citas de valoración es de ${HORA_APERTURA}:00 am a ${HORA_CIERRE}:00 (6:00 pm). ¿Podrías elegir otro horario dentro de ese rango?`;
        } else if (await horarioOcupado(datos.sucursal, datos.fecha, datos.hora)) {
          // No se agenda: ya hay otra cita en ese horario en esa sucursal.
          reply = `Ese horario ya está ocupado en esa sucursal. ¿Podrías elegir otra hora u otro día?`;
        } else {
          await agendarCita(datos.sucursal, datos.nombre, datos.fecha, datos.hora, from);
          const sucursalNombre = datos.sucursal === "torres_adalid" ? "Torres Adalid" : "División del Norte";
          reply = `✅ ¡Listo ${datos.nombre}! Tu cita de valoración quedó agendada en la sucursal ${sucursalNombre} el ${datos.fecha} a las ${datos.hora}. ¡Te esperamos! 😊`;
        }
      } catch (err) {
        console.error("Error agendando:", err.message);
        reply = "Hubo un problema al agendar tu cita. Por favor intenta de nuevo.";
      }
    }

    conversaciones[from].push({ role: "assistant", content: reply });
    guardarMensajePanel(from, reply, "bot");

    await enviarWhatsApp(from, reply);
    console.log(`Respuesta enviada a ${from}`);
  } catch (err) {
    console.error("Error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
