async function fetchWithTimeout(url, options, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function forceThaiPhonetics(text) {
  const dict = [
    [/\bJ\.?A\.?R\.?V\.?I\.?S\.?\b/gi, "จาร์วิส"],
    [/\bJuri\b/gi, "จูรี"],
    [/\bAI\b/gi, "เอไอ"],
    [/\b3D\b/gi, "สามมิติ"],
    [/\bMES\b/gi, "เอ็มอีเอส"],
    [/\bEAM\b/gi, "อีเอเอ็ม"],
    [/\bWES\b/gi, "ดับเบิลยูอีเอส"],
    [/\bSQL\b/gi, "เอสคิวแอล"],
    [/\bOT\b/gi, "โอที"],
    [/\bCybersecurity\b/gi, "ไซเบอร์ซีเคียวริตี้"],
    [/\bGyroscope\b/gi, "ไจโรสโคป"],
    [/\bGimbal\b/gi, "กิมบอล"],
    [/\bTurbofan\b/gi, "เทอร์โบแฟน"],
    [/\bHigh-Bypass\b/gi, "ไฮบายพาส"],
    [/\bDirect Impingement\b/gi, "ไดเรกต์ อิมพินจ์เมนต์"],
    [/\bM16A4\b/gi, "เอ็มสิบหกเอสี่"],
    [/\bPSI\b/gi, "ปอนด์ต่อตารางนิ้ว"],
    [/\bREEV\b/gi, "อาร์อีอีวี"],
    [/\bPowertrain\b/gi, "พาวเวอร์เทรน"],
    [/\bInverse Kinematics\b/gi, "อินเวิร์ส คิเนมาติกส์"],
    [/\bRobotics\b/gi, "โรโบติกส์"],
    [/\bBackwash\b/gi, "แบ็กวอช"],
    [/\bEXPLODE\b/gi, "แยกชิ้นส่วน"],
    [/\bINSPECT\b/gi, "ตรวจสอบระบบ"],
    [/\bIndustry 4\.0\b/gi, "อุตสาหกรรมสี่จุดศูนย์"],
  ];

  let out = String(text || "");
  for (const [pattern, thaiWord] of dict) {
    out = out.replace(pattern, thaiWord);
  }

  return out
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g, "")
    .replace(/[A-Za-z]/g, " ")
    .replace(/[*#_`~>•—–\-()[\]{}"'«»:/\\|]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSsml(cleanText, voiceName, styleName = "Default") {
  const isMaiVoice = voiceName.includes("MAI-Voice");
  const rate = isMaiVoice ? "+0%" : "-8%";
  const pitch = "+0%";

  const escaped = cleanText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const sentences = escaped
    .split(/(?<=ครับ)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const structuredBody =
    sentences.length > 1
      ? sentences.map((s) => `<s>${s}</s>`).join("")
      : escaped;

  const useExpressStyle =
    isMaiVoice && styleName && styleName.toLowerCase() !== "default";

  const innerContent = useExpressStyle
    ? `<mstts:express-as style='${styleName}'><prosody rate='${rate}' pitch='${pitch}'>${structuredBody}</prosody></mstts:express-as>`
    : `<prosody rate='${rate}' pitch='${pitch}'>${structuredBody}</prosody>`;

  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='th-TH'><voice name='${voiceName}'>${innerContent}</voice></speak>`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  try {
    const speakOnlyText = (body.speakOnlyText || "").trim();
    const message = (body.message || body.prompt || body.text || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
    const catalogFromClient = Array.isArray(body.catalog) ? body.catalog.slice(0, 12) : [];

    const openrouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
    const dashscopeKey = (process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "").trim();
    const customBaseUrl = (process.env.QWEN_BASE_URL || "").trim().replace(/\/+$/, "");
    const customQwenModel = (process.env.QWEN_MODEL || "").trim();

    const azureSpeechKey = (process.env.AZURE_SPEECH_KEY || "").trim();
    const azureSpeechRegion = (process.env.AZURE_SPEECH_REGION || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    const customVoice = (process.env.AZURE_SPEECH_VOICE || "").trim();
    const customStyle = (process.env.AZURE_SPEECH_STYLE || "Default").trim();

    let rawReply = speakOnlyText;

    if (!rawReply) {
      if (!message) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Message is required" }) };
      }

      const defaultCatalogText = [
        "01 เครื่องยนต์ไฮบายพาส เทอร์โบแฟน อัตราส่วนบายพาส 10.5 ต่อ 1 ประหยัดเชื้อเพลิงและเสียงเงียบ",
        "02 กลไกส่งแก๊สโดยตรง เอ็มสิบหกเอสี่ แรงดันสูงสุด 55,000 ปอนด์ต่อตารางนิ้ว ลูกเลื่อน 7 เขี้ยวขัดกลอน",
        "03 ระบบขับเคลื่อนรถยนต์ไฟฟ้าขยายระยะทาง อาร์อีอีวี บัสแรงดันสูง 400 โวลต์ ขับเคลื่อนล้อด้วยมอเตอร์ไฟฟ้า 100 เปอร์เซ็นต์",
        "04 แขนกลอุตสาหกรรม 6 แกน คำนวณจลนศาสตร์ผกผันแม่นยำบวกลบ 0.02 มิลลิเมตร",
        "05 แบบจำลองระบบหัวใจและปอด แสดงการสูบฉีดเลือดสัมพันธ์กับการแลกเปลี่ยนออกซิเจน",
        "06 ถังกรองน้ำแรงดันสูง 4 ชั้นสารกรอง พร้อมวาล์วสลับโหมดล้างย้อนกลับ"
      ].join("\n");

      const dynamicCatalogText = catalogFromClient.length > 0
        ? catalogFromClient
            .map((p) => `${p.code || p.id} ${p.title}: ${p.specs || p.brief || ""}`)
            .join("\n")
        : defaultCatalogText;

      const systemInstruction = `คุณคือ "จูรี" ผู้ช่วยวิศวกรรมประจำพอร์ตโฟลิโอสามมิติของ "เสี่ยเบิ้ม" (ซูฮัยมี เจะแฮ วิศวกรระบบเอ็มอีเอสและไซเบอร์ซีเคียวริตี้)
กฎการตอบ:
1. ตอบภาษาไทยล้วน 100 เปอร์เซ็นต์ ห้ามมีอักษรอังกฤษ จีน หรือสัญลักษณ์พิเศษ ศัพท์เทคนิคให้เขียนคำอ่านไทยทั้งหมด
2. พูดสุภาพ สุขุม แบบผู้ช่วยวิศวกร สอดแทรกหลักฟิสิกส์สั้นๆ ความยาว 2 ถึง 3 ประโยค ลงท้ายด้วย "ครับ" เสมอ
3. โมเดลหลักหน้าแรกคือ ชุดไจโรสโคปสามแกน คลังผลงานมีดังนี้:
${dynamicCatalogText}
หากถามเรื่องนอกเหนือจากนี้ ให้ตอบว่า "รับทราบครับ ตอนนี้ผมดูแลข้อมูลของระบบทั้งหมดในคลังและชุดไจโรสโคปหลักอยู่ครับ ลองระบุหมายเลขระบบเพื่อให้ผมอธิบายได้เลยครับ"`;

      const messages = [
        { role: "system", content: systemInstruction },
        ...history
          .filter((item) => item && typeof item.text === "string" && item.text.trim())
          .map((item) => ({
            role: item.role === "user" ? "user" : "assistant",
            content: item.text.trim(),
          })),
        { role: "user", content: message },
      ];

      const attempts = [];

      if (openrouterKey) {
        const orModels = Array.from(
          new Set(
            [
              customQwenModel,
              "qwen/qwen-turbo",
              "qwen/qwen-plus",
              "openrouter/free",
            ].filter(Boolean)
          )
        );
        for (const m of orModels) {
          attempts.push({
            url: "https://openrouter.ai/api/v1/chat/completions",
            key: openrouterKey,
            model: m,
            extraHeaders: {
              "HTTP-Referer": "https://suhaimejehhae.studio",
              "X-Title": "Juri 3D Portfolio",
            },
          });
        }
      }

      if (dashscopeKey) {
        const baseUrl = customBaseUrl || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
        const aliModels = Array.from(
          new Set(
            [
              customQwenModel,
              "qwen-turbo",
              "qwen-plus",
            ].filter(Boolean)
          )
        );
        for (const m of aliModels) {
          attempts.push({
            url: `${baseUrl}/chat/completions`,
            key: dashscopeKey,
            model: m,
            extraHeaders: {},
          });
        }
      }

      if (attempts.length === 0) {
        throw new Error("MISSING QWEN KEY");
      }

      let lastQwenError = "QWEN ERROR";

      for (const item of attempts) {
        try {
          const qwenRes = await fetchWithTimeout(
            item.url,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${item.key}`,
                "Content-Type": "application/json",
                ...item.extraHeaders,
              },
              body: JSON.stringify({
                model: item.model,
                messages,
                temperature: 0.5,
                max_tokens: 280,
              }),
            },
            4500
          );

          const qwenData = await qwenRes.json().catch(() => ({}));
          if (qwenRes.ok) {
            rawReply = qwenData.choices?.[0]?.message?.content || "";
            if (rawReply) break;
          } else {
            lastQwenError = `QWEN ${qwenRes.status}`;
            console.error("Qwen Error:", item.model, qwenRes.status, qwenData.error?.message || qwenData.message);
          }
        } catch (err) {
          lastQwenError = err.name === "AbortError" ? "QWEN TIMEOUT" : "QWEN NET ERR";
        }
      }

      if (!rawReply) {
        throw new Error(lastQwenError);
      }
    }

    const cleanText = forceThaiPhonetics(rawReply);
    let audioBase64 = null;
    let ttsError = null;
    let voiceUsed = null;

    if (!azureSpeechKey || !azureSpeechRegion) {
      ttsError = !azureSpeechKey ? "MISSING AZURE KEY" : "MISSING REGION";
    } else if (cleanText) {
      const voiceCandidates = Array.from(
        new Set(
          [
            customVoice,
            "th-TH-Nattapong:MAI-Voice-2.1",
            "th-TH-NiwatNeural",
          ].filter(Boolean)
        )
      );

      for (const voiceName of voiceCandidates) {
        try {
          const ssml = buildSsml(cleanText, voiceName, customStyle);
          const ttsRes = await fetchWithTimeout(
            `https://${azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
            {
              method: "POST",
              headers: {
                "Ocp-Apim-Subscription-Key": azureSpeechKey,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
                "User-Agent": "JuriAIPortfolio",
              },
              body: ssml,
            },
            4500
          );

          if (ttsRes.ok) {
            const audioBuffer = await ttsRes.arrayBuffer();
            audioBase64 = Buffer.from(audioBuffer).toString("base64");
            voiceUsed = voiceName;
            ttsError = null;
            break;
          } else {
            const errText = await ttsRes.text();
            ttsError = `AZURE ${ttsRes.status} (${voiceName})`;
            console.error(`Azure TTS Error [${voiceName}]:`, ttsRes.status, errText);
          }
        } catch (err) {
          ttsError = err.name === "AbortError" ? "AZURE TIMEOUT" : "AZURE NET ERR";
          console.error(`Azure TTS Exception [${voiceName}]:`, err.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: rawReply,
        audioBase64,
        voiceUsed,
        ttsError,
        mimeType: "audio/mpeg",
      }),
    };
  } catch (error) {
    console.error("Function Error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
