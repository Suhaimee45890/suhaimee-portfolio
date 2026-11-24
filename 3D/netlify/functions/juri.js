// netlify/functions/juri.js
// JURI AI Backend — Native Microsoft Neural Voice + Smooth Natural Thai-English Flow

// 1. กรองข้อความสำหรับอ่านออกเสียงให้ลื่นไหล (คงไทย+อังกฤษ ตัดภาษาจีน อีโมจิ และสัญลักษณ์ที่ทำให้เสียงสะดุด)
function sanitizeForSpeech(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]+/g, '') // ตัดจีน ญี่ปุ่น เกาหลี
    .replace(/[*#_~`>|•✦●◆■▲▼—–]+/g, ' ') // ตัด Markdown และขีดยาว
    .replace(/\.{2,}/g, ' ') // ตัดจุดไข่ปลาที่ทำให้เสียงหยุดชะงัก
    .replace(/[^\u0E00-\u0E7FA-Za-z0-9\s.,?!()%\-\/]/g, '') // คงไว้เฉพาะไทย อังกฤษ ตัวเลข วรรคตอนพื้นฐาน
    .replace(/\r?\n+/g, ' ') // รวมทุกบรรทัดเป็นประโยคพูดต่อเนื่อง
    .replace(/\s+/g, ' ')
    .trim();
}

// 2. สร้าง SSML แบบบริสุทธิ์ ใช้โทนเสียงต้นฉบับของ Microsoft Neural 100% ไม่บิดความเร็ว ไม่ตัดสลับเอนจิน
function buildPureSSML(text, voiceName) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="th-TH"><voice name="${voiceName}">${escaped}</voice></speak>`;
}

// 3. สังเคราะห์เสียงตรงเข้า Microsoft Azure TTS (ยิงต่อเดียว ไม่เสียเวลาขอ Token แยก + เสียงชัด 96kbps)
async function synthesizeSpeech(text) {
  const speechKey = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || process.env.AZURE_TTS_REGION;
  const voiceName = process.env.AZURE_VOICE_NAME || 'th-TH-NiwatNeural';

  if (!speechKey || !speechRegion) {
    return { audioBase64: null, ttsError: 'MISSING AZURE CONFIG' };
  }

  const cleanText = sanitizeForSpeech(text);
  if (!cleanText) {
    return { audioBase64: null, ttsError: 'EMPTY SPEECH TEXT' };
  }

  try {
    const ssml = buildPureSSML(cleanText, voiceName);

    const ttsRes = await fetch(
      `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
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

    // โหมด A: อ่านสคริปต์สำเร็จรูปทันที (ปุ่ม Welcome / กดอธิบายการ์ด / คำสั่ง Explode 3D)
    if (body.speakOnlyText) {
      const { audioBase64, ttsError } = await synthesizeSpeech(body.speakOnlyText);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ reply: body.speakOnlyText, audioBase64, ttsError }),
      };
    }

    // โหมด B: สนทนาโต้ตอบผ่าน OpenRouter
    const userMessage = String(body.message || '').trim();
    if (!userMessage) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Empty message' }) };
    }

    const apiKey = process.env.OPENROUTER_API_KEY || process.env.QWEN_API_KEY;
    const model = process.env.QWEN_MODEL || 'qwen/qwen-plus';

    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY' }) };
    }

    const catalogSummary = Array.isArray(body.catalog)
      ? body.catalog.map((c) => `ระบบ ${c.code} ${c.title} (${c.category}): ${c.specs}`).join('\n')
      : '';

    const systemPrompt = [
      'คุณคือ Juri ผู้ช่วยเสียง AI ประจำพอร์ตโฟลิโอวิศวกรรม 3D ของคุณ Suhaimi (ซูฮัยมี) บุคลิกฉลาด สุภาพ เป็นกันเอง และพูดลื่นไหลเหมือนผู้ช่วยส่วนตัว',
      'แนวทางการพูดที่ต้องยึดถือ:',
      '1. ตอบเป็นภาษาพูดภาษาไทยที่ลื่นไหลต่อเนื่องเป็นธรรมชาติ สามารถใช้คำศัพท์เทคนิคภาษาอังกฤษปนได้ตามความเหมาะสม ห้ามใช้ภาษาจีนหรือภาษาอื่นเด็ดขาด',
      '2. ตอบให้ครบใจความและจบประโยคสมบูรณ์เสมอ ความยาวพอดีประมาณ 2 ถึง 3 ประโยคสั้นๆ ไม่ยืดเยื้อ และปิดท้ายด้วยคำถามสั้นๆ เพื่อชวนคุยต่อ',
      '3. เขียนเป็นข้อความต่อเนื่องห้ามขึ้นหัวข้อเป็นข้อๆ ห้ามใส่ตัวเลขนำหน้า ห้ามใช้อีโมจิ ดอกจัน หรือสัญลักษณ์ใดๆ เพราะข้อความทั้งหมดจะถูกนำไปอ่านออกเสียงทันที',
      catalogSummary ? `ข้อมูลผลงาน 3D ในหน้าเว็บ:\n${catalogSummary}` : '',
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
        'X-Title': 'Suhaime 3D Portfolio Juri',
      },
      body: JSON.stringify({
        model,
        max_tokens: 280,
        temperature: 0.5,
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
      sanitizeForSpeech(rawReply) || 'ขออภัยครับ ระบบประมวลผลขัดข้องเล็กน้อย ลองถามใหม่อีกครั้งได้เลยครับ';

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
