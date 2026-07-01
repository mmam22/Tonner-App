const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const { getStorage } = require("firebase-admin/storage");

const openaiKey = defineSecret("OPENAI_API_KEY");
const elevenlabsKey = defineSecret("ELEVENLABS_API_KEY");

function normalizeSkuCandidate(text) {
  if (!text) return "";

  const stopWords = [
    "TONER",
    "TONERS",
    "CARTRIDGE",
    "CARTRIDGES",
    "UNIT",
    "UNITS",
    "GALLON",
    "GALLONS",
    "ITEM",
    "ITEMS",
    "PLEASE",
    "THE",
    "A",
    "AN"
  ];

  let cleaned = String(text).toUpperCase().trim();

  cleaned = cleaned.replace(/[^A-Z0-9]/g, " ");
  cleaned = cleaned.replace(/\bM\s+M\b/g, "MM");

  for (const word of stopWords) {
    const re = new RegExp(`\\b${word}\\b`, "g");
    cleaned = cleaned.replace(re, " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  const skuLikeMatch = cleaned.match(/\b[A-Z]{1,4}\d{1,6}[A-Z0-9]*\b/);
  if (skuLikeMatch) {
    return skuLikeMatch[0];
  }

  return cleaned.replace(/\s+/g, "");
}

function extractSkuFromParams(params = {}) {
  return (
    params.resolved_sku ||
    params.sku ||
    params.item_spoken ||
    params.item ||
    params.code ||
    params.product ||
    ""
  );
}

function findBestSkuMatch(input, inventoryItems = []) {
  if (!input || !Array.isArray(inventoryItems) || inventoryItems.length === 0) {
    return null;
  }

  const normalizedInput = normalizeSkuCandidate(input);
  if (!normalizedInput) return null;

  const compactInput = normalizedInput.replace(/\s+/g, "");

  const items = inventoryItems
    .map((item) => {
      const sku = String(item?.sku || item?.code || "").toUpperCase().trim();
      const barcode = String(item?.barcode || "").toUpperCase().trim();

      const normalizedSku = normalizeSkuCandidate(sku);
      const normalizedBarcode = normalizeSkuCandidate(barcode);

      return {
        originalSku: sku,
        normalizedSku,
        compactSku: normalizedSku.replace(/\s+/g, ""),
        barcode,
        normalizedBarcode,
        compactBarcode: normalizedBarcode.replace(/\s+/g, "")
      };
    })
    .filter((item) => item.originalSku);

  const exactSku = items.find((item) => item.normalizedSku === normalizedInput);
  if (exactSku) return exactSku.originalSku;

  const compactSku = items.find((item) => item.compactSku === compactInput);
  if (compactSku) return compactSku.originalSku;

  const exactBarcode = items.find((item) => item.normalizedBarcode === normalizedInput);
  if (exactBarcode) return exactBarcode.originalSku;

  const compactBarcode = items.find((item) => item.compactBarcode === compactInput);
  if (compactBarcode) return compactBarcode.originalSku;

  if (/^\d{2,6}$/.test(compactInput)) {
    const suffixMatches = items.filter((item) => {
      const suffix = item.compactSku.match(/\d+$/)?.[0];
      return suffix === compactInput;
    });

    if (suffixMatches.length === 1) {
      return suffixMatches[0].originalSku;
    }

    if (suffixMatches.length > 1) {
      return null;
    }
  }

  const startsWithSku = items.find((item) => item.compactSku.startsWith(compactInput));
  if (startsWithSku) return startsWithSku.originalSku;

  const containsSku = items.find((item) => item.compactSku.includes(compactInput));
  if (containsSku) return containsSku.originalSku;

  return null;
}

exports.voiceCommand = onCall(
  { secrets: [openaiKey] },
  async (request) => {
    try {
      const {
        transcript,
        lines = [],
        suppliers = [],
        inventoryItems = []
      } = request.data || {};

      if (!transcript) {
        throw new HttpsError("invalid-argument", "Missing transcript");
      }

      const { OpenAI } = require("openai");
      const openai = new OpenAI({ apiKey: openaiKey.value() });

      const validSkus = Array.isArray(inventoryItems)
        ? inventoryItems
            .map((item) => item?.sku || item?.code || "")
            .filter(Boolean)
        : [];

      const prompt = `
You are an inventory assistant for a toner cartridge inventory app.

Paint lines:
${JSON.stringify(lines || [])}

Valid inventory items:
${JSON.stringify(inventoryItems || [])}

Valid SKU codes:
${JSON.stringify(validSkus)}

Suppliers:
${JSON.stringify(suppliers || [])}

Rules:
- Return ONLY valid JSON.
- Return an object with "intent" and "params".
- Keep params minimal and structured.
- SKU codes are usually short alphanumeric values like L60, K54, or MM903.
- If the user says "L60 toners", "L60 cartridges", "K54 gallons", or similar, the sku should be just the code part like "L60" or "K54".
- DeBeer-style codes may start with letters followed by numbers, like MM903.
- If the user says a likely partial code such as "903", prefer the matching full SKU from the valid inventory items list when it is unambiguous.
- If the user says only a short code fragment like "903" and it likely refers to a real SKU, still use intent "query_stock" and put that fragment in params.sku.
- Do not include words like toner, toners, cartridge, cartridges, gallon, gallons, unit, units in the sku field.
- For stock queries use intent "query_stock" and include params.sku when possible.
- For shipping use intent "ship_item" with params.sku and params.quantity.
- For receiving use intent "receive_item" with params.sku and params.quantity.
- For navigation use intent "navigate_to_tab" with params.tab.
- If unsure, still extract the most likely SKU phrase into params.sku.
- Prefer SKUs that exist in the valid inventory items list.
- If no intent fits, use "unknown".

Allowed intents:
query_stock
list_low_stock
total_inventory_value
ship_item
receive_item
navigate_to_tab
open_receive_modal
open_outgoing_modal
export_csv
print_report
help
unknown
`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: transcript }
        ],
        response_format: { type: "json_object" }
      });

      const parsed = JSON.parse(completion.choices[0].message.content || "{}");
      let intent = parsed.intent || "unknown";
      let params =
        parsed.params && typeof parsed.params === "object" ? parsed.params : {};

      let rawSku = extractSkuFromParams(params);
      if (!rawSku) {
        rawSku = transcript;
      }

      let normalizedSku = normalizeSkuCandidate(rawSku);
      let resolvedSku = findBestSkuMatch(rawSku, inventoryItems);

      if (intent === "unknown" && resolvedSku) {
        intent = "query_stock";
        params = {
          ...params,
          sku: resolvedSku
        };
      }

      if (rawSku) {
        params.item_spoken = rawSku;
        params.normalized_sku = normalizedSku;
      }

      if (resolvedSku) {
        params.resolved_sku = resolvedSku;
        params.sku = resolvedSku;
      }

      return {
        intent,
        params
      };
    } catch (error) {
      console.error("voiceCommand error:", error);
      throw new HttpsError("internal", "voiceCommand failed");
    }
  }
);

