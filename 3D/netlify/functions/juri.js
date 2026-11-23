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
    const { message, history = [] } = JSON.parse(event.body || "{}");
    if (!message) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Message is required" }),
      };
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    const azureSpeechKey = process.env.AZURE_SPEECH_KEY;
    const azureSpeechRegion = process.env.AZURE_SPEECH_REGION || "southeastasia";

    if (!geminiApiKey) {
      throw new Error("Missing GEMINI_API_KEY in environment variables");
    }

    // 1. สร้างคำตอบข้อความจาก Gemini
    const systemInstruction = `You are JURI AI, the intelligent 3D portfolio assistant for Suhaimee Jehhae (ซูฮัยมี เจะแฮ / เบิ้ม), an MES Engineer & Cybersecurity specialist. Answer concisely, clearly, and politely in the same language as the user (Thai or English). Avoid markdown symbols like *, #, or bullet points so the text reads smoothly when spoken aloud.`;

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

    // ล้างสัญลักษณ์ Markdown ออกเพื่อให้เสียงอ่านเป็นธรรมชาติ
    const cleanTextForSpeech = rawReply
      .replace(/[*#_`~>-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 2. สังเคราะห์เสียงพูดด้วย Microsoft Azure Speech
    let audioBase64 = null;

    if (azureSpeechKey && cleanTextForSpeech) {
      const hasThai = /[\u0E00-\u0E7F]/.test(cleanTextForSpeech);
      const lang = hasThai ? "th-TH" : "en-US";
      const voiceName = hasThai
        ? "th-TH-NiwatNeural"
        : "en-US-AndrewMultilingualNeural";

      const escapedText = cleanTextForSpeech
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

      const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${voiceName}'>${escapedText}</voice></speak>`;

      const ttsRes = await fetch(
        `https://${azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": azureSpeechKey,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "JuriAIPortfolio",
          },
          body: ssml,
        }
      );

      if (ttsRes.ok) {
        const audioBuffer = await ttsRes.arrayBuffer();
        audioBase64 = Buffer.from(audioBuffer).toString("base64");
      } else {
        const errText = await ttsRes.text();
        console.error("Azure TTS Error:", ttsRes.status, errText);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: rawReply,
        audioBase64,
        mimeType: "audio/mp3",
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
