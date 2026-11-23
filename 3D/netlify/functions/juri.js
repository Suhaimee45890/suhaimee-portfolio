async function fetchWithTimeout(url, options, timeoutMs = 6000) {
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

    const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();
    const azureSpeechKey = (process.env.AZURE_SPEECH_KEY || "").trim();
    const azureSpeechRegion = (process.env.AZURE_SPEECH_REGION || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    const customVoice = (process.env.AZURE_SPEECH_VOICE || "").trim();
    const customStyle = (process.env.AZURE_SPEECH_STYLE || "curious").trim();

    let rawReply = speakOnlyText;

    // โหมดถาม-ตอบอัจฉริยะผ่าน Gemini (ข้ามขั้นตอนนี้หากเป็นสคริปต์ปุ่มกดสำเร็จรูป)
    if (!rawReply) {
      if (!message) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Message is required" }) };
      }
      if (!geminiApiKey) {
        throw new Error("MISSING GEMINI KEY");
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

      const contents = [
        ...history
          .filter((item) => item && typeof item.text === "string" && item.text.trim())
          .map((item) => ({
            role: item.role === "user" ? "user" : "model",
            parts: [{ text: item.text.trim() }],
          })),
        { role: "user", parts: [{ text: message }] },
      ];

      const models = Array.from(
        new Set(
          [
            (process.env.GEMINI_MODEL || "").trim(),
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash",
            "gemini-3.1-flash-lite-preview",
            "gemini-3-flash-preview",
            "gemini-flash-latest",
          ].filter(Boolean)
        )
      ); } else {
            lastGeminiError = `GEMINI ${geminiRes.status}`;
            console.error("Gemini Error:", model, geminiRes.status, geminiData.error?.message);
            if (geminiRes.status === 503 || geminiRes.status === 429) {
              await new Promise((r) => setTimeout(r, 400));
            }
          }
      let lastGeminiError = "Gemini API error";

      for (const model of models) {
        try {
          const geminiRes = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents,
                generationConfig: { temperature: 0.65, maxOutputTokens: 500 },
              }),
            },
            5500
          );

          const geminiData = await geminiRes.json();
          if (geminiRes.ok) {
            rawReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (rawReply) break;
          } else {
            lastGeminiError = `GEMINI ${geminiRes.status}`;
            console.error("Gemini Error:", model, geminiRes.status, geminiData.error?.message);
          }
        } catch (err) {
          lastGeminiError = err.name === "AbortError" ? "GEMINI TIMEOUT" : "GEMINI NET ERR";
        }
      }

      if (!rawReply) {
        throw new Error(lastGeminiError);
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
