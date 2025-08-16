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
  // isoDate esperado no formato "YYYY-MM-DD"
  const d = new Date(isoDate + "T00:00:00");
  const idx = d.getDay(); // 0..6
  return diasPt[idx];
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
  // horaHHMM pode vir como "18:15:00" → corta segundos
  const hhmm = horaHHMM.slice(0,5);
  return arr.some(h => h === hhmm);
}
function precoBase(modalidade) {
  const mod = encontraModal(modalidade);
  if (mod?.preco) return mod.preco;
  return yogaData.precos?.avulsa || 15.0;
}
function aplicaDescontos(preco, bairro, idade) {
  let p = preco;
  const benfica = (bairro || "").toLowerCase().includes("benfica");
  const id = Number(idade);
  // regras do teu JSON: 10% Benfica (mensalidades) e 10% 65+ (geral)
  // aqui aplico 10% se Benfica OU 65+, acumulando se ambos (podes mudar)
  if (benfica) p = p * 0.9;
  if (!isNaN(id) && id >= 65) p = p * 0.9;
  return Math.round(p * 100) / 100;
}

// -------------- OpenAI (GPT) --------------
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
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// Pede ao GPT para classificar intenção e extrair entidades (JSON estrito)
async function classificaEExtrai(userText) {
  const system = {
    role: "system",
    content:
      "És um assistente do estúdio Yoga Kula (Lisboa). Responde em português (Portugal). " +
      "Tarefa: classificar a intenção do utilizador e extrair valores. " +
      "Devolve APENAS JSON válido com as chaves: {\"intent\":\"agendar|pergunta|outro\",\"modalidade\":string|null,\"data\":string|null,\"hora\":string|null}. " +
      "Formata data como YYYY-MM-DD se possível; hora como HH:MM (24h). " +
      "Não escrevas texto fora do JSON."
  };
  const user = {
    role: "user",
    content:
      `Texto do utilizador: "${userText}". ` +
      "Modalidades: Hatha Yoga, Vinyasa Yoga, Yoga Dinâmico. " +
      "Exemplos de intenção 'agendar': 'quero agendar', 'reservar', 'marcar', 'inscrever'. " +
      "Se não tiveres a certeza da data/hora/modalidade, deixa null."
  };

  const raw = await askGPT([system, user]);

  // Tenta parse seguro
  try {
    // alguns modelos podem envolver em markdown; remove cercas se houver
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);
    // normaliza
    obj.intent = (obj.intent || "outro").toLowerCase();
    obj.modalidade = obj.modalidade ? normalizaModalidade(obj.modalidade) : null;
    if (obj.hora && obj.hora.length >= 5) obj.hora = obj.hora.slice(0,5);
    return obj;
  } catch (e) {
    // fallback simples por regras
    const txt = userText.toLowerCase();
    const intent =
      /agend|reserv|marc|inscrev|aula/.test(txt) ? "agendar" :
      /preç|valor|desconto|modalidad|horár|horar|benef|saúde|ajuda/.test(txt) ? "pergunta" :
      "outro";
    let modalidade = null;
    if (txt.includes("hatha")) modalidade = "hatha yoga";
    else if (txt.includes("vinyasa")) modalidade = "vinyasa yoga";
    else if (txt.includes("dinam") || txt.includes("dinâm")) modalidade = "yoga dinâmico";
    return { intent, modalidade, data: null, hora: null };
  }
}

// -------------- Webhook do CX --------------
app.post("/webhook", async (req, res) => {
  try {
    const tag = req.body.fulfillmentInfo?.tag || null;
    const sessionParams = req.body.sessionInfo?.parameters || {};
    const userText =
      req.body.text ||
      sessionParams.ultima_mensagem ||
      req.body.messages?.[0]?.text || // dependendo do canal
      "";

    // LOG (aparece nos logs do Railway)
    console.log("📥 CX tag:", tag, " | userText:", userText);

    // ---------- Tag: GPT_FALLBACK ----------
    if (tag === "GPT_FALLBACK") {
      const cls = await classificaEExtrai(userText);

      // Se intenção for agendar, já devolve presets e handoff
      if (cls.intent === "agendar") {
        const responseMessages = [];

        // Mensagem simpática de confirmação
        responseMessages.push({
          text: { text: ["Perfeito, vamos tratar do teu agendamento ✨"] }
        });

        // Define presets para o CX (se GPT conseguiu extrair)
        const newParams = {
          ...sessionParams,
          handoff_to_agendar: true, // flag para rota condicional no CX
        };
        if (cls.modalidade) newParams.modalidade = cls.modalidade;
        if (cls.data) newParams.data = cls.data;         // "YYYY-MM-DD"
        if (cls.hora) newParams.horas = cls.hora;        // ID do teu parâmetro é "horas"

        return res.json({
          session_info: { parameters: newParams },
          fulfillment_response: { messages: responseMessages }
        });
      }

      // Caso seja pergunta aberta, responde com GPT, dando contexto do JSON
      const prompt =
        "Responde de forma breve e clara, PT-PT. Usa estes dados do estúdio " +
        "(endereço, modalidades, horários, descontos) quando relevante:\n\n" +
        JSON.stringify(yogaData, null, 2) +
        "\n\nPergunta: " + userText;

      const answer = await askGPT([
        { role: "system", content: "És um assistente útil do estúdio Yoga Kula em Lisboa. Evita respostas longas." },
        { role: "user", content: prompt }
      ]);

      return res.json({
        fulfillment_response: {
          messages: [{ text: { text: [answer || "Posso ajudar com horários, modalidades, preços ou agendamento. O que preferes?"] } }]
        }
      });
    }

    // ---------- Tag: CHECK_AVAILABILITY ----------
    if (tag === "CHECK_AVAILABILITY") {
      const modalidade = sessionParams.modalidade || null;
      const dataISO = sessionParams.data || null;         // "YYYY-MM-DD"
      const hora = sessionParams.horas || null;           // "HH:MM" (teu parâmetro chama-se 'horas')
      const bairro = sessionParams.bairro || "";
      const idade = sessionParams.idade || null;

      const ok = temHorario(modalidade, dataISO, hora);
      const base = precoBase(modalidade);
      const total = aplicaDescontos(base, bairro, idade);

      // devolve parâmetros para o CX usar nas rotas ($session.params.is_available etc.)
      return res.json({
        session_info: {
          parameters: {
            is_available: ok,
            preco_base: base,
            preco_total: total
          }
        },
        fulfillment_response: {
          messages: [
            { text: { text: [ ok
              ? "✅ Há vaga nesse horário."
              : "❌ Não tenho vaga nesse horário. Queres tentar outro dia/hora?"
            ] } }
          ]
        }
      });
    }

    // ---------- Qualquer outra tag não tratada ----------
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

// Porta do Railway/Render/etc.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook Yoga Kula a correr na porta ${PORT}`));
