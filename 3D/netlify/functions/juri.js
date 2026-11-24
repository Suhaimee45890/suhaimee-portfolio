// netlify/functions/juri.js
// JURI AI Backend: Bilingual Thai-English + Fast Token Cache + Strict Audio Sanitizer

let cachedAzureToken = null;
let azureTokenExpiresAt = 0;

// 1. กรองข้อความให้เหลือเฉพาะภาษาไทย อังกฤษ และตัวเลข (ตัดภาษาจีน อีโมจิ และสัญลักษณ์ที่ทำให้เกิดเสียงเพลง/เสียงเพี้ยน)
function sanitizeThaiEnglish(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/https?:\/\/\S+/gi, '') // ตัด URL
    .replace(/[*#_~`>|•✦●◆■▲▼]+/g, ' ') // ตัดสัญลักษณ์ Markdown และไอคอน
    .replace(/[^\u0E00-\u0E7FA-Za-z0-9\s.,!?'"()\-:/]/g, '') // อนุญาตเฉพาะ ไทย + อังกฤษ + ตัวเลข
    .replace(/\s+/g, ' ')
    .trim();
}

// 2. แปลงข้อความเป็น SSML โดยสลับสำเนียง en-US อัตโนมัติเมื่อเจอคำศัพท์ภาษาอังกฤษ
function buildBilingualSSML(cleanText, voiceName) {
  const escaped = cleanText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const withEnglishLang = escaped.replace(
    /([A-Za-z][A-Za-z0-9\-\/\.]*(?:\s+[A-Za-z0-9\-\/\.]+)*)/g,
    '<lang xml:lang="en-US">$1</lang>'
  );

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="th-TH">
    <voice name="${voiceName}">
      <prosody rate="+6%">${withEnglishLang}</prosody>
    </voice>
  </speak>`;
}

// 3. แคช Azure Token ไว้ใน RAM (ลดเวลาตอบลง 1.5–2 วินาที ไม่ต้องขอ Token ใหม่ทุกรอบ)
async function getAzureAccessToken(speechKey, speechRegion) {
  const now = Date.now();
  if (cachedAzureToken && now < azureTokenExpiresAt) {
    return cachedAzureToken;
  }

  const tokenRes = await fetch(
    `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Length': '0',
      },
    }
  );

  if (!tokenRes.ok) {
    throw new Error(`Azure Token HTTP ${tokenRes.status}`);
  }

  cachedAzureToken = await tokenRes.text();
  azureTokenExpiresAt = now + 8 * 60 * 1000; // เก็บไว้ 8 นาที
  return cachedAzureToken;
}

// 4. สร้างไฟล์เสียง MP3 จาก Azure TTS
async function synthesizeSpeech(text) {
  const speechKey = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || process.env.AZURE_TTS_REGION || 'southeastasia';
  const voiceName = process.env.AZURE_VOICE_NAME || 'th-TH-NiwatNeural';

  if (!speechKey) {
    return { audioBase64: null, ttsError: 'MISSING AZURE KEY' };
  }

  const cleanText = sanitizeThaiEnglish(text);
  if (!cleanText) {
    return { audioBase64: null, ttsError: 'EMPTY SPEECH TEXT' };
  }

  try {
    const token = await getAzureAccessToken(speechKey, speechRegion);
    const ssml = buildBilingualSSML(cleanText, voiceName);

    const ttsRes = await fetch(
      `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'JuriPortfolioVoice',
        },
        body: ssml,
      }
    );

    if (!ttsRes.ok) {
      return { audioBase64: null, ttsError: `TTS HTTP ${ttsRes.status}` };
    }

    const arrayBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
    return { audioBase64, ttsError: null };
  } catch (err) {
    cachedAzureToken = null;
    return { audioBase64: null, ttsError: err.message || 'TTS ERROR' };
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // โหมด A: อ่านสคริปต์สำเร็จรูปทันที (ไม่ต้องผ่าน AI คิดคำตอบ)
    if (body.speakOnlyText) {
      const { audioBase64, ttsError } = await synthesizeSpeech(body.speakOnlyText);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: body.speakOnlyText, audioBase64, ttsError }),
      };
    }

    // โหมด B: สนทนาถาม-ตอบผ่าน OpenRouter (qwen/qwen-turbo)
    const userMessage = String(body.message || '').trim();
    if (!userMessage) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Empty message' }) };
    }

    const apiKey = process.env.OPENROUTER_API_KEY || process.env.QWEN_API_KEY;
    const model = process.env.QWEN_MODEL || 'qwen/qwen-turbo';

    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY' }) };
    }

    const catalogSummary = Array.isArray(body.catalog)
      ? body.catalog.map((c) => `[${c.code}] ${c.title} (${c.category}): ${c.specs}`).join('\n')
      : '';

    const systemPrompt = [
      'คุณคือ Juri ผู้ช่วย AI วิศวกรรมประจำพอร์ตโฟลิโอ 3D ของคุณ Suhaimi (ซูฮัยมี) สไตล์ Jarvis ที่ฉลาด สุภาพ และกระชับ',
      'กฎการตอบที่ต้องทำตามอย่างเคร่งครัด:',
      '1. ใช้เฉพาะภาษาไทยปนคำศัพท์เทคนิคภาษาอังกฤษเท่านั้น ห้ามใช้ภาษาจีนหรือภาษาอื่นเด็ดขาด',
      '2. ตอบสั้นกระชับไม่เกิน 2 ประโยค และปิดท้ายด้วยคำถามสั้นๆ 1 ข้อเพื่อชวนคุยต่อ',
      '3. ห้ามใช้อีโมจิ เครื่องหมายดอกจัน เครื่องหมายชาร์ป หรือสัญลักษณ์พิเศษใดๆ เพราะระบบจะนำไปอ่านออกเสียง',
      catalogSummary ? `ข้อมูลระบบ 3D ในพอร์ตโฟลิโอ:\n${catalogSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const historyMessages = Array.isArray(body.history)
      ? body.history.slice(-4).map((h) => ({
          role: h.role === 'model' ? 'assistant' : 'user',
          content: String(h.text || h.content || ''),
        }))
      : [];

    const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 140,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: userMessage },
        ],
      }),
    });

    const llmData = await llmRes.json().catch(() => ({}));
    if (!llmRes.ok) {
      const errMsg = llmData?.error?.message || `OpenRouter HTTP ${llmRes.status}`;
      return { statusCode: llmRes.status, headers, body: JSON.stringify({ error: errMsg }) };
    }

    const rawReply = llmData?.choices?.[0]?.message?.content || '';
    const cleanReply =
      sanitizeThaiEnglish(rawReply) || 'ขออภัยครับ ระบบประมวลผลขัดข้องเล็กน้อย ลองถามใหม่อีกครั้งนะครับ';

    const { audioBase64, ttsError } = await synthesizeSpeech(cleanReply);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: cleanReply,
        audioBase64,
        ttsError,
      }),
    };
  } catch (err) {
    console.error('JURI Function Error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal Server Error' }),
    };
  }
};
