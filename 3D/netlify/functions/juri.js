exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ไม่พบ GEMINI_API_KEY ในระบบ Netlify" }),
    };
  }

  try {
    const { prompt } = JSON.parse(event.body || "{}");

    // Prompt สั้นที่สุดเพื่อประหยัด Input Token
   const systemInstruction =
      "คุณคือ JURI AI ผู้ช่วยวิศวกรของ Suhaimee Jehhae (ผู้เชี่ยวชาญ MES, Industrial Automation, 3D Simulation, Cybersecurity) ตอบภาษาเดียวกับที่ถาม สไตล์สุขุม ฉลาด เหมือน J.A.R.V.I.S. ใช้น้ำเสียงสนทนาที่เป็นธรรมชาติ แบ่งประโยคสั้นๆ ใส่ลูกน้ำหรือเว้นวรรคเพื่อจังหวะการหายใจ กระชับไม่เกิน 2-3 ประโยค และห้ามใช้สัญลักษณ์ ** หรือ #";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 160, // จำกัดความยาวเพื่อประหยัด Output Token
          },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Gemini API Error");

    const replyText =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "ขออภัย ระบบประมวลผลขัดข้องชั่วคราวครับ";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: replyText }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
