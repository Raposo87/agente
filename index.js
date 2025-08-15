// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// JSON fixo do Yoga Kula (poderia vir de uma DB)
import yogaData from "./yoga_kula.json" assert { type: "json" };

// Função para criar prompt contextual para GPT-4
function criarPrompt(pergunta) {
  return `
Tu és o assistente do estúdio Yoga Kula.
Usa apenas as informações abaixo para responder de forma clara, simpática e natural:

Dados do estúdio:
${JSON.stringify(yogaData, null, 2)}

Pergunta do cliente:
"${pergunta}"
`;
}

app.post("/webhook", async (req, res) => {
  console.log("📩 Chegou requisição do CX:", JSON.stringify(req.body, null, 2));

  return res.json({
    fulfillment_response: {
      messages: [{ text: { text: ["✅ Conexão CX ↔ Railway funcionando!"] } }]
    }
  });
});


  // Se não for a tag GPT_FALLBACK
  return res.json({
    fulfillment_response: {
      messages: [
        { text: { text: ["Tag desconhecida."] } }
      ]
    }
  });
app.listen(8080, () => console.log("Servidor webhook rodando na porta 8080"));
