async function fetchWithTimeout(url, options, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeForSpeech(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[*#_`~>•]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSsml(cleanText, voiceName, styleName = "curious") {
  const isMaiVoice = voiceName.includes("MAI-Voice");
  const rate = isMaiVoice ? "-4%" : "-12%";
  const pitch = isMaiVoice ? "+0%" : "+2%";

  const escaped = cleanText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\s*—\s*/g, ' <break time="260ms"/> ')
    .replace(/([.!?])\s+/g, '$1 <break time="200ms"/> ')
    .replace(/,\s+/g, ', <break time="140ms"/> ');

  const innerContent = isMaiVoice
    ? `<mstts:express-as style='${styleName}'><prosody rate='${rate}' pitch='${pitch}'>${escaped}</prosody></mstts:express-as>`
    : `<prosody rate='${rate}' pitch='${pitch}'>${escaped}</prosody>`;

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

    // คีย์สำหรับ Qwen (รองรับทั้ง OpenRouter และ Alibaba Cloud Model Studio)
    const openrouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
    const dashscopeKey = (process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "").trim();
    const customBaseUrl = (process.env.QWEN_BASE_URL || "").trim().replace(/\/+$/, "");
    const customQwenModel = (process.env.QWEN_MODEL || "").trim();

    // คีย์สำหรับ Azure Speech
    const azureSpeechKey = (process.env.AZURE_SPEECH_KEY || "").trim();
    const azureSpeechRegion = (process.env.AZURE_SPEECH_REGION || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    const customVoice = (process.env.AZURE_SPEECH_VOICE || "").trim();
    const customStyle = (process.env.AZURE_SPEECH_STYLE || "curious").trim();

    let rawReply = speakOnlyText;

    // โหมดถาม-ตอบอัจฉริยะผ่าน Qwen
    if (!rawReply) {
      if (!message) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Message is required" }) };
      }

      const defaultCatalogText = [
        "- ระบบที่ 01 High-Bypass Turbofan Engine: เครื่องยนต์เทอร์โบแฟนอัตราส่วนบายพาสสูง 10.5:1 อากาศส่วนใหญ่ไหลผ่านช่องบายพาสสร้างแรงขับหลัก ประหยัดเชื้อเพลิงและเสียงเงียบ",
        "- ระบบที่ 02 M16A4 Direct Impingement System: กลไกส่งแก๊สโดยตรง แรงดันสูงสุด 55,000 PSI ทำงานครบวงจร 8 ขั้นตอน ลูกเลื่อน 7 เขี้ยวขัดกลอน",
        "- ระบบที่ 03 REEV Series Powertrain: รถยนต์ไฟฟ้าขยายระยะทาง บัสแรงดันสูง 400V เครื่องยนต์ปั่นไฟเข้าแบตเตอรี่ ขับเคลื่อนล้อด้วยมอเตอร์ไฟฟ้า 100%",
        "- ระบบที่ 04 6-Axis Industrial Robotics Cell: แขนกลอุตสาหกรรม 6 แกน คำนวณ Inverse Kinematics แม่นยำบวกลบ 0.02 มิลลิเมตร",
        "- ระบบที่ 05 Cardiopulmonary Bio-System: แบบจำลองการทำงานร่วมกันของหัวใจและปอด แสดงการสูบฉีดเลือดสัมพันธ์กับการแลกเปลี่ยนออกซิเจนแบบเรียลไทม์",
        "- ระบบที่ 06 4-Layer Multi-Media Water Filter: ถังกรองน้ำแรงดันสูง 4 ชั้นสารกรอง เรียงตามความถ่วงจำเพาะ พร้อมวาล์วสลับโหมดล้างย้อนกลับ (Backwash)"
      ].join("\n");

      const dynamicCatalogText = catalogFromClient.length > 0
        ? catalogFromClient
            .map((p) => `- ${p.code || p.id} ${p.title}: ${p.specs || p.brief || ""}`)
            .join("\n")
        : defaultCatalogText;

      const systemInstruction = `คุณคือ "Juri" (จูริ) ระบบวิเคราะห์กลไกและปัญญาประดิษฐ์ผู้ช่วยส่วนตัวประจำคลังผลงาน 3D ของ "เสี่ยเบิ้ม" หรือ "คุณเบิ้ม" (ซูฮัยมี เจะแฮ / Suhaimee Jehhae)

[บุคลิกและสไตล์การพูด - J.A.R.V.I.S. Persona]
1. สุภาพ สุขุม เฉลียวฉลาด มีชั้นเชิงแบบจาร์วิส ลงท้ายด้วย "ครับ" เสมอ
2. เปิดประโยคโต้ตอบให้ดูมีชีวิตชีวาและกำลังประมวลผลระบบจริง เช่น "รับทราบครับ ผมกำลังวิเคราะห์โครงสร้างแม่แบบนี้ให้อยู่ครับ...", "จากการประมวลผลข้อมูลทางวิศวกรรมในคลังของเสี่ยเบิ้ม...", "เป็นประเด็นที่น่าสนใจมากครับ จากแบบจำลองในระบบ..."
3. ตอบเป็นภาษาไทยที่ลื่นไหลเป็นธรรมชาติ (ใช้ศัพท์เทคนิคภาษาอังกฤษได้ตามความเหมาะสม) ความยาวกระชับ 2 ถึง 4 ประโยคเพื่อให้อ่านออกเสียงได้น่าฟัง ห้ามใช้เครื่องหมาย Markdown, ดอกจัน, อิโมจิ หรือหัวข้อย่อยเด็ดขาด

[ข้อมูลจริงของเจ้าของคลังผลงาน - ห้ามแต่งเติมหรือมั่วเด็ดขาด]
- เจ้าของผลงาน: ซูฮัยมี เจะแฮ (Suhaimee Jehhae / เสี่ยเบิ้ม / คุณเบิ้ม)
- สายงาน: วิศวกรระบบ MES (Manufacturing Execution System Engineer) เชี่ยวชาญระบบในโรงงานอุตสาหกรรม (MES, EAM, WES, SQL, เครื่องมือทดสอบทางไฟฟ้า) และกำลังศึกษาต่อยอดด้านวิศวกรรมคอมพิวเตอร์และความมั่นคงปลอดภัยไซเบอร์ (Cybersecurity & OT Security)
- พื้นฐานและใบรับรอง: ปวส. เมคคาทรอนิกส์และหุ่นยนต์ (วิทยาลัยเทคนิคยะลา), Certificate IV in Business & Management (Greystone College ออสเตรเลีย), ปริญญาตรี วิศวกรรมคอมพิวเตอร์ สาขา Cybersecurity (สถาบันการจัดการปัญญาภิวัฒน์), ผ่านการรับรอง NCSA Cybersecurity Professional ระดับสูง และ OPSWAT ICIP
- โมเดลหลัก (Hero 3D): ชุดไจโรสโคป 3 แกน (3-Axis Gimbal Gyroscope) รองรับคำสั่ง EXPLODE 3D แยกวงแหวนตามแนวแกน Z เพื่อดูแกนเซนเซอร์กลาง

[รายการระบบทั้งหมดในคลังผลงานปัจจุบัน]
${dynamicCatalogText}

[การให้ความรู้เชิงลึกและกฎป้องกันการมั่วข้อมูล]
- ห้ามแค่อ่านข้อความหน้าเว็บทื่อๆ ให้สอดแทรกหลักฟิสิกส์ (เช่น โมเมนตัมเชิงมุม เทอร์โมไดนามิกส์ พลศาสตร์ของไหล จลนศาสตร์) ประวัติศาสตร์วิศวกรรม และเทรนด์อนาคต (เช่น Industry 4.0, OT Security, พลังงานสะอาด, หุ่นยนต์อัจฉริยะ) เพื่อยกระดับความรู้ให้ผู้เยี่ยมชม
- ห้ามแต่งเรื่องหรือสเปกส่วนตัวที่ไม่มีในข้อมูลนี้ หากถูกถามเรื่องนอกเหนือขอบเขต ให้ตอบสุภาพแบบจาร์วิสว่า "รับทราบครับ ตอนนี้ผมคุมข้อมูลของระบบทั้งหมดในคลังและชุดไจโรสโคปหลักอยู่ครับ — ลองระบุหมายเลขระบบ หรือสั่งแยกชิ้นส่วน 3D เพื่อให้ผมโฟกัสและวิเคราะห์ให้ดูได้เลยครับ"`;

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

      // จัดเตรียมรายการ Endpoint + โมเดล Qwen ตาม Key ที่ตั้งไว้ใน Netlify
      const attempts = [];

      if (openrouterKey) {
       const orModels = Array.from(
       new Set(
         [
           customQwenModel,
           "qwen/qwen3-32b:free",
           "qwen/qwen-2.5-72b-instruct:free",
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
              "qwen3.8-flash",
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
                temperature: 0.65,
                max_tokens: 450,
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

    const cleanText = sanitizeForSpeech(rawReply);
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