exports.speak = onCall(
  { secrets: [elevenlabsKey] },
  async (request) => {
    try {
      const { text } = request.data || {};
      const https = require("https");

      if (!text) {
        throw new HttpsError("invalid-argument", "Missing text");
      }

      const postData = JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      });

      const audioBuffer = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "api.elevenlabs.io",
            path: "/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
            method: "POST",
            headers: {
              "xi-api-key": elevenlabsKey.value(),
              "Content-Type": "application/json"
            }
          },
          (res) => {
            const chunks = [];

            res.on("data", (chunk) => chunks.push(chunk));

            res.on("end", () => {
              const buffer = Buffer.concat(chunks);

              if (res.statusCode < 200 || res.statusCode >= 300) {
                console.error("ElevenLabs error:", buffer.toString());
                reject(new HttpsError("internal", "TTS provider failed"));
                return;
              }

              resolve(buffer);
            });
          }
        );

        req.on("error", (err) => {
          console.error("speak error:", err);
          reject(new HttpsError("internal", "Speech generation failed"));
        });

        req.write(postData);
        req.end();
      });

      // Upload to Storage instead of returning base64
      const bucket = getStorage().bucket();
      const fileName = `voice-responses/${uuidv4()}.mp3`;
      const file = bucket.file(fileName);

      await file.save(audioBuffer, {
        metadata: {
          contentType: "audio/mpeg",
          cacheControl: "public, max-age=300"
        }
      });

      const [audioUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 10 * 60 * 1000
      });

      return { audioUrl };
    } catch (error) {
      console.error("speak error:", error);
      throw new HttpsError("internal", "Speech generation failed");
    }
  }
);

exports.cleanupVoiceResponses = onSchedule(
  "every 24 hours",
  async () => {
    const bucket = getStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: "voice-responses/" });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    await Promise.all(
      files
        .filter((f) => new Date(f.metadata.timeCreated).getTime() < cutoff)
        .map((f) => f.delete())
    );
  }
);