// api/analyze.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'معرف الفيديو مطلوب' });

  const YT_KEY = process.env.YOUTUBE_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  if (!YT_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY غير مضبوط' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY غير مضبوط' });

  try {
    const videoRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(videoId)}&key=${YT_KEY}`
    );
    if (!videoRes.ok) {
      const errData = await videoRes.json().catch(() => ({}));
      return res.status(400).json({ error: errData.error?.message || `YouTube error ${videoRes.status}` });
    }
    const videoData = await videoRes.json();
    const vi = videoData.items?.[0];
    const videoInfo = vi ? {
      title: vi.snippet.title, channel: vi.snippet.channelTitle,
      views: vi.statistics.viewCount, likes: vi.statistics.likeCount,
      commentCount: vi.statistics.commentCount,
      thumb: vi.snippet.thumbnails?.medium?.url || vi.snippet.thumbnails?.default?.url || null
    } : null;

    let comments = [], nextPage = null, pages = 0;
    do {
      let url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=100&key=${YT_KEY}&order=relevance`;
      if (nextPage) url += `&pageToken=${encodeURIComponent(nextPage)}`;
      const cRes = await fetch(url);
      if (!cRes.ok) {
        const errData = await cRes.json().catch(() => ({}));
        return res.status(400).json({ error: errData.error?.message || `YouTube error ${cRes.status}` });
      }
      const cData = await cRes.json();
      for (const item of cData.items || []) {
        const s = item.snippet?.topLevelComment?.snippet;
        if (s) comments.push({ text: s.textDisplay || s.textOriginal || '', author: s.authorDisplayName || '', likes: s.likeCount || 0 });
      }
      nextPage = cData.nextPageToken || null;
      pages++;
    } while (nextPage && pages < 5);

    const valid = comments.filter(c => c.text.trim().length > 3);
    if (valid.length === 0) return res.status(400).json({ error: 'لا توجد تعليقات كافية' });

    const sample = valid.length > 300 ? valid.sort(() => 0.5 - Math.random()).slice(0, 300) : valid;

    const promptText = `Analyze these YouTube comments. Return ONLY valid JSON with Arabic text:

VIDEO: ${videoInfo?.title || 'Unknown'}
COMMENTS (${sample.length}):
${sample.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}

JSON structure:
{
  "summary": {"totalComments":number,"questionsCount":number,"requestsCount":number,"complaintsCount":number,"praiseCount":number},
  "topTopics": [{"topic":"Arabic","mentions":number,"sentiment":"positive|negative|neutral","sampleComments":["string"]}],
  "contentIdeas": [{"title":"Arabic","description":"Arabic","priority":"high|medium|low","evidence":["string"],"estimatedDemand":number,"format":"tutorial|comparison|review|qna|deep_dive|news"}],
  "trendingQuestions": [{"question":"Arabic","frequency":number,"answersInVideo":boolean}],
  "audienceInsights": {"skillLevel":"beginner|intermediate|advanced|mixed","mainPainPoints":["Arabic"],"toolsMentioned":["string"],"languagePreference":"Arabic|English|Mixed"}
}
Rules: ONLY JSON. Specific titles. Prioritize high-frequency requests.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096, responseMimeType: 'application/json' }
        })
      }
    );
    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      return res.status(400).json({ error: errData.error?.message || `Gemini error ${geminiRes.status}` });
    }
    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let analysis;
    try { analysis = JSON.parse(rawText); } catch (e) {
      const m = rawText.match(/```json\s*([\s\S]*?)```/);
      analysis = m ? JSON.parse(m[1]) : { raw: rawText };
    }

    return res.status(200).json({ videoInfo, totalComments: comments.length, analysis });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}

