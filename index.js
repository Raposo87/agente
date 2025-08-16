// index.js
import express from "express";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

// Carrega os dados do estúdio
const yogaData = JSON.parse(fs.readFileSync("./yoga_kula.json", "utf-8"));

// -------------- Utilitários --------------
const diasPt = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
function isoToDiaPt(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  return diasPt[d.getDay()];
}
function normalizaModalidade(s) {
  if (!s) return null;
  const x = s.trim().toLowerCase();
  if (x.includes("hatha")) return "hatha yoga";
  if (x.includes("vinyasa")) return "vinyasa yoga";
  if (x.includes("dinamico") || x.includes("dinâmico")) return "yoga dinâmico";
  return s.toLowerCase();
}
function encontraModal(modalidade) {
  if (!modalidade) return null;
  const alvo = normalizaModalidade(modalidade);
  return yogaData.modalidades.find(m => m.nome.toLowerCase() === alvo) || null;
}
function temHorario(modalidade, dataISO, horaHHMM) {
  const mod = encontraModal(modalidade);
  if (!mod || !dataISO || !horaHHMM) return false;
  const dia = isoToDiaPt(dataISO);
  const arr = mod.horarios?.[dia] || [];
  const hhmm = horaHHMM.slice(0, 5);
  return arr.some(h => h === hhmm);
}
function precoBase(modalidade) {
  const mod = encontraModal(modalidade);
  return mod?.preco || yogaData.precos?.avulsa || 15.0;
}
function aplicaDescontos(preco, bairro, idade) {
  let p = preco;
  if ((bairro || "").toLowerCase().includes("benfica")) p *= 0.9;
  if (!isNaN(Number(idade)) && Number(idade) >= 65) p *= 0.9;
  return Math.round(p * 100) / 100;
}
function splitDateTime(dt) {
  try {
    if (!dt || typeof dt !== "string") return { data: null, hora: null };
    const [dataISO, timeRest] = dt.split("T");
    const horaFull = timeRest.replace(/Z|[+-]\d{2}:\d{2}$/, "");
    return { data: dataISO, hora: horaFull };
  } catch {
    return { data: null, hora: null };
  }
}

// -------------- OpenAI --------------
async function askGPT(messages) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      temperature: 0.5,
      max_tokens: 400
    })
  });
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function classificaEExtrai(userText) {
  const system = {
    role: "system",
    content:
      "És um assistente do estúdio Yoga Kula (Lisboa). Responde em PT-PT. " +
      "Devolve apenas JSON válido: {\"intent\":\"agendar|pergunta|outro\",\"modalidade\":string|null,\"data\":string|null,\"hora\":string|null}. " +
      "Data: YYYY-MM-DD, Hora: HH:MM."
  };
  const user = {
    role: "user",
    content: `Texto: "${userText}". Modalidades: Hatha Yoga, Vinyasa Yoga, Yoga Dinâmico.`
  };

  const raw = await askGPT([system, user]);
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);
    obj.intent = (obj.intent || "outro").toLowerCase();
    obj.modalidade = obj.modalidade ? normalizaModalidade(obj.modalidade) : null;
    if (obj.hora?.length >= 5) obj.hora = obj.hora.slice(0, 5);
    return obj;
  } catch {
    const txt = userText.toLowerCase();
    const intent =
      /agend| reserv| marc| inscrev| aula/.test(txt) ? "agendar" :
      /preç| valor| desconto| modalidad| horár/.test(txt) ? "pergunta" :
      "outro";
    let modalidade = null;
    if (txt.includes("hatha")) modalidade = "hatha yoga";
    else if (txt.includes("vinyasa")) modalidade = "vinyasa yoga";
    else if (txt.includes("dinam") || txt.includes("dinâm")) modalidade = "yoga dinâmico";
    return { intent, modalidade, data: null, hora: null };
  }
}

// -------------- Webhook --------------
app.post("/webhook", async (req, res) => {
  try {
    const tag = req.body.fulfillmentInfo?.tag || null;
    const sessionParams = req.body.sessionInfo?.parameters || {};
    const userText =
      req.body.text ||
      sessionParams.ultima_mensagem ||
      req.body.messages?.[0]?.text ||
      "";

    // Tentativa de capturar nome e telefone do WhatsApp
    let nomeWhats = null;
    let telefoneWhats = null;
    if (req.body.originalDetectIntentRequest?.payload?.source === "whatsapp") {
      const payload = req.body.originalDetectIntentRequest.payload;
      telefoneWhats = payload?.from || null;
      nomeWhats = payload?.profile?.name || null;
    }

    console.log("📥 CX tag:", tag, "| userText:", userText, "| Nome:", nomeWhats, "| Tel:", telefoneWhats);

    if (tag === "GPT_FALLBACK") {
      const cls = await classificaEExtrai(userText);

      if (cls.intent === "agendar") {
        const newParams = {
          ...sessionParams,
          handoff_to_agendar: true,
          nome: nomeWhats || sessionParams.nome,
          telefone: telefoneWhats || sessionParams.telefone
        };
        if (cls.modalidade) newParams.modalidade = cls.modalidade;
        if (cls.data) newParams.data = cls.data;
        if (cls.hora) newParams.horas = cls.hora;
        if (cls.data && cls.hora) newParams.data_hora = `${cls.data}T${cls.hora}:00`;

        return res.json({
          session_info: { parameters: newParams },
          fulfillment_response: {
            messages: [{
              text: { text: [
                "Perfeito, vamos tratar do teu agendamento ✨\n" +
                "Preciso de: Modalidade, Morada, Idade e Email.\n" +
                "O teu nome e número já tenho pelo WhatsApp 😉"
              ]}
            }]
          }
        });
      }

      const answer = await askGPT([
        { role: "system", content: "És um assistente útil do estúdio Yoga Kula." },
        { role: "user", content: userText }
      ]);

      return res.json({
        fulfillment_response: {
          messages: [{ text: { text: [answer] } }]
        }
      });
    }

    if (tag === "CHECK_AVAILABILITY") {
      const modalidade = sessionParams.modalidade || null;
      let dataISO = null, hora = null;
      if (sessionParams.data_hora) {
        const { data, hora: hhmmss } = splitDateTime(String(sessionParams.data_hora));
        dataISO = data;
        hora = hhmmss;
      } else {
        dataISO = sessionParams.data || null;
        hora = sessionParams.horas || null;
      }

      const bairro = sessionParams.bairro || "";
      const idade = sessionParams.idade || null;
      const ok = temHorario(modalidade, dataISO, hora);
      const base = precoBase(modalidade);
      const total = aplicaDescontos(base, bairro, idade);

      return res.json({
        session_info: {
          parameters: {
            is_available: ok,
            preco_base: base,
            preco_total: total
          }
        },
        fulfillment_response: {
          messages: [{
            text: { text: [ok ? "✅ Há vaga nesse horário." : "❌ Não tenho vaga nesse horário. Queres tentar outro dia/hora?"] }
          }]
        }
      });
    }

    return res.json({
      fulfillment_response: {
        messages: [{ text: { text: ["Tag desconhecida no webhook."] } }]
      }
    });

  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    return res.json({
      fulfillment_response: {
        messages: [{ text: { text: ["Ocorreu um erro. Podes tentar de novo?"] } }]
      }
    });
  }
});

// Porta
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Webhook Yoga Kula a correr na porta ${PORT}`));
