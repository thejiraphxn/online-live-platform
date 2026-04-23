/**
 * Unified LLM client — speaks the /v1/chat/completions format, which virtually
 * every hosted and self-hosted LLM provider supports. Swap providers by
 * changing env vars; no code changes needed.
 *
 *   Groq          LLM_API_URL=https://api.groq.com/openai/v1   MODEL=llama-3.3-70b-versatile
 *   Ollama Cloud  LLM_API_URL=https://ollama.com/v1            MODEL=gemma3:27b-cloud
 *   Ollama local  LLM_API_URL=http://localhost:11434/v1        MODEL=gemma3:4b
 *   Anthropic     LLM_API_URL=https://api.anthropic.com/v1     MODEL=claude-sonnet-4
 *   Typhoon       LLM_API_URL=https://api.opentyphoon.ai/v1    MODEL=typhoon-v2-70b-instruct
 *
 * Leave LLM_API_URL blank and the client falls back to WHISPER_API_BASE_URL +
 * WHISPER_API_KEY, so one provider (e.g. Groq) can cover both Whisper and LLM.
 *
 * Used after transcription to:
 *   - Summarize the lecture in 2–3 sentences
 *   - Auto-generate chapters when the teacher didn't mark any
 */
import { logger } from '../lib/logger.js';

export type AutoChapter = { timeSec: number; label: string };

function llmConfig() {
  let url = process.env.LLM_API_URL || process.env.WHISPER_API_BASE_URL || '';
  url = url.replace(/\/+$/, '');
  if (!url) return null;
  // Normalise: if user gave a bare host (no /v1 suffix), append it.
  if (!/\/v\d+$/.test(url)) url = `${url}/v1`;
  const key = process.env.LLM_API_KEY || process.env.WHISPER_API_KEY || '';
  const model = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
  return { url, key, model };
}

async function chat(
  messages: { role: 'system' | 'user'; content: string }[],
  opts: { jsonMode?: boolean } = {},
): Promise<string | null> {
  const cfg = llmConfig();
  if (!cfg) return null;

  const body: any = {
    model: cfg.model,
    messages,
    temperature: 0.2,
    stream: false,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${cfg.url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

function truncateTranscript(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n\n[...truncated middle ${text.length - maxChars} chars...]\n\n${tail}`;
}

export async function summarize(transcriptText: string): Promise<string | null> {
  if (!llmConfig()) return null;
  try {
    const reply = await chat([
      {
        role: 'system',
        content:
          'You summarize lecture transcripts in 2 to 3 sentences. Plain text, no markdown, no bullet points. Keep it factual and match the transcript language.',
      },
      {
        role: 'user',
        content: `Summarize this lecture:\n\n${truncateTranscript(transcriptText)}`,
      },
    ]);
    return reply?.slice(0, 800) ?? null;
  } catch (e) {
    logger.warn({ err: String(e) }, 'summarize failed');
    return null;
  }
}

export async function generateAutoChapters(
  segments: { startSec: number; text: string }[],
): Promise<AutoChapter[] | null> {
  if (!llmConfig()) return null;
  if (segments.length < 6) return [];

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };
  const lines = segments.map((s) => `[${fmt(s.startSec)}] ${s.text}`).join('\n');
  const prompt = `You are annotating a lecture transcript. Propose 3–8 chapters.
Respond with a JSON object of shape:
  { "chapters": [ { "timeSec": number, "label": "short title" } ] }
Use the timestamps shown in [HH:MM:SS] brackets as the timeSec.
Labels must be 3–7 words, descriptive, and in the same language as the transcript.

TRANSCRIPT:
${truncateTranscript(lines)}`;

  try {
    const reply = await chat(
      [
        {
          role: 'system',
          content:
            'You output only valid JSON. No prose before or after the JSON object.',
        },
        { role: 'user', content: prompt },
      ],
      { jsonMode: true },
    );
    if (!reply) return null;
    const cleaned = reply.replace(/^```(?:json)?\s*/i, '').replace(/```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const arr: AutoChapter[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.chapters)
        ? parsed.chapters
        : [];
    const safe = arr
      .filter((c) => typeof c?.timeSec === 'number' && typeof c?.label === 'string')
      .map((c) => ({ timeSec: Math.max(0, Math.round(c.timeSec)), label: c.label.slice(0, 120) }))
      .sort((a, b) => a.timeSec - b.timeSec)
      .slice(0, 12);
    return safe;
  } catch (e) {
    logger.warn({ err: String(e) }, 'auto-chapters failed');
    return null;
  }
}
