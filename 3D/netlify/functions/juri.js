exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const speakOnlyText = (body.speakOnlyText || "").trim();
    const message = (body.message || body.prompt || body.text || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    const azureSpeechKey = process.env.AZURE_SPEECH_KEY?.trim();
    const azureSpeechRegion = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase().replace(/\s+/g, "");

    let rawReply = speakOnlyText;

    if (!rawReply) {
      if (!message) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Message is required" }) };
      }
      if (!geminiApiKey) {
        throw new Error("Missing GEMINI_API_KEY in Netlify Functions");
      }

      const systemInstruction = `You are JURI AI, the voice assistant for Suhaimee Jehhae's 3D Engineering & Cybersecurity portfolio (ซูฮัยมี เจะแฮ / เบิ้ม, MES Engineer & Cybersecurity specialist). Speak like a smart, warm, calm young tech guy. Reply strictly in 1 to 3 concise natural spoken sentences in the same language as the user (Thai or English). Never use markdown, symbols, or bullet points.`;

      const contents = [
        ...history.map((item) => ({
          role: item.role === "user" ? "user" : "model",
          parts: [{ text: item.text }],
        })),
        { role: "user", parts: [{ text: message }] },
      ];

      const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
      let lastGeminiError = "Gemini API error";

      for (const model of models) {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemInstruction }] },
              contents,
              generationConfig: { temperature: 0.7, maxOutputTokens: 280 },
            }),
          }
        );

        const geminiData = await geminiRes.json();
        if (geminiRes.ok) {
          rawReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (rawReply) break;
        } else {
          lastGeminiError = `[${model}] ${geminiData.error?.message || geminiRes.status}`;
          console.error("Gemini attempt failed:", lastGeminiError);
        }
      }

      if (!rawReply) {
        throw new Error(lastGeminiError);
      }
    }

    const cleanText = rawReply.replace(/[*#_`~>•-]/g, " ").replace(/\s+/g, " ").trim();
    let audioBase64 = null;

    if (azureSpeechKey && azureSpeechRegion && cleanText) {
      const hasThai = /[\u0E00-\u0E7F]/.test(cleanText);
      const lang = hasThai ? "th-TH" : "en-US";
      const voiceName = hasThai ? "th-TH-NiwatNeural" : "en-US-AndrewMultilingualNeural";
      const pitch = hasThai ? "+6%" : "+3%";
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
