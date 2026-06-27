const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const openaiKey = defineSecret("OPENAI_API_KEY");

exports.voiceCommand = onCall(
  { secrets: [openaiKey] },
  async (request) => {
    const { transcript, lines, suppliers } = request.data;
    const { OpenAI } = require("openai");
    
    const openai = new OpenAI({ apiKey: openaiKey.value() });

    const prompt = `You are a toner inventory assistant. Paint lines: ${JSON.stringify(lines)}. Suppliers: ${JSON.stringify(suppliers)}.
Convert user speech to JSON with "intent" and "params".
Intents:
- query_stock(sku)
- list_low_stock()
- total_inventory_value()
- ship_item(sku, quantity)
- receive_item(sku, quantity)
- navigate_to_tab(tab)
- open_receive_modal()
- open_outgoing_modal()
- export_csv()
- print_report()
- help()
- unknown(reason)

Return ONLY JSON, no other text. Example: {"intent":"query_stock","params":{"sku":"TN-450"}}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: transcript }
      ],
      response_format: { type: "json_object" }
    });

    return JSON.parse(completion.choices[0].message.content);
  }
);