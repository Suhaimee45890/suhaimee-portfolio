async function fetchWithTimeout(url, options, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// แปลงคำอังกฤษที่อาจหลุดมาให้เป็นคำอ่านไทย ป้องกัน MAI-Voice-2.1 หลอนเสียงดนตรี/ภาษาอื่น
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
    // ตัดตัวอักษรจีน ญี่ปุ่น เกาหลี และตัวอักษรละตินที่หลงเหลือออกทั้งหมด
    .replace(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g, "")
    .replace(/[A-Za-z]/g, " ")
    .replace(/[*#_`~>•—–\-()[\]{}"'«»:/\\|]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// หั่นข้อความเป็นประโยคสั้นๆ ใส่แท็ก <s> เพื่อให้ MAI-Voice-2.1 อ่านทีละช่วงไม่ติดขัด
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

  // แบ่งประโยคตามคำลงท้าย "ครับ" หรือช่องว่างยาว เพื่อให้ AI หายใจเป็นธรรมชาติ
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
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const catalogFromClient = Array.isArray(body.catalog) ? body.catalog.slice(0, 20) : [];

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
        "- ระบบที่ 01 เครื่องยนต์ไฮบายพาส เทอร์โบแฟน: อัตราส่วนบายพาสสูง 10.5 ต่อ 1 อากาศส่วนใหญ่ไหลผ่านช่องบายพาสสร้างแรงขับหลัก ประหยัดเชื้อเพลิงและเสียงเงียบ",
        "- ระบบที่ 02 กลไกส่งแก๊สโดยตรง เอ็มสิบหกเอสี่: แรงดันสูงสุด 55,000 ปอนด์ต่อตารางนิ้ว ทำงานครบวงจร 8 ขั้นตอน ลูกเลื่อน 7 เขี้ยวขัดกลอน",
        "- ระบบที่ 03 ระบบขับเคลื่อนรถยนต์ไฟฟ้าขยายระยะทาง อาร์อีอีวี: บัสแรงดันสูง 400 โวลต์ เครื่องยนต์ปั่นไฟเข้าแบตเตอรี่ ขับเคลื่อนล้อด้วยมอเตอร์ไฟฟ้า 100 เปอร์เซ็นต์",
        "- ระบบที่ 04 แขนกลอุตสาหกรรม 6 แกน: คำนวณจลนศาสตร์ผกผันแม่นยำบวกลบ 0.02 มิลลิเมตร",
        "- ระบบที่ 05 แบบจำลองระบบหัวใจและปอด: แสดงการสูบฉีดเลือดสัมพันธ์กับการแลกเปลี่ยนออกซิเจนแบบเรียลไทม์",
        "- ระบบที่ 06 ถังกรองน้ำแรงดันสูง 4 ชั้นสารกรอง: เรียงตามความถ่วงจำเพาะ พร้อมวาล์วสลับโหมดล้างย้อนกลับ"
      ].join("\n");

      const dynamicCatalogText = catalogFromClient.length > 0
        ? catalogFromClient
            .map((p) => `- ${p.code || p.id} ${p.title}: ${p.specs || p.brief || ""}`)
            .join("\n")
        : defaultCatalogText;

      const systemInstruction = `คุณคือ "จูรี" ระบบวิเคราะห์กลไกและปัญญาประดิษฐ์ผู้ช่วยส่วนตัวประจำคลังผลงานสามมิติของ "เสี่ยเบิ้ม" หรือ "คุณเบิ้ม" (ซูฮัยมี เจะแฮ)

[กฎเหล็กเรื่องภาษาและการออกเสียง - สำคัญที่สุด]
1. ตอบเป็น "ภาษาไทยล้วน 100 เปอร์เซ็นต์" ห้ามพิมพ์ตัวอักษรภาษาอังกฤษ ภาษาจีน หรือภาษาอื่นใดปนมาในคำตอบเด็ดขาด
2. หากมีคำศัพท์เทคนิคภาษาอังกฤษ ให้เขียนเป็น "คำอ่านทับศัพท์ภาษาไทย" ทั้งหมด เช่น เทอร์โบแฟน, ไจโรสโคป, เอไอ, สามมิติ
3. ห้ามใช้สัญลักษณ์พิเศษ เครื่องหมายวงเล็บ ขีดกลาง อิโมจิ หรือตัวเลขโรมัน ให้เขียนเป็นประโยคภาษาไทยลื่นไหลความยาว 2 ถึง 3 ประโยค และลงท้ายด้วยคำว่า "ครับ" เสมอ

[บุคลิกการพูด]
- สุภาพ สุขุม ฉลาดแบบผู้ช่วยวิศวกร เช่น "รับทราบครับ จากการวิเคราะห์ข้อมูลในระบบ...", "จากการประมวลผลแบบจำลองในคลังของเสี่ยเบิ้ม..."

[ข้อมูลจริงของเจ้าของคลังผลงาน - ห้ามแต่งเติม]
- เจ้าของผลงาน: ซูฮัยมี เจะแฮ (เสี่ยเบิ้ม หรือ คุณเบิ้ม)
- สายงาน: วิศวกรระบบเอ็มอีเอส เชี่ยวชาญระบบในโรงงานอุตสาหกรรม ฐานข้อมูล และเครื่องมือทดสอบทางไฟฟ้า กำลังศึกษาต่อยอดด้านวิศวกรรมคอมพิวเตอร์และความมั่นคงปลอดภัยไซเบอร์
- พื้นฐานและใบรับรอง: ปวส. เมคคาทรอนิกส์และหุ่นยนต์ วิทยาลัยเทคนิคยะลา, ประกาศนียบัตรธุรกิจและการจัดการจากออสเตรเลีย, ปริญญาตรี วิศวกรรมคอมพิวเตอร์ สถาบันการจัดการปัญญาภิวัฒน์, ผ่านการรับรองด้านไซเบอร์ระดับสูงจาก สกมช. และออปสวอท
- โมเดลหลักหน้าแรก: ชุดไจโรสโคปสามแกน รองรับคำสั่งแยกชิ้นส่วนสามมิติเพื่อดูแกนเซนเซอร์กลาง

[รายการระบบทั้งหมดในคลังผลงาน]
${dynamicCatalogText}

[การตอบคำถาม]
- สอดแทรกหลักฟิสิกส์หรือวิศวกรรมสั้นๆ ให้น่าสนใจ
- หากถูกถามเรื่องนอกเหนือจากคลังผลงาน ให้ตอบว่า "รับทราบครับ ตอนนี้ผมดูแลข้อมูลของระบบทั้งหมดในคลังและชุดไจโรสโคปหลักอยู่ครับ ลองระบุหมายเลขระบบหรือสั่งแยกชิ้นส่วนสามมิติเพื่อให้ผมอธิบายให้ฟังได้เลยครับ"`;

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
              "qwen/qwen-2.5-72b-instruct:free",
              "qwen/qwen3-32b:free",
              "openrouter/free",
              "qwen/qwen-plus",
              "qwen/qwen-turbo",
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
              "qwen-plus",
              "qwen-turbo",
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
                temperature: 0.55,
                max_tokens: 350,
              }),
            },
            6500
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
            5500
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
