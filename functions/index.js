const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const openaiKey = defineSecret("OPENAI_API_KEY");
const elevenlabsKey = defineSecret("ELEVENLABS_API_KEY");

exports.voiceCommand = onCall(
  { secrets: [openaiKey] },
  async (request) => {
    const { transcript, lines, suppliers } = request.data;
    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey: openaiKey.value() });

    const prompt = `You are an inventory assistant. Lines: ${JSON.stringify(lines)}. Suppliers: ${JSON.stringify(suppliers)}.
Convert speech to JSON with "intent" and "params".
Intents: query_stock(sku), list_low_stock(), total_inventory_value(), ship_item(sku,quantity), receive_item(sku,quantity), navigate_to_tab(tab), open_receive_modal(), open_outgoing_modal(), export_csv(), print_report(), help(), unknown(reason)
Return ONLY JSON.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }, { role: "user", content: transcript }],
      response_format: { type: "json_object" }
    });

    return JSON.parse(completion.choices[0].message.content);
  }
);

exports.speak = onCall(
  { secrets: [elevenlabsKey] },
  async (request) => {
    const { text } = request.data;
    const https = require("https");

    const postData = JSON.stringify({
      text: text,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });

    const options = {
      hostname: "api.elevenlabs.io",
      path: "/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
      method: "POST",
      headers: {
        "xi-api-key": elevenlabsKey.value(),
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ audio: buffer.toString("base64") });
        });
      });
      req.on("error", (e) => reject(e));
      req.write(postData);
      req.end();
    });
  }
);