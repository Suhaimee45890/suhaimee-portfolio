// netlify/functions/juri.js
// JURI AI Backend — MAI-Voice-2.1 + Grounded Logic + Clean Thai-English Technical Speech

const DEFAULT_VOICE = 'th-TH-Nattapong:MAI-Voice-2.1';
const FALLBACK_VOICE = 'th-TH-NiwatNeural';
const DEFAULT_MODEL = 'qwen/qwen-plus';

// 1. กรองข้อความก่อนส่งเข้า TTS (ตัดต้นเหตุเสียงเพลง เสียงแทรก ภาษาต่างด้าว และคำสั่งในวงเล็บ)
function sanitizeForSpeech(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/https?:\/\/\S+/gi, '') // ตัด URL
    .replace(/\[[^\]]*\]|\([^)]*เสียง[^)]*\)/gi, ' ') // ตัดแท็กเอฟเฟกต์ เช่น [music], (เสียงเพลง)
    .replace(/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]+/g, '') // ตัดจีน ญี่ปุ่น เกาหลี
    .replace(/[*#_~`>|•✦●◆■▲▼—–]+/g, ' ') // ตัด Markdown และขีดยาว
    .replace(/([.!?])\1+/g, '$1') // ลดเครื่องหมายซ้ำ เช่น ... หรือ !!! ที่ทำให้เสียงเพี้ยน
    .replace(/[^\u0E00-\u0E7FA-Za-z0-9\s.,?!()%\-\/:]/g, '') // คงไว้เฉพาะ ไทย + อังกฤษ + ตัวเลข + วรรคตอนพื้นฐาน
    .replace(/\r?\n+/g, ' ') // รวมเป็นประโยคพูดต่อเนื่อง
    .replace(/\s+/g, ' ')
    .trim();
}

// 2. สร้าง SSML ตามรูปแบบ Microsoft Speech Studio (ไม่บิดสปีด ไม่ตัดสลับเอนจินให้เสียงสะดุด)
function buildPureSSML(text, voiceName) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xmlns:emo="http://www.w3.org/2009/10/emotionml" version="1.0" xml:lang="th-TH"><voice name="${voiceName}">${escaped}</voice></speak>`;
}

// 3. ส่งคำขอสร้างไฟล์เสียง MP3 ตรงเข้า Azure TTS (ยิงต่อเดียว 96kbps)
async function requestAzureTTS(speechKey, speechRegion, text, voiceName) {
  const ssml = buildPureSSML(text, voiceName);
  const res = await fetch(
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

  if (!res.ok) {
    return { ok: false, status: res.status, audioBase64: null };
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    ok: true,
    status: 200,
    audioBase64: Buffer.from(arrayBuffer).toString('base64'),
  };
}

// 4. ระบบสังเคราะห์เสียงพร้อม Fallback อัตโนมัติหาก Region ไม่รองรับ MAI-Voice-2.1
async function synthesizeSpeech(text) {
  const speechKey = process.env.AZURE_SPEECH_KEY || process.env.AZURE_TTS_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || process.env.AZURE_TTS_REGION;
  const primaryVoice = process.env.AZURE_VOICE_NAME || DEFAULT_VOICE;

  if (!speechKey || !speechRegion) {
    return { audioBase64: null, ttsError: 'MISSING AZURE CONFIG' };
  }

  const cleanText = sanitizeForSpeech(text);
  if (!cleanText) {
    return { audioBase64: null, ttsError: 'EMPTY SPEECH TEXT' };
  }

  try {
    let result = await requestAzureTTS(speechKey, speechRegion, cleanText, primaryVoice);

    // หากเสียงหลักไม่รองรับใน Region ปัจจุบัน ให้สลับใช้ NiwatNeural ทันทีเพื่อไม่ให้เสียงเงียบ
    if (!result.ok && primaryVoice !== FALLBACK_VOICE) {
      result = await requestAzureTTS(speechKey, speechRegion, cleanText, FALLBACK_VOICE);
    }

    if (!result.ok) {
      return { audioBase64: null, ttsError: `TTS HTTP ${result.status}` };
    }

    return { audioBase64: result.audioBase64, ttsError: null };
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

    // โหมด A: อ่านสคริปต์สำเร็จรูปทันที (ปุ่ม Welcome / กดอธิบายการ์ด / คำสั่ง Explode)
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
    const model = process.env.QWEN_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY' }) };
    }

    const catalogSummary = Array.isArray(body.catalog)
      ? body.catalog
          .filter((c) => c && c.title)
          .map((c) => `ระบบ ${c.code || ''} ${c.title} (${c.category || ''}): ${c.specs || ''}`)
          .join('\n')
      : '';

    const systemPrompt = [
      'คุณคือ Juri ผู้ช่วยเสียง AI ด้านวิศวกรรมประจำพอร์ตโฟลิโอ 3D ของคุณ Suhaimi (ซูฮัยมี) บุคลิกฉลาด สุภาพ พูดชัดเจนและลื่นไหล',
      'กฎเหล็กในการตอบที่ต้องทำตามอย่างเคร่งครัด:',
      '1. ใช้ภาษาพูดภาษาไทยที่เป็นธรรมชาติ สำหรับคำศัพท์เฉพาะทางวิศวกรรมและเทคโนโลยีให้เขียนเป็นภาษาอังกฤษตรงตัวโดยไม่ต้องทับศัพท์ เช่น Turbofan, WebGL, Inverse Kinematics, Cutaway, Backwash, Three.js, Bypass Ratio',
      '2. ห้ามใช้ภาษาจีน ญี่ปุ่น เกาหลี หรือภาษาอื่นเด็ดขาด',
      '3. ตอบตามข้อเท็จจริงและข้อมูลผลงานที่ให้ไว้เท่านั้น ห้ามแต่งข้อมูลหรือเดาสเปกเอง หากไม่มีข้อมูลให้บอกตรงๆ ว่ายังไม่มีรายละเอียดในระบบ',
      '4. ตอบให้ครบใจความและจบประโยคสมบูรณ์ ความยาวประมาณ 2 ถึง 3 ประโยคสั้นๆ ไม่ยืดเยื้อ และปิดท้ายด้วยคำถามสั้นๆ 1 ข้อเพื่อชวนคุยต่อ',
      '5. เขียนเป็นข้อความพูดต่อเนื่อง ห้ามขึ้นบรรทัดใหม่ ห้ามใส่หัวข้อเป็นข้อๆ ห้ามใช้อีโมจิ ดอกจัน หรือคำบรรยายเสียง เช่น [เพลง] หรือ (หัวเราะ) เด็ดขาด',
      catalogSummary ? `รายการผลงาน 3D ที่มีอยู่ในพอร์ตโฟลิโอตอนนี้:\n${catalogSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const historyMessages = Array.isArray(body.history)
      ? body.history
          .slice(-4)
          .map((h) => ({
            role: h.role === 'model' ? 'assistant' : 'user',
            content: String(h.text || h.content || '').trim(),
          }))
          .filter((h) => h.content.length > 0)
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
        max_tokens: 260,
        temperature: 0.35, // คุมความแม่นยำไม่ให้ AI หลุดตอบมั่ว
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
