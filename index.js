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
  const tag = req.body.fulfillmentInfo?.tag || null;

  if (tag === "GPT_FALLBACK") {
    const perguntaCliente = req.body.text || req.body.sessionInfo?.parameters?.ultima_mensagem || "Pergunta não fornecida";

    try {
      // Chamada à API GPT-4
      const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            { role: "system", content: "Tu és um assistente útil e simpático." },
            { role: "user", content: criarPrompt(perguntaCliente) }
          ],
          max_tokens: 500,
          temperature: 0.7
        })
      });

      const data = await gptResp.json();
      const resposta = data.choices?.[0]?.message?.content || "Não consegui encontrar a resposta.";

      return res.json({
        fulfillment_response: {
          messages: [
            { text: { text: [resposta] } }
          ]
        }
      });

    } catch (error) {
      console.error(error);
      return res.json({
        fulfillment_response: {
          messages: [
            { text: { text: ["Ocorreu um erro ao tentar responder."] } }
          ]
        }
      });
    }
  }

  // Se não for a tag GPT_FALLBACK
  return res.json({
    fulfillment_response: {
      messages: [
        { text: { text: ["Tag desconhecida."] } }
      ]
    }
  });
});

app.listen(8080, () => console.log("Servidor webhook rodando na porta 8080"));
