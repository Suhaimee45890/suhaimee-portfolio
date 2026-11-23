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
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const message = body.message || body.prompt || body.text || "";
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Message is required" }),
      };
    }

    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    const azureSpeechKey = process.env.AZURE_SPEECH_KEY?.trim();
    const azureSpeechRegion = process.env.AZURE_SPEECH_REGION
      ?.trim()
      .toLowerCase()
      .replace(/\s+/g, "");

    if (!geminiApiKey) {
      throw new Error("Missing GEMINI_API_KEY");
    }

    // 1. สร้างคำตอบจาก Gemini
    const systemInstruction = `You are JURI AI, the smart and approachable 3D portfolio assistant for Suhaimee Jehhae (ซูฮัยมี เจะแฮ / เบิ้ม), an MES Engineer & Cybersecurity specialist. Speak like a sharp, calm, friendly young tech professional. Answer concisely in the user's language (Thai or English). Do NOT use markdown symbols like *, #, -, or bullet lists so your response sounds smooth and natural when spoken aloud.`;

    const contents = [
      ...history.map((item) => ({
        role: item.role === "user" ? "user" : "model",
        parts: [{ text: item.text }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 350,
          },
        }),
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) {
      throw new Error(geminiData.error?.message || "Gemini API error");
    }

    const rawReply =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text ||
      "ขออภัยครับ ระบบไม่สามารถประมวลผลคำตอบได้ในขณะนี้";

    const cleanText = rawReply
      .replace(/[*#_`~>•-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 2. สร้างเสียงผู้ชาย นุ่ม วัยรุ่น ฉลาด ด้วย Microsoft Azure Speech
    let audioBase64 = null;
    let ttsStatus = "skipped";

    if (azureSpeechKey && azureSpeechRegion && cleanText) {
      const hasThai = /[\u0E00-\u0E7F]/.test(cleanText);
      const lang = hasThai ? "th-TH" : "en-US";
      const voiceName = hasThai
        ? "th-TH-NiwatNeural"
        : "en-US-AndrewMultilingualNeural";
      const pitch = hasThai ? "+6%" : "+2%";
      const rate = hasThai ? "+5%" : "+4%";

      const escapedText = cleanText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voiceName}'><prosody rate='${rate}' pitch='${pitch}'>${escapedText}</prosody></voice></speak>`;

      const ttsRes = await fetch(
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
        }
      );

      if (ttsRes.ok) {
        const audioBuffer = await ttsRes.arrayBuffer();
        audioBase64 = Buffer.from(audioBuffer).toString("base64");
        ttsStatus = "ok";
      } else {
        const errText = await ttsRes.text();
        ttsStatus = `azure_error_${ttsRes.status}`;
        console.error("Azure TTS Error:", ttsRes.status, errText);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: rawReply,
        text: rawReply,
        audioBase64,
        audio: audioBase64,
        mimeType: "audio/mpeg",
        ttsStatus,
      }),
    };
  } catch (error) {
    console.error("Function Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
