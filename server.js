'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const ffmpeg    = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { google } = require('googleapis');
// archiver는 ZIP 요청 시 lazy require (미설치여도 서버 정상 기동)

ffmpeg.setFfmpegPath(ffmpegPath);

// ── YouTube OAuth 설정 ────────────────────────────────────────────────────────
const CLIENT_SECRET_PATH = path.join(__dirname, 'client_secret.json');
const TOKEN_PATH         = path.join(__dirname, 'youtube_token.json');

const YOUTUBE_REDIRECT = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/youtube/callback`
  : 'http://localhost:5500/api/youtube/callback';

function getOAuthClient() {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    throw new Error('client_secret.json 파일이 없습니다. YouTube 업로드를 사용하려면 Google Cloud Console에서 OAuth 클라이언트 인증 정보를 다운받아 client_secret.json 파일로 저장하세요.');
  }
  const creds = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  return new google.auth.OAuth2(client_id, client_secret, YOUTUBE_REDIRECT);
}

function getAuthUrl() {
  const oAuth2 = getOAuthClient();
  return oAuth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
  });
}

async function getAuthorizedClient() {
  const oAuth2 = getOAuthClient();
  const token  = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2.setCredentials(token);
  return oAuth2;
}
// ─────────────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 5500;
const PROJECTS_DIR = path.join(__dirname, 'projects');
const SCRIPTS_DIR  = path.join(__dirname, 'scripts');

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(SCRIPTS_DIR))  fs.mkdirSync(SCRIPTS_DIR,  { recursive: true });

const saveNamedScript = (topic, seriesName, episode, script) => {
  const safe = (s) => s.replace(/[\\/:*?"<>|\t\n\r]/g, '_').replace(/\s+/g, ' ').trim();
  const name = seriesName
    ? `${safe(seriesName)}_${episode}화_${safe(topic)}.txt`
    : `${safe(topic)}.txt`;
  fs.writeFileSync(path.join(SCRIPTS_DIR, name), script, 'utf8');
};

// Key는 항상 클라이언트 요청에서 받음 — 서버는 저장하지 않음
const resolveKey = (fromReq) => fromReq || '';

app.use(cors());
app.use(express.json({ limit: '64mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────
const newId  = () => crypto.randomUUID();
const pDir   = (id, ...sub) => path.join(PROJECTS_DIR, id, ...sub);
const mkDir  = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const fmtSec = (s) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
};

function parseSingleTag(text, tag) {
  // 닫는 태그 있으면 그 사이, 없으면 여는 태그 이후 전체
  const m = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'i'));
  if (m) return m[1].trim();
  const m2 = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*)$`, 'i'));
  return m2 ? m2[1].trim() : '';
}
function parseListBlock(text, open, close) {
  const s = text.indexOf(open), e = text.indexOf(close);
  if (s === -1 || e <= s) return [];
  return text.slice(s + open.length, e).trim()
    .split('\n').map(v => v.replace(/^\s*[-•\d.)]+\s*/, '').trim()).filter(Boolean);
}
function parseScenes(text) {
  return [...text.matchAll(/\[SCENE\]([\s\S]*?)\[\/SCENE\]/gi)].map(m => {
    const b = m[1];
    return {
      sceneNumber:   (m2 => m2 ? Number(m2[1]) : null)(b.match(/NUMBER:\s*(\d+)/i)),
      sceneTitle:    ((b.match(/TITLE:\s*(.*)/i)     ||[])[1]||'').trim(),
      relatedLine:   ((b.match(/RELATED_KO:\s*(.*)/i)||[])[1]||((b.match(/RELATED:\s*(.*)/i)||[])[1])||'').trim(),
      relatedLineEn: ((b.match(/RELATED_EN:\s*(.*)/i)||[])[1]||'').trim(),
      mood:          ((b.match(/MOOD:\s*(.*)/i)      ||[])[1]||'').trim(),
      searchQuery:   ((b.match(/SEARCH:\s*(.*)/i)    ||[])[1]||'').trim(),
      prompt:        ((b.match(/PROMPT:\s*([\s\S]*?)(?=PROMPT_KO:|$)/i)||[])[1]||((b.match(/PROMPT:\s*([\s\S]*)/i)||[])[1])||'').trim(),
      promptKo:      ((b.match(/PROMPT_KO:\s*(.*)/i)||[])[1]||'').trim(),
      scriptChunkEn: ((b.match(/CHUNK_EN:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i)||[])[1]||'').trim(),
    };
  }).filter(sc => sc.sceneNumber !== null && (sc.sceneTitle || sc.prompt));
}
function normalizeHashtags(t) {
  return String(t||'').split(/[,\s]+/).filter(Boolean)
    .map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ');
}
function splitScript(text, max = 700) {
  const norm = String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();
  if (!norm) return [];
  // 한국어 포함 — .!?…。\n 기준으로 분할
  const sentences = norm.match(/[^.!?…。\n]+[.!?…。\n]*/g) || [];
  const chunks = []; let cur = '';
  for (const s of sentences) {
    const next = (cur + ' ' + s).trim();
    if (next.length > max && cur) { chunks.push(cur.trim()); cur = s.trim(); }
    else cur = next;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
function minChars(len) {
  // 쇼츠 구간 포함
  return { '15초':120,'30초':240,'60초':480,'90초':720,'3분(쇼츠)':1440,
           '3분':1400,'5분':2300,'10분':4500,'15분':6500,'20분':8500,'30분':12000,'40분':16000,'50분':20000 }[len] || 4500;
}
function optimalChunkSize(videoLength) {
  if (['15초','30초','60초','90초','3분(쇼츠)'].includes(videoLength)) return 200;
  return { '3분':1400,'5분':2300,'10분':2500,'15분':3000,'20분':3500,'30분':4000,'40분':4500,'50분':5000 }[videoLength] || 2500;
}

// SRT 자막 생성 (쇼츠용) — 한 줄 20자씩 끊어서 표시
function buildSRT(segments) {
  let out = '', t = 0, idx = 1;
  for (const seg of segments) {
    if (seg.error) { t += (seg.duration || 0); continue; }
    const dur  = seg.duration || 0;
    const text = (seg.fullText || seg.text || '').trim();
    if (!text || dur <= 0) { t += dur; continue; }
    // 20자 단위로 줄 분할 (화면 꽉 차는 현상 방지)
    const lines = [];
    for (let i = 0; i < text.length; i += 20) lines.push(text.slice(i, i + 20));
    const lineCount = lines.length;
    const perLine = dur / lineCount;
    for (const line of lines) {
      out += `${idx++}\n${srtTime(t)} --> ${srtTime(t + perLine)}\n${line}\n\n`;
      t += perLine;
    }
    continue;
  }
  return out;
}
function srtTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(sc)},${String(ms).padStart(3,'0')}`;
}
function pad2(n) { return String(n).padStart(2,'0'); }
function ttsChunkSize() {
  return 900; // 약 3분 분량 (한국어 300자/분 기준). 음색 일관성 향상.
}
// 영상 길이별 최대 스크립트 생성 토큰 (한국어 1자 ≈ 2토큰)
function scriptMaxTokens(videoLength) {
  return { '15초':512,'30초':1024,'60초':2048,'90초':3072,'3분(쇼츠)':4096,
           '3분':6144,'5분':8192,'10분':16384,'15분':24576,'20분':32768,'30분':49152,'40분':65536,'50분':65536 }[videoLength] || 16384;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini 텍스트 생성
// ─────────────────────────────────────────────────────────────────────────────
async function geminiText({ apiKey, prompt, maxTokens = 8192, temp = 0.8, model = 'gemini-2.5-flash-lite', thinkingBudget = -1, useSearch = false, _attempt = 0 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const genConfig = { temperature: temp, topP: 0.95, topK: 40, maxOutputTokens: maxTokens };
  if (thinkingBudget >= 0) genConfig.thinkingConfig = { thinkingBudget };
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: genConfig
  };
  if (useSearch) body.tools = [{ googleSearch: {} }];
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) {
    const msg = d?.error?.message || `Gemini 오류 (${r.status})`;
    const isOverload = r.status === 503 || r.status === 429 || r.status === 500 || msg.includes('high demand') || msg.includes('overloaded') || msg.toLowerCase().includes('internal error');
    if (isOverload && _attempt < 4) {
      const wait = [15000, 30000, 60000, 90000][_attempt];
      console.log(`[Gemini] 재시도 ${_attempt + 2}/5 (${r.status}) — ${wait/1000}초 대기`);
      await new Promise(ok => setTimeout(ok, wait));
      return geminiText({ apiKey, prompt, maxTokens, temp, model, useSearch, _attempt: _attempt + 1 });
    }
    throw new Error(msg);
  }
  const parts = d?.candidates?.[0]?.content?.parts || [];
  const t = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!t) throw new Error('Gemini 응답 없음');
  return t;
}

// 화자별 스타일 지시문 (언어별)
const VOICE_STYLES = {
  ko: {
    Aoede:  'Read the following Korean text aloud as a professional Korean narrator. Use a calm, warm, soothing female voice. Maintain perfectly consistent tone, speed, and volume from start to finish. No pauses between sentences unless punctuated. Speak naturally and smoothly: ',
    Charon: 'Read the following Korean text aloud as a professional Korean narrator. Use a deep, trustworthy, authoritative male voice. Maintain perfectly consistent tone, speed, and volume from start to finish. Speak naturally and smoothly: ',
    Fenrir: 'Read the following Korean text aloud as a professional Korean narrator. Use a strong, confident, powerful male voice. Maintain perfectly consistent tone, speed, and volume from start to finish. Speak naturally and smoothly: ',
    Kore:   'Read the following Korean text aloud as a professional Korean narrator. Use a bright, friendly, cheerful female voice. Maintain perfectly consistent tone, speed, and volume from start to finish. Speak naturally and smoothly: ',
    Puck:   'Read the following Korean text aloud as a professional Korean narrator. Use an energetic, enthusiastic, upbeat male voice. Maintain perfectly consistent tone, speed, and volume from start to finish. Speak naturally and smoothly: ',
    Leda:   'Read the following Korean text aloud as a professional Korean narrator. Use a gentle, soft, reassuring female voice. Maintain perfectly consistent tone, speed, and volume from start to finish. Speak naturally and smoothly: ',
    Zephyr: 'Read the following Korean text aloud as a professional Korean narrator. Use a clear, crisp, professional female voice. Maintain perfectly consistent tone, speed, and volume from start to finish. Speak naturally and smoothly: ',
  },
  en: {
    Aoede:  'Narrate the following English text in a calm, warm, soothing female voice: ',
    Charon: 'Narrate the following English text in a deep, trustworthy, authoritative male voice: ',
    Fenrir: 'Narrate the following English text in a strong, confident, powerful male voice: ',
    Kore:   'Narrate the following English text in a bright, friendly, cheerful female voice: ',
    Puck:   'Narrate the following English text in an energetic, enthusiastic, upbeat male voice: ',
    Leda:   'Narrate the following English text in a gentle, soft, reassuring female voice: ',
    Zephyr: 'Narrate the following English text in a clear, crisp, professional female voice: ',
  }
};

// 속도 → FFmpeg atempo 비율
function resolveAtempo(speed) {
  if (speed === 'slow') return 0.75;
  if (speed === 'fast') return 1.5;
  return 1.0; // normal 또는 미지정
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini TTS 생성 (타임아웃 300초 + 자동 재시도 2회)
// ─────────────────────────────────────────────────────────────────────────────
async function geminiTTS({ apiKey, text, voiceName = 'Aoede', lang = 'ko', _attempt = 0 }) {
  const styles      = VOICE_STYLES[lang] || VOICE_STYLES.ko;
  const stylePrefix = styles[voiceName] || '';
  const styledText  = stylePrefix + text;

  console.log(`[TTS] voice=${voiceName} lang=${lang} attempt=${_attempt + 1} chars=${text.length}`);

  const url        = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 300_000); // 300초 타임아웃

  let r, d;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: styledText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
        }
      })
    });
    d = await r.json();
  } catch (err) {
    clearTimeout(timer);
    if (_attempt < 2) {
      const wait = _attempt === 0 ? 15000 : 30000; // 1차 재시도 15초, 2차 30초 대기
      console.log(`[TTS] 재시도 ${_attempt + 2}/3 — ${wait/1000}초 대기 (사유: ${err.message})`);
      await new Promise(ok => setTimeout(ok, wait));
      return geminiTTS({ apiKey, text, voiceName, lang, _attempt: _attempt + 1 });
    }
    throw new Error(`TTS 타임아웃/네트워크 오류 (3회 실패): ${err.message}`);
  }
  clearTimeout(timer);

  if (!r.ok) {
    const msg = d?.error?.message || `TTS HTTP ${r.status}`;
    // 429(레이트 리밋) 또는 5xx 서버 오류만 재시도
    if (_attempt < 2 && (r.status === 429 || r.status >= 500)) {
      const wait = r.status === 429 ? 15000 : 8000; // 429는 15초 대기
      console.log(`[TTS] 서버 오류 재시도 (${r.status}) — ${wait/1000}초 대기`);
      await new Promise(ok => setTimeout(ok, wait));
      return geminiTTS({ apiKey, text, voiceName, lang, _attempt: _attempt + 1 });
    }
    throw new Error(msg);
  }

  const inline = d?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) throw new Error('TTS 오디오 데이터 없음 (응답 구조 확인 필요)');
  return inline.data; // base64 PCM
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM base64 → WAV 버퍼
// ─────────────────────────────────────────────────────────────────────────────
function pcmToWav(b64, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const pcm      = Buffer.from(b64, 'base64');
  const dataSize = pcm.length;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);               // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// ─────────────────────────────────────────────────────────────────────────────
// 영상 파일 길이 계산 (ffprobe)
// ─────────────────────────────────────────────────────────────────────────────
function getVideoDuration(filePath) {
  return new Promise(resolve => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta) { resolve(0); return; }
      resolve(parseFloat(meta.format?.duration) || 0);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 오디오 길이 계산 — ffprobe 사용 (WAV 헤더 오파싱 오류 방지, 가장 정확)
// ─────────────────────────────────────────────────────────────────────────────
function audioDuration(filePath) {
  return new Promise(resolve => {
    // 1차: ffprobe (가장 정확 — ffmpeg 정규화 후 WAV 헤더 오차 없음)
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (!err && meta) {
        const dur = parseFloat(meta.format?.duration);
        if (dur > 0) {
          console.log(`[Duration] ffprobe: ${dur.toFixed(1)}초`);
          resolve(dur);
          return;
        }
      }
      // 2차: 파일 크기로 추정 (24kHz mono 16-bit = 48000 bytes/sec)
      try {
        const stat      = fs.statSync(filePath);
        const dataBytes = stat.size - 44;
        if (dataBytes > 0) {
          const calc = dataBytes / 48000;
          console.log(`[Duration] 파일크기 추정: ${calc.toFixed(1)}초 (${stat.size} bytes)`);
          resolve(calc);
          return;
        }
      } catch (e) { console.log('[Duration] 파일크기 계산 실패:', e.message); }
      resolve(0);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE 헬퍼
// ─────────────────────────────────────────────────────────────────────────────
function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}
function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// API Key는 서버에 저장하지 않음 — 각 사용자의 브라우저 localStorage에서 관리

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 생성
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/create', (req, res) => {
  const id = newId();
  const dir = pDir(id);
  mkDir(dir);
  mkDir(pDir(id, 'audio'));
  mkDir(pDir(id, 'images'));
  mkDir(pDir(id, 'final'));
  const meta = { id, createdAt: new Date().toISOString(), status: 'created' };
  fs.writeFileSync(pDir(id, 'meta.json'), JSON.stringify(meta, null, 2));
  res.json({ projectId: id });
});

// ─────────────────────────────────────────────────────────────────────────────
// 대본 품질 자동 채점
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/script/score', async (req, res) => {
  const { script, topic, isShorts = false, shortsStyle = '' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!script)    return res.status(400).json({ error: '대본 필요' });

  const styleHint = shortsStyle ? `쇼츠 스타일: ${shortsStyle}` : (isShorts ? '쇼츠' : '롱폼');
  const prompt = `당신은 유튜브 콘텐츠 전문 평가자입니다.
아래 대본을 3가지 항목으로 채점하세요.

주제: ${topic || ''}
${styleHint}
대본:
${script.slice(0, 4000)}

채점 기준:
1. 훅(Hook) 강도 /10 — 첫 3초 안에 시청자를 붙잡는가? 강렬하고 궁금증을 유발하는가?
2. 감정/공감 /10 — 중간에 시청자가 공감하거나 감정이 움직이는 포인트가 있는가?
3. 펀치라인/마무리 /10 — 마지막 대사가 강렬하고 기억에 남는가? CTA가 자연스러운가?

반드시 아래 JSON 형식만 출력 (마크다운 없이):
{"hook":8,"emotion":7,"punch":6,"total":21,"feedback":"훅은 강하지만 중간 공감 포인트가 약함. 마지막 대사를 더 짧고 강렬하게 수정 권장.","regenerate":false}

regenerate: total이 21 미만이면 true, 이상이면 false`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt, maxTokens: 256, temp: 0.3, thinkingBudget: 0 });
    const clean = raw.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'').replace(/^```\s*/,'');
    const result = JSON.parse(clean);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 트렌딩 주제 추천 (Gemini 기반)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/topics/trending', async (req, res) => {
  const { mode = 'longform', shortsStyle = '', channelName = '', scriptLang = 'ko' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });

  const today = new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric' });
  const styleHint = shortsStyle ? `쇼츠 스타일: ${shortsStyle}` : '';
  const channelHint = channelName ? `채널명: ${channelName}` : '';
  const langHint = scriptLang === 'en' ? '영어 콘텐츠' : '한국어 콘텐츠';

  const prompt = scriptLang === 'en'
    ? `You are a YouTube trending content expert. Today is ${today}.
Suggest 8 trending YouTube ${mode === 'shorts' ? 'Shorts' : 'long-form'} topics that are currently popular or about to trend.
${channelHint}
Focus on topics with high search volume, emotional appeal, and shareability.
Output ONLY this format, nothing else:
[TOPICS]
topic1
topic2
topic3
topic4
topic5
topic6
topic7
topic8
[/TOPICS]`
    : `당신은 유튜브 트렌드 전문가입니다. 오늘은 ${today}입니다.
지금 이 순간 한국 유튜브에서 폭발적으로 터지거나 곧 터질 ${mode === 'shorts' ? '쇼츠' : '롱폼'} 주제 8개를 추천하세요.
${channelHint} ${styleHint} ${langHint}
조건: 조회수 높은 감정적 주제, 공감대 강한 일상 소재, 시즌성 트렌드, 검색량 많은 키워드 우선.
반드시 아래 형식만 출력하라:
[TOPICS]
주제1
주제2
주제3
주제4
주제5
주제6
주제7
주제8
[/TOPICS]`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt, maxTokens: 512, temp: 0.9, thinkingBudget: 0, useSearch: true });
    const topics = parseListBlock(raw, '[TOPICS]', '[/TOPICS]').slice(0, 8);
    res.json({ topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 출처 기반 주제 추천
// topic 있으면 → 해당 주제의 공식 출처 탐색
// topic 없으면 → 주제 + 공식 출처 세트 자동 추천
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/topics/sourced', async (req, res) => {
  const { topic = '', mode = 'longform', channelName = '' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });

  const modeHint    = mode === 'shorts' ? '유튜브 쇼츠(60초 내외 세로영상)' : '유튜브 롱폼(5~15분)';
  const channelHint = channelName ? `채널명: ${channelName}` : '';
  const hasTopic    = topic.trim().length > 0;
  const today       = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = hasTopic
    ? `당신은 유튜브 콘텐츠 기획자이자 팩트체커입니다.
오늘 날짜: ${today}
사용자가 "${topic}" 주제로 ${modeHint}를 만들고 싶어합니다.
${channelHint}

지금 이 시점(${today}) 기준으로 실제 웹에서 최신 공지/정책/자료를 검색하여, 이 주제와 관련하여 시청자에게 신뢰를 줄 수 있는 공식 출처(정부기관, 공공기관, 공식 홈페이지, 법령, 통계청 등)를 찾아서 콘텐츠 각도 5가지를 제안하세요.
- 반드시 현재(${today}) 유효한 최신 정보를 기준으로 하세요. 지난 연도 만료된 정책·공고는 제외하세요.
- 각 제안은 반드시 실제로 존재하는 공식 기관/사이트를 출처로 명시해야 합니다.

반드시 아래 형식으로만 출력하세요:

[ITEM]
TOPIC: (구체적인 영상 제목)
ORG: (출처 기관명, 예: 서울주택도시공사(SH공사), 국토교통부, 건강보험심사평가원 등)
URL: (해당 기관 공식 홈페이지 URL)
SECTION: (홈페이지 내 해당 정보가 있는 메뉴/섹션명, 예: 공고 > 임대주택 공급)
REASON: (이 출처를 근거로 어떤 내용을 영상으로 만들 수 있는지 한 줄)
[/ITEM]`
    : `당신은 유튜브 콘텐츠 기획자이자 팩트체커입니다.
오늘 날짜: ${today}
${modeHint}으로 만들기 좋은 주제 5개를 추천하되, 각 주제마다 실제로 존재하는 공식 기관/공공기관/정부사이트를 출처로 반드시 명시하세요.
${channelHint}

조건:
- 오늘(${today}) 기준 현재 유효한 최신 정책·공고·통계를 반드시 반영할 것
- 지난 연도 만료된 내용 금지 — 지금 당장 시청자가 활용할 수 있는 정보만
- 시청자 생활에 실질적으로 도움이 되는 주제 (주거, 복지, 건강, 금융, 법률 등)
- 반드시 실존하는 공식 기관이 출처여야 함
- 추측성 정보 금지

반드시 아래 형식으로만 출력하세요:

[ITEM]
TOPIC: (구체적인 영상 제목)
ORG: (출처 기관명)
URL: (해당 기관 공식 홈페이지 URL)
SECTION: (홈페이지 내 해당 정보가 있는 메뉴/섹션명)
REASON: (시청자에게 왜 유용한지 한 줄)
[/ITEM]`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt, maxTokens: 1500, temp: 0.5, thinkingBudget: 0, useSearch: true });
    const suggestions = [...raw.matchAll(/\[ITEM\]([\s\S]*?)\[\/ITEM\]/gi)].map(m => {
      const b = m[1];
      return {
        topic:   ((b.match(/TOPIC:\s*(.*)/i)   || [])[1] || '').trim(),
        org:     ((b.match(/ORG:\s*(.*)/i)     || [])[1] || '').trim(),
        url:     ((b.match(/URL:\s*(.*)/i)     || [])[1] || '').trim(),
        section: ((b.match(/SECTION:\s*(.*)/i) || [])[1] || '').trim(),
        reason:  ((b.match(/REASON:\s*(.*)/i)  || [])[1] || '').trim(),
      };
    }).filter(s => s.topic);
    res.json({ suggestions, hasTopic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 대본 + 메타 생성
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/script/generate', async (req, res) => {
  const { projectId } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);

  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요 (UI에서 저장하세요)' });
  if (!projectId) return res.status(400).json({ error: 'projectId 필요' });

  const dir = pDir(projectId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '프로젝트 없음' });

  // topic 없으면 meta.json에서 읽어옴 (시리즈 목록에서 재시도 시)
  const metaPath = pDir(projectId, 'meta.json');
  const saved = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const b = req.body;
  let topic              = b.topic              || saved.topic        || '';
  let videoLength        = b.videoLength        || saved.videoLength  || '10분';
  let channelName        = b.channelName        || saved.channelName  || '';
  let scriptTone         = b.scriptTone         || saved.scriptTone   || '따뜻하고 잔잔한 이야기형';
  let chapterCount       = b.chapterCount       || saved.chapterCount || 5;
  let scriptLang         = b.scriptLang         || saved.scriptLang   || 'ko';
  let isShorts           = b.isShorts           ?? saved.isShorts     ?? false;
  let shortsStyle        = b.shortsStyle        || saved.shortsStyle  || '';
  let specialInstructions= b.specialInstructions|| '';
  let seriesName         = b.seriesName         || saved.seriesName   || '';
  let episode            = b.episode            || saved.episode      || 1;
  let channelDirection   = b.channelDirection   || '';
  let customDirective    = b.customDirective    || '';
  let isFinalEpisode     = b.isFinalEpisode     ?? false;

  if (!topic) return res.status(400).json({ error: '주제 필요' });

  try {
    // 1. 대본
    const chapterRule = Number(chapterCount) === 0
      ? '6. 챕터 구분 없이 자연스럽게 이어지는 하나의 흐름으로 작성'
      : `6. 반드시 ${chapterCount}개 챕터 흐름\n7. 각 챕터마다 실제 사례 포함\n8. 챕터 구분 표시는 반드시 숫자만 사용할 것. 예) **1.** **2.** **3.** — "챕터"라는 단어 절대 쓰지 마라`;

    const targetChars = minChars(videoLength);

    // 채널명 인트로/아웃트로 지시문
    const chName = (channelName || '').trim();
    const introRule = chName
      ? `- 대본 맨 첫 줄: "${chName} 구독자 여러분, 안녕하세요! 오늘도 채널을 찾아주셔서 감사합니다." 로 시작할 것`
      : '';
    const outroRule = chName
      ? `- 대본 맨 마지막 CTA: "아직 구독 안 하셨다면 지금 바로 구독 버튼을 눌러주세요! 좋아요와 댓글, 그리고 🔔 알림 설정까지 해주시면 새 영상을 가장 먼저 만나실 수 있어요. 여러분의 응원은 영상 제작에 큰 힘이 됩니다. 감사합니다, 다음 영상에서 또 만나요!" 로 마무리할 것. "오늘 영상이 도움이 되셨나요?" 같은 정보성 질문은 절대 사용 금지`
      : `- 마지막에 구독 버튼 누르기, 좋아요, 🔔 알림 설정, 댓글 남기기 CTA 문장으로 따뜻하게 마무리할 것`;
    const introRuleEn = chName
      ? `- First line MUST be: "Hello, ${chName} subscribers! Thank you so much for joining us today."`
      : '';
    const outroRuleEn = chName
      ? `- Last lines MUST be: "If you enjoyed this video, please subscribe to ${chName}, hit the like button, turn on the 🔔 notification bell, and drop a comment below! Thank you so much — see you in the next video!"`
      : `- End with: subscribe, like, turn on notifications (🔔), and comment CTA`;

    // 쇼츠 스타일별 지침
    const shortsStyleGuides = {
      '웃음+반전': {
        desc: '코믹·반전·예상깨기 스타일',
        rules: [
          '첫 3초 훅: 황당하거나 말도 안 되는 상황을 던져라. "이게 뭐야?" 싶은 첫 대사로 스크롤을 멈추게 만들 것. 예) "저 오늘 회사에서 잘렸어요. 그것도... 사장이 저한테 잘렸거든요."',
          '코미디 공식 — 삼단 반전 구조 필수: ① 당연할 것 같은 상황 설정 → ② 그래서 당연히 이렇게 되겠지 기대감 형성 → ③ 완전히 예상 밖의 결과로 폭발. 반전은 단 한 방, 명확하게.',
          '대사 작법: 과장법 극대화 — 10배 부풀려라. "조금 놀랐다" 금지, "심장이 입으로 나올 뻔했다"로. 엉뚱한 비유 필수 — "그 눈빛이... 마치 세금 고지서 같았어요." 의성어·의태어 리듬감 있게 삽입.',
          '펀치라인 규칙: 마지막 대사는 반드시 한 방짜리 — 짧고, 예상 밖이고, 웃음이 터지는 문장으로 끝낼 것. 마무리 후 여운이 남아야 함. 설명하는 결말 금지.',
          '금지: 예상 가능한 흐름, 진지한 교훈, 긴 설명 대사. 웃음은 설명이 아니라 상황에서 나온다.',
        ]
      },
      '귀여움+감동': {
        desc: '순수함·애교·눈물·가족 스타일',
        rules: [
          '첫 3초 훅: 아이·동물·가족의 순수하고 귀여운 한 마디 또는 행동으로 시작. 보는 사람이 "어머 귀여워" 하고 멈추게 만들 것. 예) "엄마, 나 커서 엄마 남자친구 할게."',
          '애교 대사 공식: 아이나 동물의 논리로 세상을 해석하게 하라. 어른의 세계를 순수한 시선으로 비틀면 웃음과 감동이 동시에 온다. 예) "왜 어른들은 맛있는 거 먹으면서 행복하다고 안 해요?"',
          '감정 곡선 필수: 귀여움(웃음) → 따뜻함(미소) → 뭉클함(눈물) 3단계로 자연스럽게 흘러야 함. 갑작스러운 감동 전환 금지 — 천천히, 자연스럽게.',
          '대사 깊이: 단순히 귀엽기만 하면 안 됨. 순수한 말 속에 어른들이 잊고 살던 진실 하나를 담아라. 그게 뭉클함의 핵심.',
          '마무리: 감동의 여운이 3초 이상 남는 대사로 끝낼 것. 설명 금지 — 감정이 스스로 말하게 해라.',
        ]
      },
      '공감+교훈': {
        desc: '짧은 깨달음·가족사랑·효도·공감 스타일',
        rules: [
          '첫 3초 훅: "맞아, 나도 이런 적 있어" 싶은 일상의 한 장면으로 시작. 특별한 상황이 아니라 평범한 순간이 더 강하게 꽂힌다. 예) "아버지한테 전화 오면... 왜 괜히 바쁜 척 했을까요."',
          '공감 공식: 말하지 않아도 아는 감정을 대신 말해줘라. 누구나 느꼈지만 표현 못 했던 감정을 정확하게 짚어내는 대사 1개 필수. 그게 댓글을 부른다.',
          '교훈 작법: 교훈은 설교가 되는 순간 죽는다. 상황이 스스로 말하게 하라. "효도하세요" 금지 — 대신 후회하는 순간 하나를 보여줘라.',
          '감정 구조: 공감(고개 끄덕) → 찌릿함(가슴 한 켠 뜨끔) → 깨달음(짧고 강렬한 한 마디) 3단계.',
          '마지막 대사: 10자 이내의 핵심 한 마디로 끝낼 것. 길면 힘이 빠진다. 여백이 울림을 만든다.',
        ]
      },
      '어린이애교': {
        desc: '순수함·귀여움·어린이 감성 스타일',
        rules: [
          '첫 3초 훅: 아이의 엉뚱한 논리나 말실수로 시작. 어른 세계를 아이 눈으로 해석한 대사가 가장 강하다. 예) "아빠, 왜 회사 가면 피곤해요? 저는 학교 가면 신나는데."',
          '애교 대사 공식: 아이의 말은 짧고 직접적이어야 한다. 돌려 말하지 않는다. 그 직접성이 웃음과 심쿵을 동시에 만든다. 예) "엄마 예뻐? 응, 우리 엄마가 제일 예뻐. 근데 졸릴 때는 좀 무서워."',
          '공감 포인트: 부모나 어른이 보면서 "맞아, 우리 애도 이러는데" 하고 공감할 장면 1개 필수. 보편적인 육아·가족 공감대를 자극할 것.',
          '감정 변화: 귀여움으로 웃다가 → 아이의 진심 어린 한 마디에 → 가슴이 뭉클해지는 흐름. 억지 감동 금지.',
          '마무리 대사: 아이만이 할 수 있는 순수하고 따뜻한 한 마디로 끝낼 것. 어른 말투로 쓰면 즉시 감동 파괴.',
        ]
      },
      '부모공경': {
        desc: '효도·가족사랑·부모님 감사 스타일',
        rules: [
          '첫 3초 훅: 부모님의 작은 행동 하나 — 아무도 주목 안 했던 그 장면으로 시작. 예) "엄마는 항상 제일 작은 걸 드세요. 처음엔 몰랐어요. 그게 사랑인 줄."',
          '공감 대사 공식: 자식이라면 누구나 한 번쯤 후회했을 장면을 짚어라. 말하지 않아도 아는 죄책감을 건드리면 댓글이 터진다. 예) "전화 왔을 때 바쁘다고 끊었어요. 그게 마지막 전화인 줄 몰랐고."',
          '애교 포인트: 부모님께 드리는 진심 어린 애교 한 장면 — 어색하지 않게, 자연스럽게. 과장하면 감동이 깨진다.',
          '감정 구조: 일상의 한 장면(담담) → 그 속에 담긴 희생 발견(찌릿) → 감사와 사랑의 감정 폭발(뭉클). 억지 눈물 유도 금지 — 상황이 스스로 울리게 해라.',
          '마지막 대사: 부모님께 하고 싶었지만 못 했던 말을 대신 해줘라. 짧고 진심 어릴수록 강하다. 보는 사람이 부모님께 전화하고 싶어지면 성공.',
        ]
      }
    };
    const styleKey   = ['웃음+반전','귀여움+감동','공감+교훈','어린이애교','부모공경'].includes(shortsStyle) ? shortsStyle : '웃음+반전';
    const styleGuide = shortsStyleGuides[styleKey];
    const shortsStyleBlock = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎬 쇼츠 스타일: [${styleKey}] — ${styleGuide.desc}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
이 스타일의 작법 공식 (반드시 준수):
${styleGuide.rules.map((r,i)=>`${i+1}. ${r}`).join('\n')}

【공통 3단계 구조 — 절대 지켜라】
STEP 1 (Hook): 첫 1~2문장에서 시청자의 스크롤을 완전히 멈춰라. 평범하게 시작하면 즉시 실패.
STEP 2 (Core): 스타일 공식에 맞는 핵심 감정 포인트 1개를 깊고 구체적으로 펼쳐라. 추상적 표현 금지.
STEP 3 (Punch): 마지막 대사 한 줄이 전체 영상의 가치를 결정한다. 짧고, 예상 밖이고, 여운이 남아야 한다.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    // 정보성 톤 여부 (프롬프트 조건 분기에 사용)
    // ① 톤이 정보성 ② 특별지침에 정보 관련 키워드 ③ 주제 자체가 정보성 — 셋 중 하나라도 해당하면 정보성 모드
    const infoKeywordPattern = /신청(방법)?|연락처|인터넷\s*주소|홈페이지|url|구체적|실질적|지원금|복지|세금|보험|전화번호|기관/i;
    const infoTopicPattern = /지원금|정부\s*지원|복지|세금|보험|연금|의료비?|취업\s*지원|채용|대출|금리|주거급여|장려금|바우처|수당|정책\s*안내|혜택\s*안내|신청\s*방법/;
    const isInfoScript = scriptTone === '정보 전달형 (명확하고 간결)' || scriptTone === '뉴스형 (객관적)' ||
      (specialInstructions && infoKeywordPattern.test(specialInstructions)) ||
      infoTopicPattern.test(topic);

    // 스토리텔링 대본 전용 서사 원칙 블록
    const narrativeBlock = !isInfoScript ? `
【서사 원칙${specialInstructions ? ' — 단, 🔴 사용자 특별 지침이 존재하므로 충돌 시 특별 지침 우선' : ' — 최우선 적용, 아래 모든 규칙보다 우선함'}】
- 소설·원작 기반 대본은 원작 줄거리와 장면을 정확히 따라가라. 임의로 내용을 만들거나 원작에 없는 해석·사건을 삽입하지 말 것. 원작의 사실이 이 대본의 유일한 근거다.
- 너는 이야기를 처음 듣는 시청자에게 들려주는 낭독자다. 시청자가 원작을 전혀 모른다고 가정하고 인물·배경·상황을 자연스럽게 소개하며 이야기만 풀어라.
- 이야기를 처음부터 끝까지 끊기지 않는 하나의 흐름으로 이어라.
- 챕터 번호(**1.** **2.** 등) 표시 절대 금지. 숫자 구분 없이 자연스럽게 이어질 것.
${specialInstructions ? '' : '- 현실 통계·정부 기관 정보·전화번호·홈페이지 삽입 절대 금지.\n'}- "우리 주변에서도", "실제로 많은 분들이", "현대 사회에서도" 등 현대 비교 표현 절대 금지.
- "이 이야기는 우리에게 ~를 말합니다" 등 직접 교훈·설교 절대 금지. 메시지는 장면과 감정으로만 전달할 것.
- "아직 제일 중요한 부분이 남았어요", "여기서 반전이 있습니다" 등 메타 표현 절대 금지.
- 시청자에게 경험을 묻거나 댓글 유도 질문 삽입 절대 금지.
- 마지막은 이야기의 여운 또는 다음 화에 대한 조용한 기대감으로 끝낼 것.
- 고유명사 표기 일관성 유지: 에베네저 스크루지, 밥 크래칫, 팀(Tiny Tim), 벨, 제이콥 말리.
` : '';

    // 채널 방향 지침 블록
    const chDirBlock = channelDirection.trim()
      ? `\n🎯 채널 방향 (항상 준수 — 모든 내용에 일관 적용):\n${channelDirection.trim()}\n`
      : '';

    // 사용자 커스텀 지침 블록 (시리즈 일괄 생성 등에서 전달)
    const customDirectiveBlock = customDirective.trim()
      ? `\n📋 화별 추가 지침 (위 서사 원칙에 더해 함께 적용):\n${customDirective.trim()}\n`
      : '';

    // 시리즈 지침 블록
    const seriesBlockKo = seriesName
      ? `\n📺 시리즈 정보 (반드시 반영):
- 이 대본은 "${seriesName}"의 제${episode}화입니다.
- 인트로에서 자연스럽게 "${episode}화"임을 녹여서 언급할 것
- ${episode === 1 ? '1화이므로 이야기의 배경, 시대, 주인공을 처음 듣는 사람도 자연스럽게 이해할 수 있도록 충분히 소개할 것' : '이전 화의 흐름이 자연스럽게 이어지도록 시작할 것'}
- ${isFinalEpisode
    ? '이 화가 시리즈의 마지막화다. 아웃트로에서 다음 화 예고 절대 금지. 대신 시리즈 전체 여정을 따뜻하게 마무리하는 피날레 엔딩으로 끝낼 것. "다음 화에서", "다음 영상에서 또 만나요" 등의 표현 절대 사용 금지.'
    : `아웃트로는 반드시 아래 순서로 구성할 것 (순서 변경 금지):\n① 공감형 클리프행어 질문 1~2개 — 이번 화 핵심 긴장 요소를 바탕으로, "과연 ~할 수 있을까요? 아니면 ~게 될까요?" 형식으로 시청자 감정을 자극할 것\n② 다음 화 예고: 다음 화에서 펼쳐질 핵심 내용을 1~2문장으로 간략히 예고한 뒤, "다음 ${episode + 1}화에서 그 이야기가 이어집니다." 로 마무리\n③ 구독 CTA 고정 문구 (단어 하나도 바꾸지 말 것): "아직 구독 안 하셨다면 지금 바로 구독 버튼을 눌러주세요! 좋아요와 댓글, 그리고 🔔 알림 설정까지 해주시면 새 영상을 가장 먼저 만나실 수 있어요. 여러분의 응원은 영상 제작에 큰 힘이 됩니다. 감사합니다, 다음 영상에서 또 만나요!"\n"오늘 영상이 도움이 되셨나요?" 절대 사용 금지`}
- 이 화의 대본만 완성할 것\n`
      : '';
    const seriesBlockEn = seriesName
      ? `\n📺 Series Info (MUST be reflected):
- This script is Episode ${episode} of "${seriesName}".
- Intro MUST naturally mention this is Episode ${episode} of the series.
- Outro MUST include a teaser for Episode ${episode+1} or "continued in the next episode".
- Each episode should be standalone but feel part of the series.\n`
      : '';

    // 쇼츠 전용 프롬프트 (짧고 강렬, Hook 구조)
    const shortsPrompt = scriptLang === 'en' ? `
You are a professional YouTube Shorts script writer.
${chDirBlock}${customDirectiveBlock}${seriesBlockEn}${getAccuracyRuleEn()}
Topic: ${topic}
Duration: ${videoLength}
Tone: ${scriptTone}

Output format — use ONLY the tags below, nothing outside:

[SCRIPT]
Full script here
[/SCRIPT]

STRICT RULES:
${introRuleEn}
1. Start with a powerful 1-2 sentence HOOK that grabs attention immediately
2. Every sentence MUST be short (≤15 words). No long compound sentences.
3. Script MUST be at least ${targetChars} characters total
4. Use vertical-video rhythm: punchy, direct, fast-paced
5. No chapter titles, no headers — one seamless flow
6. End with a clear CTA (like/comment/follow)
${outroRuleEn}
7. Must sound natural when read by TTS at normal speed
8. Spoken English only — no formal writing

${FORBIDDEN_EN}

Topic: ${topic}` : `
너는 유튜브 쇼츠 전문 스크립트 작가다.
${chDirBlock}${customDirectiveBlock}${seriesBlockKo}${getAccuracyRuleKo()}
주제: ${topic}
영상 길이: ${videoLength}
대본 톤: ${scriptTone}

반드시 아래 형식만 지켜라. 태그 외에 다른 설명 절대 쓰지 마라.

[SCRIPT]
완성된 대본 전체
[/SCRIPT]

${shortsStyleBlock}

⚠ 쇼츠 전용 규칙 (위반 시 무효):
${introRule}
1. 첫 1~2문장은 무조건 강렬한 훅(Hook) — 시청자가 스크롤을 멈추게 만들어라
2. 모든 문장은 짧게 (한 문장 15자 이내 권장). 긴 문장 금지.
3. 대본은 반드시 최소 ${targetChars}자 이상 (공백 포함)
4. 세로형 영상 리듬: 빠르고, 직접적이고, 강렬하게
5. 챕터 제목 없음 — 자연스럽게 이어지는 하나의 흐름
6. 마지막은 좋아요/댓글/구독 CTA로 마무리
${outroRule}
7. 반드시 구어체 (TTS 낭독용), 딱딱한 문어체 금지
8. 쉼표와 말줄임표로 자연스러운 호흡 표현

【시청 유지율 훅 — 반드시 삽입】
- 대본의 30% 지점: "근데 여기서 진짜 중요한 게 있어요…" 같은 리텐션 훅 1개 삽입
- 대본의 60% 지점: "아직 안 끝났어요. 이게 핵심이에요." 같은 리텐션 훅 1개 삽입
- 마지막 10% 직전: "마지막으로 꼭 기억하셔야 할 게 있어요." 같은 마무리 훅으로 끝까지 붙잡기
- 각 훅은 다음 내용이 궁금해지게 만들어야 함. 그냥 "계속 보세요" 금지.

【댓글 유도 CTA — 마지막 대사 필수】
- "좋아요/구독 눌러주세요" 단독 마무리 금지
- 반드시 시청자가 직접 답하고 싶은 질문 1개로 끝낼 것
- 예) "여러분은 이런 경험 있으신가요? 댓글로 알려주세요 👇"
- 질문은 주제와 연결된 구체적인 개인 경험을 묻는 형태로

${FORBIDDEN_KO}

주제: ${topic}`;

    // 사용자 특별 지침 블록
    const specialBlock = specialInstructions && specialInstructions.trim()
      ? specialInstructions.trim()
      : '';
    const specialBlockKo = specialBlock
      ? `\n🔴 사용자 특별 지침 (절대 최우선 적용 — 서사 원칙·정확성 규칙 포함 아래의 모든 규칙보다 우선. 특별 지침과 다른 규칙이 충돌하면 반드시 특별 지침을 따를 것. 특별 지침의 모든 항목을 빠짐없이 검토하고 대본에 반영할 것):\n${specialBlock}\n`
      : '';
    const specialBlockEn = specialBlock
      ? `\n🔴 USER SPECIAL INSTRUCTIONS (ABSOLUTE HIGHEST PRIORITY — override all rules below including narrative and accuracy rules. Review every item in the special instructions and reflect them fully in the script):\n${specialBlock}\n`
      : '';

    const scriptPrompt = isShorts ? shortsPrompt : scriptLang === 'en' ? `
You are a professional YouTube long-form content writer.
${chDirBlock}${customDirectiveBlock}${specialBlockEn}${seriesBlockEn}${getAccuracyRuleEn()}
Topic: ${topic}
Video length: ${videoLength}
Script tone: ${scriptTone}

Follow ONLY the format below. Do NOT add any explanation outside the tags.

[SCRIPT]
Full completed script here
[/SCRIPT]

CRITICAL LENGTH RULES — violation = rejected output:
${introRuleEn}
1. Script MUST be at least ${targetChars} characters including spaces. COUNT carefully.
2. ${videoLength} of audio requires approximately ${targetChars} characters at natural speaking pace.
3. Do NOT end early. Keep writing until you reach the minimum character count.
4. Must be conversational spoken English
5. No formal or stiff sentences
6. Use commas, ellipses, short sentences for rhythm
7. Must sound natural when read by TTS
${chapterRule}
9. End with a warm, uplifting closing
${outroRuleEn}

${FORBIDDEN_EN}

Topic: ${topic}` : `
너는 한국 유튜브 롱폼 콘텐츠 전문 작가다.
${chDirBlock}${customDirectiveBlock}${specialBlockKo}${seriesBlockKo}${narrativeBlock}${isInfoScript ? getAccuracyRuleKo() : ''}
주제: ${topic}
영상 길이: ${videoLength}
대본 톤: ${scriptTone}

반드시 아래 형식만 지켜라. 태그 외에 다른 설명문 절대 쓰지 마라.

[SCRIPT]
완성된 대본 전체
[/SCRIPT]

⚠ 길이 규칙 (위반 시 무효):
${introRule}
1. 대본은 반드시 공백 포함 최소 ${targetChars}자 이상. 글자 수를 직접 세어라.
2. ${videoLength} 영상에는 자연스러운 낭독 속도 기준 약 ${targetChars}자가 필요하다.
3. 절대 중간에 끊지 마라. 최소 글자 수에 도달할 때까지 계속 써라.
4. 반드시 구어체 (TTS 낭독용)
5. 문어체, 딱딱한 문장 금지
6. 쉼표, 말줄임표, 짧은 문장으로 리듬감
7. TTS에 바로 넣어도 어색하지 않게
${chapterRule}
9. 마지막은 따뜻한 마무리로 완결
${outroRule}

【표현 규칙】
- "나옵니다" 표현 금지: "사실이 나옵니다", "내용이 나옵니다" 등 "나옵니다" 대신 반드시 "있습니다"로 쓸 것. 예) "이런 사실이 있습니다."

【시청 유지율 훅 — 반드시 삽입 (알고리즘 생존 규칙)】
- 대본의 30% 지점: 시청자가 이탈하려는 순간을 붙잡는 리텐션 훅 삽입. 예) "잠깐, 여기서부터가 핵심이에요." / "이 다음이 핵심이에요, 잠깐만요."
- 대본의 60% 지점: 두 번째 리텐션 훅으로 끝까지 붙잡기. 예) "아직 끝이 아니에요, 이 부분이 진짜예요." / "여기서부터 이야기가 달라집니다."
- 대본의 90% 지점: 마무리 직전 마지막 훅. 예) "마지막으로 꼭 기억하셔야 할 게 있어요."
- 훅은 자연스럽게 흐름에 녹아야 함. 억지로 끼워넣은 느낌 금지.

【마무리 — 스토리텔링 대본】
${isInfoScript ? `- "좋아요/구독 눌러주세요" 단독 마무리 절대 금지
- 시청자가 직접 답하고 싶은 개인 경험 질문 1개로 마무리할 것
- 질문은 주제와 연결되고, 답하기 쉽고, 공감대가 형성되는 내용으로
- 예) "여러분도 이런 순간 있으셨나요? 댓글로 이야기 나눠요 👇"` : `- 시청자에게 직접 질문하거나 경험을 묻는 CTA 금지
- 여운이 남는 한 문장 또는 조용한 희망으로 끝낼 것
- 좋아요/구독 CTA는 자연스럽게 한 줄로만 간결하게`}

${FORBIDDEN_KO}

주제: ${topic}`;

    // 이야기/감동/미담/교훈 등 스토리 콘텐츠는 웹 검색 불필요

    const sMaxTokens = scriptMaxTokens(videoLength);
    let scriptRaw = await geminiText({
      apiKey: geminiKey,
      prompt: scriptPrompt,
      maxTokens: sMaxTokens,
      temp: 0.85,
      model: 'gemini-2.5-flash',
      useSearch: isInfoScript,
    });
    let script = parseSingleTag(scriptRaw, 'SCRIPT') || scriptRaw;

    // 길이 부족 시 1회 이어쓰기
    if (script.length < targetChars * 0.7) {
      console.log(`[Script] 길이 부족 (${script.length}자 / 목표 ${targetChars}자) → 이어쓰기`);
      const contPrompt = scriptLang === 'en'
        ? `The script below is too short. Continue it naturally from where it ends. Write at least ${targetChars - script.length} more characters. Output ONLY the continuation (no tags).\n\n---CURRENT END---\n${script.slice(-600)}`
        : `아래 대본이 너무 짧다. 끊긴 지점부터 자연스럽게 이어서 써라. 추가로 최소 ${targetChars - script.length}자 이상 작성하라. 태그 없이 이어지는 본문만 출력하라.\n\n---현재 끝 부분---\n${script.slice(-600)}`;
      const cont = await geminiText({
        apiKey: geminiKey,
        prompt: contPrompt,
        maxTokens: sMaxTokens,
        temp: 0.85,
        model: 'gemini-2.5-flash',
        useSearch: isInfoScript,
      });
      script = script + '\n' + cont.trim();
      console.log(`[Script] 이어쓰기 후 ${script.length}자`);
    }

    // 2. 메타 병렬 (gemini-2.5-flash 사용 — 형식 준수 안정성 향상)
    const metaModel = 'gemini-2.5-flash';
    const [titleRaw, descRaw, tagsRaw, thumbRaw] = await Promise.all([
      geminiText({ apiKey: geminiKey, temp: 0.8, model: metaModel, maxTokens: 2048, thinkingBudget: 0, prompt:
        `주제: ${topic}\n아래 대본을 참고해서 유튜브 제목 5개를 생성하라.\n⚠ 반드시 아래 형식 그대로만 출력하라. 다른 말 절대 쓰지 마라.\n\n[TITLES]\n제목1\n제목2\n제목3\n제목4\n제목5\n[/TITLES]\n[SELECTED_TITLE]\n추천 제목\n[/SELECTED_TITLE]\n\n대본:\n${script.slice(0,6000)}` }),
      geminiText({ apiKey: geminiKey, temp: 0.7, model: metaModel, maxTokens: 1024, thinkingBudget: 0, prompt:
        `주제: ${topic}\n아래 대본을 참고해서 유튜브 설명글을 220~350자로 작성하라.\n⚠ 반드시 아래 형식만 출력하라.\n\n[DESCRIPTION]\n설명글\n[/DESCRIPTION]\n\n대본:\n${script.slice(0,6000)}` }),
      geminiText({ apiKey: geminiKey, temp: 0.7, model: metaModel, maxTokens: 1024, thinkingBudget: 0, prompt:
        `주제: ${topic}\n아래 대본을 참고해서 해시태그 12~18개를 생성하라.\n⚠ 반드시 아래 형식만 출력하라.\n\n[HASHTAGS]\n#태그1 #태그2 ...\n[/HASHTAGS]\n\n대본:\n${script.slice(0,6000)}` }),
      geminiText({ apiKey: geminiKey, temp: 0.8, model: metaModel, maxTokens: 1024, thinkingBudget: 0, prompt:
        `주제: ${topic}\n아래 대본을 참고해서 유튜브 썸네일 문구 5개(8~16자)를 생성하라.\n⚠ 반드시 아래 형식만 출력하라.\n\n[THUMBNAILS]\n문구1\n문구2\n문구3\n문구4\n문구5\n[/THUMBNAILS]\n[SELECTED_THUMBNAIL]\n추천 문구\n[/SELECTED_THUMBNAIL]\n\n대본:\n${script.slice(0,6000)}` }),
    ]);

    const titles             = parseListBlock(titleRaw, '[TITLES]', '[/TITLES]').slice(0, 5);
    const selectedTitle      = parseSingleTag(titleRaw, 'SELECTED_TITLE');
    const description        = parseSingleTag(descRaw, 'DESCRIPTION');
    const hashtags           = normalizeHashtags(parseSingleTag(tagsRaw, 'HASHTAGS'));
    const thumbnailTexts     = parseListBlock(thumbRaw, '[THUMBNAILS]', '[/THUMBNAILS]').slice(0, 5);
    const selectedThumbnail  = parseSingleTag(thumbRaw, 'SELECTED_THUMBNAIL');

    // 저장
    fs.writeFileSync(pDir(projectId, 'script.txt'), script);
    saveNamedScript(topic, seriesName || '', Number(episode) || 1, script);
    const meta = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
    Object.assign(meta, {
      topic, videoLength, scriptTone, chapterCount, scriptLang,
      channelName: chName || '',
      specialInstructions: specialInstructions || '',
      isShorts: !!isShorts,
      seriesName: seriesName || '',
      episode: Number(episode) || 1,
      titles, selectedTitle, description, hashtags,
      thumbnailTexts, selectedThumbnail,
      status: 'script_done'
    });
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));

    res.json({ script, titles, selectedTitle, description, hashtags, thumbnailTexts, selectedThumbnail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 대본 저장 (수정 후 확정) — 썸네일 문구 자동 재생성
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/script/save', async (req, res) => {
  const { projectId, script } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!projectId || !script) return res.status(400).json({ error: 'projectId, script 필요' });
  const scriptPath = pDir(projectId, 'script.txt');
  if (!fs.existsSync(path.dirname(scriptPath))) return res.status(400).json({ error: '프로젝트 없음' });
  fs.writeFileSync(scriptPath, script.replace(/\r\n/g, '\n'));
  const meta = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
  saveNamedScript(meta.topic || '무제', meta.seriesName || '', Number(meta.episode) || 1, script);
  meta.status = 'script_confirmed';

  // 썸네일 문구 재생성 (geminiKey 있을 때만)
  if (geminiKey) {
    try {
      const topic = meta.topic || '';
      const thumbRaw = await geminiText({
        apiKey: geminiKey, temp: 0.8, maxTokens: 512, thinkingBudget: 0,
        prompt: `주제: ${topic}\n아래 대본을 참고해서 유튜브 썸네일 문구 5개(8~16자)를 생성하라.\n⚠ 반드시 아래 형식만 출력하라.\n\n[THUMBNAILS]\n문구1\n문구2\n문구3\n문구4\n문구5\n[/THUMBNAILS]\n[SELECTED_THUMBNAIL]\n추천 문구\n[/SELECTED_THUMBNAIL]\n\n대본:\n${script.slice(0, 6000)}`
      });
      const thumbnailTexts    = parseListBlock(thumbRaw, '[THUMBNAILS]', '[/THUMBNAILS]').slice(0, 5);
      const selectedThumbnail = parseSingleTag(thumbRaw, 'SELECTED_THUMBNAIL');
      if (thumbnailTexts.length) {
        meta.thumbnailTexts    = thumbnailTexts;
        meta.selectedThumbnail = selectedThumbnail;
      }
    } catch (_) {}
  }

  fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));
  res.json({ ok: true, thumbnailTexts: meta.thumbnailTexts, selectedThumbnail: meta.selectedThumbnail });
});

// ─────────────────────────────────────────────────────────────────────────────
// 장면 생성
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scenes/generate', async (req, res) => {
  const { projectId, imageStyle = 'Cinematic realistic photography', characterDesc = '' } = req.body;
  let { sceneCount = 15 } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!projectId) return res.status(400).json({ error: 'projectId 필요' });

  const scriptPath = pDir(projectId, 'script.txt');
  if (!fs.existsSync(scriptPath)) return res.status(400).json({ error: '대본 먼저 생성하세요' });

  const script = fs.readFileSync(scriptPath, 'utf8');
  const meta   = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));

  // 정보성 콘텐츠 감지 (주제 또는 톤 기준)
  const infoTopicRe = /지원금|정부\s*지원|복지|세금|보험|연금|의료비?|취업\s*지원|채용|대출|금리|주거급여|장려금|바우처|수당|정책|혜택\s*안내|신청\s*방법/;
  const isInfoContent = infoTopicRe.test(meta.topic || '') ||
    meta.scriptTone === '정보 전달형 (명확하고 간결)' ||
    meta.scriptTone === '뉴스형 (객관적)';

  // 쇼츠 모드: 장면 수 최대 15로 제한 (길이별 유연하게)
  const isShorts = !!meta.isShorts;
  if (isShorts) sceneCount = Math.min(Number(sceneCount) || 5, 15);

  // 대본을 sceneCount 등분 → 각 장면이 대본의 특정 구간을 직접 담당
  const scriptNorm = script.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const chunkSize  = Math.ceil(scriptNorm.length / sceneCount);
  const chunks     = Array.from({ length: sceneCount }, (_, i) =>
    scriptNorm.slice(i * chunkSize, (i + 1) * chunkSize).trim()
  );

  const template = chunks.map((chunk, i) => `
[SCENE]
NUMBER: ${i}
[SCRIPT_CHUNK]
${chunk.slice(0, 400)}
[/SCRIPT_CHUNK]
TITLE: 장면 제목
RELATED_KO: 위 SCRIPT_CHUNK에서 핵심 대사 1문장 한국어 원문 그대로
RELATED_EN: English translation of the above Korean line (natural spoken English)
MOOD: 분위기
SEARCH: 3-5 English keywords (SCRIPT_CHUNK 내용 기반, 스타일/색상 단어 금지)
PROMPT: image prompt in English (include style: ${imageStyle})
[/SCENE]`).join('\n');

  // ── 한국어 인물 설명 → 영어 비주얼 설명 자동 변환 ─────────────────────────
  let visualCharDesc = characterDesc;
  if (characterDesc && /[가-힣]/.test(characterDesc)) {
    console.log('[Scenes] 한국어 인물 설명 감지 — 영어 비주얼 변환 중…');
    try {
      const converted = await geminiText({
        apiKey: geminiKey,
        prompt: `You are an image prompt engineer. Convert the following Korean character descriptions into concise English visual appearance descriptions for image generation.

Korean character descriptions:
${characterDesc}

Rules:
- Extract ONLY physical/visual appearance (age, body type, face, hair, clothing, accessories)
- Remove personality traits, roles, and story context
- One line per character: "Name: visual description"
- English only, max 30 words per character
- Output ONLY the result, nothing else`,
        maxTokens: 400,
        temp: 0.2
      });
      if (converted && converted.trim().length > 5) {
        visualCharDesc = converted.trim();
        console.log('[Scenes] 변환 완료:', visualCharDesc);
      }
    } catch (e) {
      console.log('[Scenes] 인물 변환 실패, 원본 사용:', e.message);
    }
  }

  // 신체 특성(장애/상처) 감지 — 대본에 언급 없어도 모든 씬에 강제 적용
  const physicalRules = visualCharDesc ? (() => {
    const checks = [
      { pattern: /left arm|왼팔|왼쪽\s*팔/i,   rule: '⚠️ MANDATORY EVERY SCENE: left arm is permanently crippled/paralyzed, hanging limp at side — NEVER draw left arm as functional or raised' },
      { pattern: /right arm|오른팔|오른쪽\s*팔/i, rule: '⚠️ MANDATORY EVERY SCENE: right arm is permanently crippled/paralyzed, hanging limp at side — NEVER draw right arm as functional or raised' },
      { pattern: /blind|실명|장님|한쪽\s*눈/i,   rule: '⚠️ MANDATORY EVERY SCENE: one eye is permanently scarred/closed — NEVER draw both eyes as normal' },
      { pattern: /limp|절름|다리.*다쳐/i,         rule: '⚠️ MANDATORY EVERY SCENE: character has permanent limp — NEVER draw as walking normally' },
      { pattern: /scar|흉터/i,                  rule: '⚠️ MANDATORY EVERY SCENE: visible scars must always appear on character' },
    ];
    return checks.filter(c => c.pattern.test(visualCharDesc)).map(c => c.rule).join('\n');
  })() : '';

  // scenePrompt 함수 선언 (visualCharDesc 확정 후)
  const scenePrompt = (tmpl) => `주제: ${meta.topic}
이미지 스타일: ${imageStyle}
${visualCharDesc ? `등장인물 외모 (모든 장면 일관성 필수): ${visualCharDesc}` : ''}

각 [SCENE] 블록 안의 [SCRIPT_CHUNK]를 읽고, 그 내용을 그대로 시각화하는 이미지 프롬프트를 작성하라.
반드시 아래 형식만 지켜라. 다른 설명문 절대 쓰지 마라.

${tmpl}

규칙:
- RELATED_KO: 해당 SCRIPT_CHUNK의 핵심 대사 1문장을 한국어 원문 그대로 인용
- RELATED_EN: RELATED_KO를 자연스러운 영어 구어체로 번역 (1문장)
- SEARCH: SCRIPT_CHUNK에 등장하는 실제 인물/사물/장소/행동을 영어로 (스타일 단어 절대 금지)${visualCharDesc ? '. 인물이 등장하면 외모 키워드 반드시 포함' : ''}
- PROMPT: SCRIPT_CHUNK 장면을 구체적으로 묘사하는 영어 이미지 프롬프트 (이미지 스타일 포함, ${isInfoContent ? '내용·상황·환경 중심으로 시각화. 설명하는 사람 위주 금지 — 대신 그 정보가 실제로 적용되는 장면을 보여줄 것. 예) 소상공인 지원이면 활기찬 가게 내부, 취업지원이면 직업훈련 현장, 복지수당이면 가족이 안도하는 생활 공간, 정부지원이면 서류를 처리하는 손과 사무 환경' : '인물·행동·배경·감정·조명 포함'}${visualCharDesc ? '. 인물은 반드시 등장인물 외모와 일치하게 묘사' : ''})
- PROMPT 작성 시 절대 금지: 간판·현수막·포스터·문서·화면·인포그래픽·차트·숫자·전화번호·URL·기관명 등 텍스트가 포함될 수 있는 오브젝트 묘사 금지. ${isInfoContent ? '대신 상황·공간·사람들의 표정·행동으로 정보의 실질적 의미를 시각화할 것' : '대신 인물·표정·행동·자연·배경·감정으로 시각화할 것'}
- 반드시 ${sceneCount}개 [SCENE]...[/SCENE] 블록을 모두 완성하라. 절대 생략하지 마라.

${FORBIDDEN_EN}`;

  // 배치 크기: 한 번에 최대 8장면 (포맷 유지 안정성)
  const BATCH = 5; // 5장씩 배치 (8→5로 줄여 누락 방지)

  const shortsStyleHint = isShorts ? ', vertical portrait 9:16 framing, centered subject, close-up or medium shot, bold composition' : '';
  const makeBatchTemplate = (batchChunks) =>
    batchChunks.map(({ idx, chunk }) => `
[SCENE]
NUMBER: ${idx}
SCRIPT_CHUNK: ${chunk.slice(0, 350)}
TITLE: (장면 제목)
RELATED_KO: (위 SCRIPT_CHUNK 핵심 대사 1문장 한국어 원문)
RELATED_EN: (English translation, natural spoken)
MOOD: (분위기)
SEARCH: (3-5 English keywords, NO style words)
PROMPT: (image prompt in English, include style: ${imageStyle}${shortsStyleHint})
PROMPT_KO: (위 PROMPT가 담은 장면 내용을 한국어로 1~2문장 설명)
CHUNK_EN: (SCRIPT_CHUNK 전체를 자연스러운 영어로 번역, 원문 길이 유지)
[/SCENE]`).join('\n');

  const buildPrompt = (tmpl, prevScenePrompt = '', firstScenePrompt = '') =>
`주제: ${meta.topic}
이미지 스타일: ${imageStyle}
${visualCharDesc ? `등장인물 외모 (일관성 필수): ${visualCharDesc}` : ''}
${physicalRules ? `\n${physicalRules}\n` : ''}${firstScenePrompt ? `🎬 1번 씬 PROMPT (전체 기준점 — 끝까지 인물·배경 일관성 유지): ${firstScenePrompt}` : ''}
${prevScenePrompt ? `⬆ 바로 이전 씬 PROMPT (직전 연속성 참고): ${prevScenePrompt}` : ''}

아래 각 [SCENE] 블록의 SCRIPT_CHUNK를 읽고 빈 칸을 채워라.
반드시 [SCENE]...[/SCENE] 형식을 유지하라. 다른 설명문 절대 쓰지 마라.

${tmpl}

규칙:
- RELATED_KO: SCRIPT_CHUNK에서 핵심 대사 1문장 한국어 원문 그대로
- RELATED_EN: 위를 자연스러운 영어 구어체로 번역
- SEARCH: 실제 등장 인물/사물/장소/행동 영어 키워드${visualCharDesc ? ', 인물 외모 키워드 포함' : ''}
- PROMPT: ⭐ 반드시 이 씬의 SCRIPT_CHUNK에서 묘사하는 실제 장면·행동·인물·배경만 시각화하라. 이 씬 번호의 SCRIPT_CHUNK와 무관한 이미지 절대 금지. 영어 이미지 프롬프트 (인물·행동·배경·조명 순서로 구체적으로)${visualCharDesc ? ', 인물 외모 일치 필수' : ''}. 28번 씬이면 28번 SCRIPT_CHUNK만, 30번 씬이면 30번 SCRIPT_CHUNK만 시각화할 것 — 앞 씬 내용 반복 금지. ⚠ PROMPT에 절대 포함 금지: 따옴표 안 문장, 대사 인용, | 기호 이후 텍스트, text, letters, words, subtitles, captions, watermark, sign, banner, typography, writing, quote — 이미지 안에 어떤 글자도 없어야 함. PROMPT는 순수 시각 묘사만.
- PROMPT_KO: 위 PROMPT가 담은 장면 내용을 한국어로 1~2문장 설명 (이미지 프롬프트 해석)
- CHUNK_EN: SCRIPT_CHUNK 전체를 자연스러운 영어로 번역 (원문 길이 그대로, 요약 금지)
- [SCENE]과 [/SCENE] 태그는 반드시 유지

【씬 연속성 규칙 — 필수】
- 같은 씬 내: 인물 외모·복장·배경이 처음부터 끝까지 일관되게 유지
- 연속된 씬 사이: 앞 씬 끝부분의 인물·장소·분위기가 다음 씬 시작과 자연스럽게 이어져야 함
- 장소·배경이 바뀔 경우에도 인물 외모(복장 등)는 동일하게 유지
- 급격한 배경·인물 단절 금지 — 시청자가 같은 이야기를 보고 있다는 느낌이 유지되어야 함
${firstScenePrompt ? `- 1번 씬 PROMPT를 전체 기준으로 삼아 인물·배경의 세계관을 끝까지 일관되게 유지할 것` : ''}
${prevScenePrompt ? `- 이전 씬 PROMPT를 참고해 이 배치 첫 번째 씬의 인물·배경을 자연스럽게 연결할 것` : ''}

${FORBIDDEN_EN}`;

  try {
    // ── 배치 단위로 장면 생성 ────────────────────────────────────────────────
    const allChunks = chunks.map((chunk, i) => ({ idx: i + 1, chunk }));
    let scenes = [];
    let firstScenePrompt = '';  // 1번 씬 PROMPT — 전체 연속성 기준점
    let prevScenePrompt  = '';  // 직전 배치 마지막 씬 PROMPT

    for (let b = 0; b < allChunks.length; b += BATCH) {
      const batch = allChunks.slice(b, b + BATCH);
      console.log(`[SCENES] 배치 ${Math.floor(b/BATCH)+1} — 장면 ${batch[0].idx}~${batch[batch.length-1].idx}`);
      try {
        const raw = await geminiText({
          apiKey: geminiKey,
          prompt: buildPrompt(makeBatchTemplate(batch), prevScenePrompt, firstScenePrompt),
          maxTokens: 8192,
          temp: 0.7,
          model: 'gemini-2.5-flash',
          thinkingBudget: 0
        });
        const parsed = parseScenes(raw);
        console.log(`[SCENES] 배치 결과: ${parsed.length}/${batch.length}`);
        if (parsed.length === 0) console.log('[SCENES] raw 첫200자:', raw.slice(0, 200));
        scenes.push(...parsed);
        // 1번 씬 기준점 저장 (최초 1회)
        if (parsed.length > 0 && !firstScenePrompt) {
          firstScenePrompt = (parsed[0].prompt || '').slice(0, 200);
        }
        // 다음 배치 연속성을 위해 마지막 씬 PROMPT 저장
        if (parsed.length > 0) {
          const last = parsed[parsed.length - 1];
          prevScenePrompt = (last.prompt || '').slice(0, 250);
        }
      } catch (e) {
        console.log(`[SCENES] 배치 오류: ${e.message}`);
      }
      // 배치 사이 1초 대기
      if (b + BATCH < allChunks.length) await new Promise(ok => setTimeout(ok, 1000));
    }

    // 누락 장면 1회 재시도
    const existNums = new Set(scenes.map(s => s.sceneNumber));
    const missing = allChunks.filter(({ idx }) => !existNums.has(idx));
    if (missing.length > 0) {
      console.log(`[SCENES] 누락 ${missing.length}개 재시도: ${missing.map(m=>m.idx).join(',')}`);
      for (let b = 0; b < missing.length; b += BATCH) {
        const batch = missing.slice(b, b + BATCH);
        try {
          const raw2 = await geminiText({
            apiKey: geminiKey,
            prompt: buildPrompt(makeBatchTemplate(batch)),
            maxTokens: 8192,
            temp: 0.5,
            model: 'gemini-2.5-flash',
            thinkingBudget: 0
          });
          scenes.push(...parseScenes(raw2));
        } catch (e) {
          console.log(`[SCENES] 재시도 배치 오류: ${e.message}`);
        }
        if (b + BATCH < missing.length) await new Promise(ok => setTimeout(ok, 1000));
      }
      scenes = [...new Map(scenes.map(s => [s.sceneNumber, s])).values()]
        .sort((a, b) => a.sceneNumber - b.sceneNumber);
      console.log(`[SCENES] 최종 ${scenes.length}/${sceneCount}`);
    }

    // ── 원본 스크립트 청크 씬별 저장 ────────────────────────────────────────────
    const chunkMap = Object.fromEntries(allChunks.map(({ idx, chunk }) => [idx, chunk]));
    scenes.forEach(sc => { sc.scriptChunk = chunkMap[sc.sceneNumber] || ''; });

    // ── 캐릭터 태그 → 모든 씬 searchQuery에 자동 주입 ──────────────────────────
    let charTags = '';
    if (visualCharDesc && visualCharDesc.trim()) {
      // 영어 시각 키워드만 추출 (3글자 이상, 불용어 제외)
      const stopWords = new Set(['with','from','that','this','their','have','into','also','each','very','such','long','dark','pale','light']);
      const words = visualCharDesc
        .replace(/[^a-zA-Z\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w.toLowerCase()));
      // 중복 제거 후 최대 5단어
      charTags = [...new Set(words)].slice(0, 5).join(' ');
    }
    if (charTags) {
      scenes.forEach(sc => {
        sc.searchQuery = sc.searchQuery ? `${sc.searchQuery} ${charTags}` : charTags;
      });
      console.log(`[Scenes] 캐릭터 태그 주입: "${charTags}"`);
    }

    meta.scenes = scenes;
    meta.imageStyle = imageStyle;
    meta.characterDescOriginal = characterDesc;
    meta.characterDesc = visualCharDesc;
    meta.charTags = charTags;
    meta.status = 'scenes_done';
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));

    res.json({ scenes, requested: sceneCount, generated: scenes.length, visualCharDesc, charTags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TTS 생성 (SSE 스트리밍)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/tts/generate', async (req, res) => {
  const { projectId, voiceName = 'Aoede', speed = 'normal' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) { res.status(400).json({ error: 'Gemini API Key 필요 (UI에서 입력 후 저장하세요)' }); return; }
  if (!projectId) { res.status(400).json({ error: 'projectId 필요' }); return; }

  const scriptPath = pDir(projectId, 'script.txt');
  if (!fs.existsSync(scriptPath)) { res.status(400).json({ error: '대본 먼저 생성하세요' }); return; }

  // TTS 전용 청크 크기 (작게 유지해야 타임아웃 방지)
  const meta      = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
  const ttsLang   = meta.scriptLang || 'ko';
  const chunkSize = ttsChunkSize();
  console.log(`[TTS] videoLength=${meta.videoLength} lang=${ttsLang} → TTS chunkSize=${chunkSize}자`);

  sseHeaders(res);

  // ── SSE 연결 유지 (20초마다 keepalive ping) ──────────────────────────────
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) {} }, 20_000);

  const script   = fs.readFileSync(scriptPath, 'utf8');
  const audioDir = pDir(projectId, 'audio');
  mkDir(audioDir);

  const segments = splitScript(script, chunkSize);
  const results  = [];

  sseSend(res, { type: 'start', total: segments.length });

  for (let i = 0; i < segments.length; i++) {
    const seg      = segments[i];
    const fileName = `segment_${String(i + 1).padStart(3, '0')}.wav`;
    const filePath = path.join(audioDir, fileName);

    sseSend(res, { type: 'progress', index: i + 1, total: segments.length, text: seg.slice(0, 60) + '…' });

    try {
      const b64 = await geminiTTS({ apiKey: geminiKey, text: seg, voiceName, lang: ttsLang });
      const wav = pcmToWav(b64);
      fs.writeFileSync(filePath, wav);

      // 속도 조정 (보통 제외) — FFmpeg atempo 필터
      const atempo = resolveAtempo(speed);
      console.log(`[Speed] segment_${i+1} speed=${speed} atempo=${atempo}`);
      if (atempo !== 1.0) {
        const tmpPath = filePath + '.tmp.wav';
        try {
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(filePath)
              .audioFilters(`atempo=${atempo}`)
              .audioCodec('pcm_s16le')
              .audioFrequency(24000)
              .audioChannels(1)
              .output(tmpPath)
              .on('end', () => { console.log(`[Speed] segment_${i+1} atempo 완료`); resolve(); })
              .on('error', (e) => { console.error(`[Speed] segment_${i+1} atempo 오류:`, e.message); reject(e); })
              .run();
          });
          fs.renameSync(tmpPath, filePath);
        } catch(e) {
          console.error('[Speed] atempo 실패, 원본 사용:', e.message);
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
      }

      // ── 세그먼트별 노이즈 제거 + 볼륨 정규화 (톤 일관성 확보) ──
      const normTmp = filePath + '.norm.wav';
      try {
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(filePath)
            // highpass: 저음 잡음 제거 / afftdn: 배경 노이즈 / loudnorm: 세그먼트별 볼륨 통일
            .audioFilters('highpass=f=80,afftdn=nf=-25,loudnorm=I=-18:TP=-1.5:LRA=5:linear=true')
            .audioCodec('pcm_s16le')
            .audioFrequency(24000)
            .audioChannels(1)
            .output(normTmp)
            .on('end', () => {
              fs.renameSync(normTmp, filePath);
              console.log(`[Denoise] segment_${i+1} 정규화 완료`);
              resolve();
            })
            .on('error', (e) => {
              console.warn(`[Denoise] segment_${i+1} 정규화 실패, 원본 사용:`, e.message);
              if (fs.existsSync(normTmp)) fs.unlinkSync(normTmp);
              resolve();
            })
            .run();
        });
      } catch (_) { /* 실패해도 원본으로 진행 */ }

      const dur = await audioDuration(filePath);
      const row = { index: i + 1, fileName, duration: dur, durationFmt: fmtSec(dur), text: seg.slice(0, 80), url: `/api/project/${projectId}/audio/${fileName}` };
      results.push(row);
      sseSend(res, { type: 'segment', ...row });
    } catch (err) {
      const row = { index: i + 1, fileName, error: err.message, text: seg.slice(0, 80) };
      results.push(row);
      sseSend(res, { type: 'segment_error', ...row });
    }

    // 구간 사이 1초 대기 — Gemini API 레이트 리밋 방지 (마지막 구간 제외)
    if (i < segments.length - 1) {
      await new Promise(ok => setTimeout(ok, 1000));
    }
  }

  // 전체 오디오 합치기
  const okFiles = results.filter(r => !r.error).map(r => path.join(audioDir, r.fileName));
  const fullPath = path.join(audioDir, 'audio_full.wav');
  let totalDuration = 0;
  let mergeError = null;

  // 세그먼트 duration 합산 (fallback용)
  const sumDuration = results.filter(r => !r.error).reduce((acc, r) => acc + (r.duration || 0), 0);

  if (okFiles.length > 1) {
    const listFile    = path.join(audioDir, 'concat.txt');
    const listContent = okFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    sseSend(res, { type: 'merging' });

    // ── 크로스페이드 병합: 세그먼트 경계에서 80ms 자연스럽게 섞음 ──────────────
    const XFADE_MS = 0.08; // 80ms 크로스페이드
    const mergeWithCrossfade = async () => {
      if (okFiles.length === 1) {
        fs.copyFileSync(okFiles[0], fullPath);
        return;
      }
      // 첫 번째 = 베이스, 이후 순차적으로 acrossfade 체이닝
      let currentPath = okFiles[0];
      for (let ci = 1; ci < okFiles.length; ci++) {
        const outCf = path.join(audioDir, `_cf_${ci}.wav`);
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(currentPath)
            .input(okFiles[ci])
            .complexFilter([`[0:a][1:a]acrossfade=d=${XFADE_MS}:c1=tri:c2=tri[aout]`])
            .map('[aout]')
            .audioCodec('pcm_s16le')
            .audioFrequency(24000)
            .audioChannels(1)
            .output(outCf)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        // 이전 임시파일 정리 (원본 okFiles는 제외)
        if (ci > 1 && currentPath.includes('_cf_')) {
          try { fs.unlinkSync(currentPath); } catch (_) {}
        }
        currentPath = outCf;
      }
      fs.copyFileSync(currentPath, fullPath);
      try { fs.unlinkSync(currentPath); } catch (_) {}
      // 남은 임시 크로스페이드 파일 정리
      for (let ci = 1; ci < okFiles.length; ci++) {
        const f = path.join(audioDir, `_cf_${ci}.wav`);
        if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
      }
    };

    // 병합 시도 함수 (단순 concat fallback용)
    const runMerge = (opts) => new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(opts)
        .output(fullPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    try {
      // 1차: 크로스페이드 병합 (경계 자연스럽게)
      await mergeWithCrossfade();
      console.log('[TTS] 크로스페이드 병합 성공');
    } catch (e1) {
      console.log('[TTS] 크로스페이드 실패, loudnorm 단순병합 시도:', e1.message);
      try {
        // 2차: loudnorm 병합
        await runMerge(['-af', 'loudnorm=I=-16:LRA=7:TP=-1.5:linear=true', '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1']);
        console.log('[TTS] loudnorm 병합 성공');
      } catch (e2) {
        console.log('[TTS] loudnorm 실패, 단순 재인코딩:', e2.message);
        try {
          // 3차: 정규화 없이 재인코딩
          await runMerge(['-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1']);
          console.log('[TTS] 단순 재인코딩 병합 성공');
        } catch (e3) {
          mergeError = e3.message;
          console.log('[TTS] 병합 완전 실패:', e3.message);
        }
      }
    }

    // ── 후행 무음 제거 (TTS API가 생성한 끝부분 무음 구간 제거) ──────────────
    const trimTmp = path.join(audioDir, '_trim_silence.wav');
    try {
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(fullPath)
          // stop_periods=-1: 끝에서 무음 구간 제거 / stop_duration=0.5: 0.5초 이상 무음 / stop_threshold=-50dB
          .audioFilters('silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-50dB')
          .audioCodec('pcm_s16le')
          .audioFrequency(24000)
          .audioChannels(1)
          .output(trimTmp)
          .on('end', () => {
            // 결과물이 정상 크기인지 확인 후 교체
            if (fs.existsSync(trimTmp) && fs.statSync(trimTmp).size > 1000) {
              fs.renameSync(trimTmp, fullPath);
              console.log('[TTS] 후행 무음 제거 완료');
            } else {
              if (fs.existsSync(trimTmp)) fs.unlinkSync(trimTmp);
              console.log('[TTS] 후행 무음 제거 결과 비정상 → 원본 유지');
            }
            resolve();
          })
          .on('error', (e) => {
            console.warn('[TTS] 후행 무음 제거 실패 (원본 사용):', e.message);
            if (fs.existsSync(trimTmp)) try { fs.unlinkSync(trimTmp); } catch(_) {}
            resolve(); // 실패해도 계속 진행
          })
          .run();
      });
    } catch (_) {}

    totalDuration = await audioDuration(fullPath);
    if (!totalDuration || totalDuration <= 0) {
      totalDuration = sumDuration;
    }
  } else if (okFiles.length === 1) {
    // 1개 파일도 audio_full.wav로 복사 (render가 항상 이 파일을 찾음)
    fs.copyFileSync(okFiles[0], fullPath);

    // 1개 파일도 후행 무음 제거
    const trimTmp1 = path.join(audioDir, '_trim_silence.wav');
    try {
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(fullPath)
          .audioFilters('silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-50dB')
          .audioCodec('pcm_s16le')
          .audioFrequency(24000)
          .audioChannels(1)
          .output(trimTmp1)
          .on('end', () => {
            if (fs.existsSync(trimTmp1) && fs.statSync(trimTmp1).size > 1000) {
              fs.renameSync(trimTmp1, fullPath);
              console.log('[TTS] 후행 무음 제거 완료 (1세그먼트)');
            } else {
              if (fs.existsSync(trimTmp1)) fs.unlinkSync(trimTmp1);
            }
            resolve();
          })
          .on('error', () => { if (fs.existsSync(trimTmp1)) try { fs.unlinkSync(trimTmp1); } catch(_) {} resolve(); })
          .run();
      });
    } catch (_) {}

    totalDuration = results[0]?.duration || await audioDuration(fullPath) || sumDuration;
  }

  // 메타 업데이트
  // segments에 fullText 보존 (SRT 자막용)
  const resultsWithText = results.map((r, i) => ({ ...r, fullText: segments[i] || '' }));
  meta.tts = { voiceName, speed, chunkSize, segments: resultsWithText, totalDuration, totalDurationFmt: fmtSec(totalDuration) };
  meta.status = 'tts_done';
  fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));

  // 롱폼/쇼츠 모두 SRT 항상 생성 (자막 소각·다운로드용)
  try {
    const srtContent = '﻿' + buildSRT(resultsWithText);
    const srtPath = path.join(audioDir, 'subtitles.srt');
    fs.writeFileSync(srtPath, srtContent, 'utf8');
    console.log('[TTS] SRT 자막 생성 완료:', srtPath);
  } catch (e) {
    console.log('[TTS] SRT 생성 실패 (무시):', e.message);
  }

  clearInterval(keepalive);
  sseSend(res, {
    type: 'done',
    segments: results,
    totalDuration,
    totalDurationFmt: fmtSec(totalDuration),
    fullAudioUrl: `/api/project/${projectId}/audio/audio_full.wav`,
    mergeError
  });
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// TTS 샘플 (단일 구간)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/tts/sample', async (req, res) => {
  const { projectId, text, voiceName = 'Aoede', speed = 'normal' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!text)      return res.status(400).json({ error: '텍스트 필요' });

  const dir      = projectId ? pDir(projectId) : path.join(PROJECTS_DIR, '_temp');
  const audioDir = path.join(dir, 'audio');
  mkDir(audioDir);

  const sampleText = text.slice(0, 300);
  const fileName   = `sample_${Date.now()}.wav`;
  const filePath   = path.join(audioDir, fileName);

  try {
    const b64  = await geminiTTS({ apiKey: geminiKey, text: sampleText, voiceName });
    const wav  = pcmToWav(b64);
    fs.writeFileSync(filePath, wav);

    // 속도 조정
    const atempo = resolveAtempo(speed);
    console.log(`[Speed] sample speed=${speed} atempo=${atempo}`);
    if (atempo !== 1.0) {
      const tmpPath = filePath + '.tmp.wav';
      try {
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(filePath)
            .audioFilters(`atempo=${atempo}`)
            .audioCodec('pcm_s16le')
            .audioFrequency(24000)
            .audioChannels(1)
            .output(tmpPath)
            .on('end', () => { console.log(`[Speed] sample atempo 완료`); resolve(); })
            .on('error', (e) => { console.error(`[Speed] sample atempo 오류:`, e.message); reject(e); })
            .run();
        });
        fs.renameSync(tmpPath, filePath);
      } catch(e) {
        console.error('[Speed] sample atempo 실패:', e.message);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    }

    const dur  = await audioDuration(filePath);
    res.json({ url: `/api/project/${projectId || '_temp'}/audio/${fileName}`, duration: dur, durationFmt: fmtSec(dur) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pexels 이미지 검색 + 저장
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/images', async (req, res) => {
  const { projectId, pexelsKey, sceneIndex, query, ethnicityHint } = req.body;
  if (!pexelsKey) return res.status(400).json({ error: 'Pexels API Key 필요' });
  if (!query)     return res.status(400).json({ error: '검색어 필요' });

  // 인종 힌트 자동 보완 — meta.json에서 scriptLang 읽기
  let finalQuery = query;
  try {
    let hint = ethnicityHint || '';
    if (!hint && projectId) {
      const m = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
      if ((m.scriptLang || 'ko') === 'ko') hint = 'Korean';
    }
    if (hint) finalQuery = `${query} ${hint}`;
  } catch (_) {}

  try {
    const r    = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(finalQuery)}&per_page=12&orientation=landscape`, {
      headers: { Authorization: pexelsKey }
    });
    const d    = await r.json();
    const photos = (d.photos || []).map(p => ({
      id: p.id,
      src: p.src.landscape || p.src.large2x || p.src.large,
      thumb: p.src.medium,
      photographer: p.photographer,
      url: p.url
    }));
    res.json({ photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI 이미지 생성 (gemini-2.0-flash-exp → imagen-3.0 순서로 시도)
// ─────────────────────────────────────────────────────────────────────────────
async function tryGenerateImage(apiKey, fullPrompt, styleSeed = null, aspectRatio = '16:9') {

  // ── 헬퍼: 타임아웃 fetch ───────────────────────────────────────────────────
  const fetchWithTimeout = (url, opts, ms) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  };

  // 1차: Gemini imagen-3 (지원되는 계정만 성공) — 20초 타임아웃
  const url1 = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImages?key=${apiKey}`;
  try {
    const r1 = await fetchWithTimeout(url1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: fullPrompt,
        number_of_images: 1,
        aspect_ratio: aspectRatio,
        safety_filter_level: 'BLOCK_SOME',
        person_generation: 'ALLOW_ADULT'
      })
    }, 20_000);
    const d1 = await r1.json();
    const imgBytes = d1?.generatedImages?.[0]?.image?.imageBytes;
    if (r1.ok && imgBytes) {
      console.log('[Image] imagen-3 성공');
      return { mimeType: 'image/jpeg', data: imgBytes };
    }
    console.log(`[Image] imagen-3 실패: ${d1?.error?.message || `HTTP ${r1.status}`}`);
  } catch (e) {
    console.log(`[Image] imagen-3 건너뜀: ${e.message}`);
  }

  // 2차: Gemini 2.0 flash exp 이미지 생성 — 25초 타임아웃
  const geminiImgModel = 'gemini-2.0-flash-exp-image-generation';
  try {
    const r2 = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiImgModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
        })
      }, 25_000
    );
    const d2 = await r2.json();
    const parts = d2?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    if (r2.ok && imgPart?.inlineData?.data) {
      console.log('[Image] gemini-2.0-flash-exp-image-generation 성공');
      return imgPart.inlineData;
    }
    console.log(`[Image] ${geminiImgModel} 실패: ${d2?.error?.message || `HTTP ${r2.status}`}`);
  } catch (e) {
    console.log(`[Image] ${geminiImgModel} 건너뜀: ${e.message}`);
  }

  // 3차 이후: Pollinations AI 바로 진입 (무료, API키 불필요)
  const err4 = 'imagen/gemini 불가 — Pollinations 시도';

  // 5차: Pollinations AI (무료, API키 불필요 — 마지막 fallback)
  const polModels = ['flux', 'turbo'];
  let polLastError = '실패';
  for (const polModel of polModels) {
    // 429(요청과다) 재시도 — 최대 3회, 3초 간격
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const seed   = styleSeed !== null ? styleSeed : Math.floor(Math.random() * 99999);
        // enhance=true 제거 (타임아웃 유발)
        const [polW, polH] = aspectRatio === '9:16' ? [720, 1280] : [1280, 720];
        const polNegative = encodeURIComponent('text, letters, words, sentences, subtitles, captions, watermark, typography, labels, inscriptions, numbers, symbols, writing, english text, korean text, asian characters, speech bubbles, signs with text, text overlay, burnt subtitles, any alphabet, any characters, printed text, handwriting, graffiti, signage, newspaper, book text, screen text, blurry text, illegible text, foreign language text, any font, any script');
        const polUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=${polW}&height=${polH}&model=${polModel}&nologo=true&seed=${seed}&negative=${polNegative}`;
        console.log(`[Image] Pollinations(${polModel}) 시도 ${attempt + 1}/3…`);

        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90_000); // 90초
        let rp;
        try {
          rp = await fetch(polUrl, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }

        if (rp && rp.status === 429) {
          polLastError = '429 요청과다';
          console.log(`[Image] Pollinations 429 — ${3 - attempt - 1}회 남음, 4초 대기`);
          await new Promise(r => setTimeout(r, 4000));
          continue; // 재시도
        }

        if (rp && rp.ok) {
          const mime = rp.headers.get('content-type') || 'image/jpeg';
          const buf  = Buffer.from(await rp.arrayBuffer());
          if (buf.length > 2000) {
            console.log(`[Image] Pollinations(${polModel}) 성공 — ${buf.length} bytes`);
            return { mimeType: mime, data: buf.toString('base64') };
          }
          polLastError = `응답 크기 부족 (${buf.length} bytes)`;
          console.log(`[Image] Pollinations(${polModel}) ${polLastError}`);
        } else {
          polLastError = `HTTP ${rp?.status}`;
          console.log(`[Image] Pollinations(${polModel}) ${polLastError}`);
        }
        break; // 429 아닌 오류는 재시도 불필요
      } catch (e) {
        polLastError = e.message;
        console.log(`[Image] Pollinations(${polModel}) 오류: ${e.message}`);
        break;
      }
    }
  }

  throw new Error(`이미지 생성 실패 — Pollinations: ${polLastError}`);
}

// 이미지 내 텍스트/워터마크 제거용 공통 suffix
const NO_TEXT_SUFFIX = ', DO NOT RENDER ANY TEXT WHATSOEVER — not a single letter, word, sentence, quote, subtitle, dialogue, caption, watermark, label, inscription, number, symbol, or typography of any kind anywhere in the image — this is an absolute hard rule with zero exceptions — pure visual storytelling only — no text even if the prompt implies speech or dialogue, no Buddhist temples, no Buddha statues, no monks, no Buddhist shrines, no dragons, no fortune telling symbols, no tarot cards, no yoga poses, no fairies, no magic wands, no witches, no occult symbols, no supernatural mystical elements, no kimono, no yukata, no Japanese traditional clothing, no hanfu, no qipao, no Chinese traditional clothing, no hybrid Asian traditional costume';

// 전체 콘텐츠 절대 금기 사항 (대본·장면·이미지 모든 프롬프트에 공통 적용)
// ── 전체 대본 공통 지침 ───────────────────────────────────────────────────────
const getAccuracyRuleKo = () => {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  return `
📌 정보 정확성 필수 지침 (최우선 — 모든 규칙보다 우선 적용):
1. 오늘 날짜는 ${today}입니다. 모든 정보는 이 날짜 기준 최신 정보를 반영해야 합니다.
2. 수치·금액·기준·날짜가 포함된 정보는 반드시 해당 유관기관의 공식 발표 기준으로 작성하세요.
3. 관련 공식 기관을 반드시 명시하세요. 홈페이지와 대표 전화번호를 함께 기재하세요. 예시:
   - 주거·부동산: 국토교통부(molit.go.kr / 1599-0001), SH공사(i-sh.co.kr / 1600-3456), LH공사(lh.or.kr / 1600-1004)
   - 복지·지원금: 복지로(bokjiro.go.kr / 129), 보건복지부(mohw.go.kr / 129)
   - 금융·세금: 국세청(nts.go.kr / 126), 금융감독원(fss.or.kr / 1332), 기획재정부(moef.go.kr / 044-215-2114)
   - 고용·취업: 고용노동부(moel.go.kr / 1350), 워크넷(work.go.kr / 1588-1919)
   - 건강·의료: 건강보험심사평가원(hira.or.kr / 1644-2000), 국민건강보험(nhis.or.kr / 1577-1000)
   - 교육: 교육부(moe.go.kr / 044-203-6114), 한국장학재단(kosaf.go.kr / 1599-2000)
   - 법령: 국가법령정보센터(law.go.kr / 044-200-6901)
   - 소상공인·창업: 소상공인시장진흥공단(semas.or.kr / 1357), 중소벤처기업부(mss.go.kr / 1357)
   - 교통비: K-패스(korea-pass.kr / 1899-2825)
   - 에너지바우처: 한국에너지공단(energy.or.kr / 1600-3190)
4. 정보가 불확실하거나 변경 가능성이 있을 경우 반드시 "정확한 내용은 [기관명] 공식 홈페이지(주소) 또는 전화번호 [번호]로 문의하세요"라고 명시하세요.
5. 추측성·미확인 정보 작성 금지. 확인된 사실만 기술하세요.
6. 전화번호를 언급할 때는 반드시 숫자 앞에 "전화번호"를 붙여서 TTS가 자연스럽게 읽을 수 있도록 하세요. 예) "전화번호 1357로 문의하시면 됩니다", "전화번호 1588-6565로 연락하세요" — 절대 숫자만 단독으로 쓰지 마세요.

【실질적 내용 제시 규칙 — 포장 금지, 알맹이 필수】
7. 각 지원 항목을 설명할 때, 해당 내용을 거론하는 바로 그 자리에 ① 정확한 프로그램명 ② 지원 금액 또는 혜택 ③ 신청 기간·마감일 ④ 신청 방법(온라인/방문/전화) ⑤ 담당 기관명·전화번호·홈페이지 주소를 함께 서술하세요. 항목 설명과 신청 정보는 반드시 같은 자리에서 거론되어야 합니다. "나중에 알아보세요" 식으로 미루는 것 금지.
8. "관련 기관 웹사이트에서 확인하세요", "공식 포털에서 검색하세요"처럼 막연한 표현 절대 금지. 어느 기관인지, 정확한 URL이 무엇인지 대본 안에 직접 말해야 합니다.
9. 신청 방법은 단계별로 구체적으로 안내하세요. 예) "정부24(www.gov.kr) 접속 → 로그인 → '지원금 신청' 검색 → 해당 항목 선택 → 서류 첨부 후 제출". "신청하시면 됩니다" 한 줄 마무리 금지.
10. 대본 마지막 CTA 직전에 이 영상에서 다룬 모든 지원 항목의 유관기관을 한 번에 총정리해 안내하세요. 형식: "[지원항목] — [기관명] / 전화번호 [번호] / 홈페이지 [주소]" 형태로 항목별로 나열. 시청자가 영상 끝까지 보면 메모 한 장 분량의 정보를 손에 쥘 수 있어야 합니다.`;
};

const getAccuracyRuleEn = () => {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `
📌 INFORMATION ACCURACY RULES (HIGHEST PRIORITY — overrides all other rules):
1. Today is ${today}. All information must reflect the most current data as of this date.
2. Any figures, amounts, criteria, or dates must be based on official announcements from relevant authorities.
3. Always cite the relevant official organization with both website and phone number. Examples:
   - Housing: Ministry of Land, Infrastructure and Transport (molit.go.kr / 1599-0001), LH (lh.or.kr / 1600-1004)
   - Welfare: Bokjiro (bokjiro.go.kr / 129), Ministry of Health and Welfare (mohw.go.kr / 129)
   - Finance/Tax: National Tax Service (nts.go.kr / 126), Financial Supervisory Service (fss.or.kr / 1332)
   - Employment: Ministry of Employment and Labor (moel.go.kr / 1350), Work-net (work.go.kr / 1588-1919)
   - Health: HIRA (hira.or.kr / 1644-2000), NHIS (nhis.or.kr / 1577-1000)
   - Education: Ministry of Education (moe.go.kr / 044-203-6114), KOSAF (kosaf.go.kr / 1599-2000)
   - Laws: National Law Information Center (law.go.kr / 044-200-6901)
   - Small Business: SEMAS (semas.or.kr / 1357), MSS (mss.go.kr / 1357)
4. If information may have changed, always state: "Please verify the latest details at [organization]'s official website ([url]) or call [phone number]."
5. Never write speculative or unverified information. State only confirmed facts.`;
};

const FORBIDDEN_KO = `⛔ 절대 금기 (위반 시 즉시 거부):
- 불교 관련 일체 금지: 사찰, 절, 부처, 불상, 스님, 염불, 불교 의식, 불교 상징
- 용(dragon) 이미지 또는 용과 관련된 모든 내용 금지
- 사주팔자, 운세, 점, 타로, 풍수지리 등 점술·운명론 금지
- 요가(yoga), 명상 수련 관련 신체 동작 금지
- 미신, 요술, 요정, 마법, 마녀, 주술, 오컬트, 초자연 신비 현상 금지
- 한국 전통의상: 등장인물이 전통의상을 입을 경우 반드시 정통 한국 한복(韓服)만 묘사. 일본 기모노·유카타, 중국 한푸·치파오 등 타국 전통의상이나 혼합된 아시아 전통의상 절대 금지
- 가상 인물 예시 절대 금지: "서울에서 베이커리를 운영하는 김민준 씨는…" 처럼 실존하지 않는 인물을 만들어 예를 드는 방식 금지. 예시가 필요하면 "이런 상황의 분들은…" / "실제로 많은 분들이…" 식의 일반적 표현 사용`;

const FORBIDDEN_EN = `⛔ STRICTLY FORBIDDEN — never include any of the following:
- Buddhism: temples, shrines, Buddha statues, monks, Buddhist rituals or symbols
- Dragons or any dragon-related imagery
- Fortune telling, saju (four pillars), tarot, feng shui, divination, fatalism
- Yoga poses or yoga-related practice
- Superstitions, magic, fairies, witches, wizardry, occult, mystical/supernatural phenomena
- Traditional clothing: if traditional Korean clothing appears, it MUST be authentic Korean Hanbok ONLY — NEVER Japanese kimono, yukata, Chinese hanfu, qipao, or any hybrid/mixed Asian traditional costume. Hanbok is distinctly Korean: jeogori (저고리 short jacket) + chima (치마 full skirt) for women or baji (바지 trousers) for men, with soft pastel colors and graceful silhouette unique to Korean heritage
- Fictional character examples strictly forbidden: never create a made-up person (e.g. "Kim Minjun who runs a bakery in Seoul…") to illustrate a point. If an example is needed, use general expressions like "people in this situation…" or "many people find that…"`;

// 한복 프롬프트 강화용 공통 지시문 (한복이 언급될 때 삽입)
const HANBOK_STRICT = 'IMPORTANT: Any traditional Korean clothing must be AUTHENTIC KOREAN HANBOK only — strictly NO Japanese kimono or yukata, NO Chinese hanfu or qipao, NO mixed or hybrid Asian traditional costumes. Hanbok features: jeogori jacket with goreum (고름 ribbon ties), full flowing chima skirt or baji trousers, subtle elegant colors — this is uniquely Korean, not Japanese, not Chinese.';

app.post('/api/media/generate-image', async (req, res) => {
  const { projectId, sceneIndex, prompt, relatedLine, imageStyle, characterDesc, characterEthnicity } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey)             return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!prompt && !relatedLine) return res.status(400).json({ error: '프롬프트 필요' });
  if (!projectId)             return res.status(400).json({ error: 'projectId 필요' });

  // 프로젝트 scriptLang + isShorts 읽기 → 인종/문화 맥락 + 비율 자동 보완
  let autoEthnicity = characterEthnicity && characterEthnicity.trim() ? characterEthnicity.trim() : '';
  let culturalContext = '';
  let sceneAspectRatio = '16:9';
  try {
    const metaPath = pDir(projectId, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const lang = m.scriptLang || 'ko';
      if (lang === 'ko') {
        if (!autoEthnicity) autoEthnicity = 'all characters must be East Asian Korean appearance with Asian facial features';
        culturalContext = 'Korean cultural setting. If any text or signs are visible, use Korean Hangul characters only, never English or Latin letters. If traditional clothing is worn, it must be authentic Korean Hanbok ONLY — never Japanese kimono/yukata or Chinese hanfu/qipao or any hybrid Asian costume.';
      }
      if (m.isShorts) sceneAspectRatio = '9:16';
    }
  } catch (_) {}

  // 인종 + 캐릭터 조합
  const charFull = [autoEthnicity, characterDesc?.trim()].filter(Boolean).join('. ');
  const charPrefix = charFull ? `Character requirements: ${charFull}. ` : '';
  const culturePrefix = culturalContext ? `${culturalContext} ` : '';

  // ── 대사 기반 이미지 프롬프트 생성 ──────────────────────────────────────────
  let imagePrompt = prompt;
  if (relatedLine && relatedLine.trim()) {
    try {
      const converted = await geminiText({
        apiKey: geminiKey,
        prompt: `You are an image generation prompt engineer.
Convert this Korean script narration into a precise English image generation prompt.

Korean script line: "${relatedLine}"
Supplementary visual description: "${prompt}"
Art style: "${imageStyle || ''}"
${charFull ? `
⚠ CHARACTER APPEARANCE — THIS IS THE HIGHEST PRIORITY RULE:
The character(s) in the image MUST match this description EXACTLY.
Do NOT deviate. Do NOT generalize. Copy these details precisely:
"${charFull}"
Every physical detail (face, hair, clothing, age, body type) must match the above.
` : ''}
${culturalContext ? `Cultural context: ${culturalContext}` : ''}

Rules:
- The image must DIRECTLY illustrate what is described in the Korean narration
- Include: subjects, action, setting, mood, lighting, camera angle
${charFull ? '- CHARACTER APPEARANCE IS MANDATORY — reproduce every detail from the description above, do not substitute or approximate' : ''}
- ⚠ ABSOLUTE BAN: NO TEXT, NO LETTERS, NO WORDS, NO SUBTITLES, NO CAPTIONS, NO WATERMARKS anywhere in the image. Not even blurred, partial, or background text. Pure visual only.
- NEVER use words like "poster", "sign", "banner", "title", "label", "caption", "text" in the prompt
- Write in English only, max 220 characters
- Output ONLY the image prompt, nothing else
- If traditional Korean clothing appears: write "authentic Korean Hanbok" and add "NOT kimono NOT hanfu"

${FORBIDDEN_EN}
${/한복|전통\s*의상|전통복/.test(relatedLine) ? HANBOK_STRICT : ''}`,
        maxTokens: 350,
        temp: 0.5,
        thinkingBudget: 0
      });
      if (converted && converted.trim().length > 10) {
        imagePrompt = converted.trim();
        console.log(`[Image] scene_${sceneIndex} 대사 기반 프롬프트 생성: ${imagePrompt.slice(0,80)}…`);
      }
    } catch (e) {
      console.log(`[Image] scene_${sceneIndex} 프롬프트 변환 실패, 기본 사용: ${e.message}`);
    }
  }

  // 이미지 프롬프트 정제 — 대사/자막이 섞여 들어오면 이미지에 텍스트가 렌더링됨
  // 파이프(|) 이후 텍스트, 큰따옴표/작은따옴표 안 문장, 말풍선 문구 제거
  const sanitizePrompt = (p) => p
    .replace(/\|.*$/s, '')                        // | 이후 전부 제거
    .replace(/"[^"]{0,300}"/g, '')                // "..." 따옴표 문장 제거
    .replace(/'[^']{0,300}'/g, '')                // '...' 작은따옴표 제거
    .replace(/\b(says?|said|quote[sd]?|caption|subtitle|text reads?|written|inscription)[^,.]*/gi, '') // 텍스트 관련 동사 제거
    .replace(/\d{2,4}-\d{3,4}-?\d{0,4}/g, '')    // 전화번호 제거
    .replace(/\b\d{3,5}\b/g, '')                  // 단독 숫자(전화번호 등) 제거
    .replace(/[\w-]+\.(go|or|com|kr|net)[\w./]*/gi, '') // URL 제거
    .replace(/\b(infographic|diagram|chart|graph|poster|banner|sign|billboard|flyer|brochure|document|form|application form|screen showing|display showing|text on|label|notice board|announcement board)[^,.]*/gi, 'visual scene') // 텍스트 유발 오브젝트 치환
    .replace(/\s{2,}/g, ' ').trim();

  const cleanPrompt = sanitizePrompt(imagePrompt);

  const NO_TEXT_PREFIX = 'ABSOLUTE RULE — NO TEXT OF ANY KIND ANYWHERE IN THIS IMAGE: no letters, no words, no sentences, no numbers, no symbols, no subtitles, no captions, no watermarks, no signs, no labels, no handwriting, no graffiti, no screen text, no newspaper text, no book text — PURE VISUAL SCENE ONLY, ZERO TYPOGRAPHY. ';
  // 스크린샷 기반 캐릭터가 있을 때: 캐릭터 설명을 프롬프트 맨 앞에 강하게 배치
  const charEmphasis = charFull ? `EXACT CHARACTER APPEARANCE REQUIRED: ${charFull}. ` : '';
  const fullPrompt = imageStyle
    ? `${NO_TEXT_PREFIX}${charEmphasis}${imageStyle}, ${culturePrefix}${charPrefix}${cleanPrompt}${NO_TEXT_SUFFIX}`
    : `${NO_TEXT_PREFIX}${charEmphasis}${culturePrefix}${charPrefix}${cleanPrompt}${NO_TEXT_SUFFIX}`;

  // 프로젝트 고정 seed (Pollinations 스타일 일관성용 — projectId 앞 8자리 hex → 정수)
  const styleSeed = parseInt(projectId.replace(/-/g, '').slice(0, 8), 16) % 99999;

  try {
    const inlineData = await tryGenerateImage(geminiKey, fullPrompt, styleSeed, sceneAspectRatio);

    const imgDir  = pDir(projectId, 'images');
    mkDir(imgDir);
    const ext      = (inlineData.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
    const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.${ext}`;
    fs.writeFileSync(path.join(imgDir, fileName), Buffer.from(inlineData.data, 'base64'));

    console.log(`[Image] scene_${sceneIndex} 완료 → ${fileName}`);
    res.json({ saved: true, path: `/api/project/${projectId}/images/${fileName}`, usedPrompt: fullPrompt });
  } catch (err) {
    console.error('[Image] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 인트로 / 아웃트로 영상 업로드
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/upload-bookend', express.json({ limit: '500mb' }), async (req, res) => {
  const { projectId, role, videoData } = req.body; // role: 'intro' | 'outro'
  if (!projectId || !role || !videoData) return res.status(400).json({ error: '파라미터 부족' });
  if (!['intro','outro'].includes(role)) return res.status(400).json({ error: 'role은 intro|outro' });

  const dir = pDir(projectId, 'bookend');
  mkDir(dir);
  const fileName = `${role}.mp4`;
  const filePath = path.join(dir, fileName);

  try {
    const buf = Buffer.from(videoData, 'base64');
    if (buf.length < 10000) return res.status(400).json({ error: '영상 파일이 너무 작습니다' });
    fs.writeFileSync(filePath, buf);
    const dur = await getVideoDuration(filePath);

    const meta = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
    meta.bookend = meta.bookend || {};
    meta.bookend[role] = { fileName, duration: dur };
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));

    console.log(`[Bookend] ${role} 저장: ${(buf.length/1024/1024).toFixed(1)}MB, dur=${dur.toFixed(1)}s`);
    res.json({ saved: true, role, duration: dur });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/delete-bookend', (req, res) => {
  const { projectId, role } = req.body;
  if (!projectId || !role) return res.status(400).json({ error: '파라미터 부족' });
  try {
    const filePath = pDir(projectId, 'bookend', `${role}.mp4`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const meta = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
    if (meta.bookend) delete meta.bookend[role];
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 인터뷰 영상 업로드 — projects/{id}/interview/interview_{sceneNum}.mp4
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/upload-interview', express.json({ limit: '500mb' }), async (req, res) => {
  const { projectId, sceneNumber, videoData, fadeDuration = 0.8 } = req.body;
  if (!projectId || sceneNumber == null || !videoData)
    return res.status(400).json({ error: '파라미터 부족' });

  const ivDir  = pDir(projectId, 'interview');
  mkDir(ivDir);
  const fileName = `interview_${String(sceneNumber).padStart(3,'0')}.mp4`;
  const filePath = path.join(ivDir, fileName);

  try {
    const buf = Buffer.from(videoData, 'base64');
    if (buf.length < 10000) return res.status(400).json({ error: '영상 파일이 너무 작습니다' });
    fs.writeFileSync(filePath, buf);

    const ivDur = await getVideoDuration(filePath);

    // meta.interviewClips 업데이트
    const metaPath = pDir(projectId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.interviewClips = meta.interviewClips || [];
    // 같은 sceneNumber 교체
    meta.interviewClips = meta.interviewClips.filter(c => c.sceneNumber !== sceneNumber);
    meta.interviewClips.push({ sceneNumber, fileName, fadeDuration: parseFloat(fadeDuration), duration: ivDur });
    meta.interviewClips.sort((a,b) => a.sceneNumber - b.sceneNumber);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`[Interview] scene_${sceneNumber} 저장: ${(buf.length/1024/1024).toFixed(1)}MB, dur=${ivDur.toFixed(1)}s`);
    res.json({ saved: true, sceneNumber, duration: ivDur, path: `/api/project/${projectId}/interview/${fileName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 인터뷰 영상 삭제
app.post('/api/media/delete-interview', (req, res) => {
  const { projectId, sceneNumber } = req.body;
  if (!projectId || sceneNumber == null) return res.status(400).json({ error: '파라미터 부족' });
  try {
    const fileName = `interview_${String(sceneNumber).padStart(3,'0')}.mp4`;
    const filePath = path.join(pDir(projectId, 'interview'), fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const metaPath = pDir(projectId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.interviewClips = (meta.interviewClips || []).filter(c => c.sceneNumber !== sceneNumber);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 인터뷰 영상 파일 서빙
app.get('/api/project/:id/interview/:file', (req, res) => {
  const fp = pDir(req.params.id, 'interview', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(fp);
});

// ─── 인터뷰 클립 삽입 함수 (post-process splice) ──────────────────────────────
// 영상 스트림 정보 조회 (오디오 유무, fps, 해상도)
function probeVideoInfo(filePath) {
  return new Promise(resolve => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta) { resolve({ hasAudio: false, fps: 25, width: 1920, height: 1080 }); return; }
      const streams = meta.streams || [];
      const vStream = streams.find(s => s.codec_type === 'video');
      const aStream = streams.find(s => s.codec_type === 'audio');
      let fps = 25;
      if (vStream?.r_frame_rate) {
        const parts = vStream.r_frame_rate.split('/');
        fps = parts.length === 2 ? parseFloat(parts[0]) / parseFloat(parts[1]) : parseFloat(parts[0]);
        if (!isFinite(fps) || fps <= 0) fps = 25;
      }
      resolve({
        hasAudio: !!aStream,
        fps: Math.round(fps * 100) / 100,
        width:  vStream?.width  || 1920,
        height: vStream?.height || 1080,
      });
    });
  });
}

async function spliceInterviewClip(mainVideo, ivVideo, insertTime, ivDur, fadeDur, outputPath) {
  const T = parseFloat(insertTime.toFixed(3));
  const D = parseFloat(Math.max(ivDur, 0.5).toFixed(3));
  // 페이드 시간: 영상 길이의 30% 이하, 최대 1.5초, T가 0이면 페이드 없음
  const F = parseFloat(Math.min(fadeDur, T > 0.5 ? T * 0.3 : 0.3, D * 0.3, 1.5).toFixed(3));

  // 메인/인터뷰 영상 스트림 정보 확인
  const [mainInfo, ivInfo] = await Promise.all([
    probeVideoInfo(mainVideo),
    probeVideoInfo(ivVideo)
  ]);

  const FPS = mainInfo.fps || 25;
  const W   = mainInfo.width  || 1920;
  const H   = mainInfo.height || 1080;

  console.log(`[IV-Splice] T=${T}s D=${D}s F=${F}s fps=${FPS} ivAudio=${ivInfo.hasAudio}`);

  // ── 인터뷰 영상 오디오 없을 때: 무음 구간 생성 ──
  // aevalsrc로 D초 무음 stereo 44100 생성
  const silenceFilter = `aevalsrc=0:c=stereo:s=44100:d=${D}[a1_sil]`;

  let fc;
  if (ivInfo.hasAudio) {
    fc = [
      // 앞부분 (0 ~ T) — 끝에 페이드아웃
      `[0:v]trim=start=0:end=${T},setpts=PTS-STARTPTS,fade=t=out:st=${Math.max(0, T-F)}:d=${F}[v0]`,
      `[0:a]atrim=start=0:end=${T},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=out:st=${Math.max(0, T-F)}:d=${F}[a0]`,
      // 인터뷰 클립 — 스케일 + 프레임레이트 통일 + 페이드 인/아웃
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${F},fade=t=out:st=${Math.max(0, D-F)}:d=${F}[v1]`,
      `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=${F},afade=t=out:st=${Math.max(0, D-F)}:d=${F}[a1]`,
      // 뒷부분 (T ~ end) — 앞에 페이드인
      `[0:v]trim=start=${T},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${F}[v2]`,
      `[0:a]atrim=start=${T},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=${F}[a2]`,
      // concat
      `[v0][v1][v2]concat=n=3:v=1:a=0[vout]`,
      `[a0][a1][a2]concat=n=3:v=0:a=1[aout]`
    ].join(';');
  } else {
    // 인터뷰 클립에 오디오 없음 → 무음 대체
    fc = [
      `[0:v]trim=start=0:end=${T},setpts=PTS-STARTPTS,fade=t=out:st=${Math.max(0, T-F)}:d=${F}[v0]`,
      `[0:a]atrim=start=0:end=${T},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=out:st=${Math.max(0, T-F)}:d=${F}[a0]`,
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${F},fade=t=out:st=${Math.max(0, D-F)}:d=${F}[v1]`,
      silenceFilter,
      `[a1_sil]afade=t=in:st=0:d=${F},afade=t=out:st=${Math.max(0, D-F)}:d=${F}[a1]`,
      `[0:v]trim=start=${T},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${F}[v2]`,
      `[0:a]atrim=start=${T},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=${F}[a2]`,
      `[v0][v1][v2]concat=n=3:v=1:a=0[vout]`,
      `[a0][a1][a2]concat=n=3:v=0:a=1[aout]`
    ].join(';');
  }

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(mainVideo)
      .input(ivVideo)
      .outputOptions([
        '-filter_complex', fc,
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264', '-crf', '20', '-preset', 'fast',
        '-pix_fmt', 'yuv420p',          // 재생 호환성 보장
        '-movflags', '+faststart',       // 스트리밍 재생 즉시 시작
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k'
      ])
      .output(outputPath)
      .on('start', cmd => console.log('[IV-Splice] ffmpeg 시작:', cmd.slice(0, 120)))
      .on('end', () => { console.log('[IV-Splice] 완료:', outputPath); resolve(); })
      .on('error', (e, stdout, stderr) => {
        console.error('[IV-Splice] 오류:', e.message);
        console.error('[IV-Splice] stderr:', (stderr || '').slice(-600));
        reject(e);
      });
    cmd.run();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BGM 추천 — 대본 분석(Gemini) → Pixabay Music 검색 → 트랙 목록 반환
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/music-recommend', async (req, res) => {
  const { projectId, topic, script, pixabayKey } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey)   return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!pixabayKey)  return res.status(400).json({ error: 'Pixabay API Key 필요 (무료 가입: pixabay.com)' });

  try {
    // Gemini로 대본 무드 분석 → 영어 검색어 5개 추출 (실패 시 기본값 사용)
    const fallbacks = ['calm piano','peaceful ambient','soft background','gentle acoustic','relaxing'];
    let queryList = [...fallbacks];
    try {
      const moodPrompt = `아래 영상 대본을 읽고, Pixabay 음악 API 검색어를 추천해주세요.

영상 주제: "${topic || ''}"
대본 (일부): "${(script || '').slice(0, 1500)}"

규칙:
- 영어 검색어 5개를 쉼표로만 구분 (예: calm piano, peaceful ambient, gentle background, soft acoustic, relaxing instrumental)
- 반드시 잔잔하고 평화로운 배경음악(calm, peaceful, soft, gentle, relaxing) 위주로 추천
- 강렬하거나 빠른 템포 음악 금지 (rock, energetic, upbeat, fast 제외)
- 인스트루멘탈 배경음악에 적합한 무드/악기 키워드
- Pixabay Music에서 검색 결과가 잘 나오는 일반적인 키워드 사용 (예: calm piano, ambient, peaceful, relaxing, soft background, gentle acoustic, meditation)
- 다른 텍스트 없이 검색어 5개만 출력`;

      const moodRaw = await geminiText({ apiKey: geminiKey, prompt: moodPrompt, maxTokens: 100, temp: 0.7 });
      const rawQueries = (moodRaw || '').split(',').map(s => s.trim()).filter(Boolean);
      if (rawQueries.length > 0) {
        const merged = [...rawQueries];
        for (const fb of fallbacks) { if (merged.length >= 5) break; if (!merged.includes(fb)) merged.push(fb); }
        queryList = merged.slice(0, 5);
      }
    } catch (geminiErr) {
      console.log('[BGM] Gemini 대본 분석 실패, 기본 검색어 사용:', geminiErr.message);
      // geminiErr은 무시하고 기본 fallback 검색어로 계속 진행
    }

    // Pixabay Music API — 검색어별 최대 6개씩, 중복 제거
    const tracks = [];
    const seen   = new Set();
    let pixabayKeyError = null;

    // HTML 응답 감지 헬퍼 (API 키 없거나 잘못됐을 때 Pixabay가 HTML 반환)
    const fetchPixabay = async (url) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'LongformV2/1.0' } });
      const text = await r.text();
      if (text.trimStart().startsWith('<')) {
        throw new Error('INVALID_KEY');
      }
      return { r, d: JSON.parse(text) };
    };

    for (const q of queryList) {
      try {
        const url = `https://pixabay.com/api/music/?key=${pixabayKey}&q=${encodeURIComponent(q)}&per_page=6&order=popular`;
        const { r, d } = await fetchPixabay(url);
        if (!r.ok || d.error) {
          console.log(`[BGM] Pixabay 오류(${q}): ${d.error || r.status}`);
          if (!pixabayKeyError) pixabayKeyError = d.error || `HTTP ${r.status}`;
          continue;
        }
        console.log(`[BGM] "${q}" → ${(d.hits||[]).length}곡`);
        for (const h of (d.hits || [])) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          const preview = h.previewURL || h.audio || '';
          if (!preview) continue;
          tracks.push({
            id:         h.id,
            title:      h.title || '제목 없음',
            duration:   h.duration || 0,
            tags:       h.tags    || '',
            previewURL: preview,
            user:       h.user    || '',
            query:      q
          });
          if (tracks.length >= 5) break;
        }
        if (tracks.length >= 5) break;
      } catch (e) {
        console.log(`[BGM] 검색 오류(${q}): ${e.message}`);
        if (e.message === 'INVALID_KEY') {
          pixabayKeyError = 'INVALID_KEY';
          break; // 키가 없으면 나머지 쿼리도 전부 실패하므로 중단
        }
      }
    }

    // API 키 오류 → 즉시 명확한 에러 반환
    if (pixabayKeyError === 'INVALID_KEY' || (!tracks.length && pixabayKeyError)) {
      return res.status(400).json({ error: 'Pixabay API Key가 없거나 잘못됐습니다.\npixabay.com 에서 무료 가입 후 API Key를 발급받아 설정에 입력하세요.\n(이미지 API Key와 동일한 키를 사용합니다)' });
    }

    if (!tracks.length) {
      // 마지막 시도: 검색어 없이 popular 목록에서 가져오기
      try {
        const url = `https://pixabay.com/api/music/?key=${pixabayKey}&per_page=5&order=popular`;
        const { r, d } = await fetchPixabay(url);
        if (!r.ok || d.error) {
          return res.status(400).json({ error: `Pixabay API Key 오류: ${d.error || r.status}` });
        }
        for (const h of (d.hits || [])) {
          const preview = h.previewURL || h.audio || '';
          if (!preview) continue;
          tracks.push({ id: h.id, title: h.title || '제목 없음', duration: h.duration || 0, tags: h.tags || '', previewURL: preview, user: h.user || '', query: 'popular' });
        }
      } catch (e) {
        if (e.message === 'INVALID_KEY') {
          return res.status(400).json({ error: 'Pixabay API Key가 없거나 잘못됐습니다.\npixabay.com 에서 무료 가입 후 API Key를 발급받아 설정에 입력하세요.' });
        }
      }
    }

    if (!tracks.length) {
      return res.status(200).json({ tracks: [], queries: queryList, mood: queryList[0] || '', noResult: true, message: `Pixabay에서 트랙을 찾지 못했습니다. 검색어: ${queryList.join(', ')}` });
    }
    res.json({ tracks: tracks.slice(0, 5), queries: queryList, mood: queryList[0] || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BGM 저장 — 선택한 트랙 다운로드 → project/bgm/bgm.mp3
app.post('/api/media/music-save', async (req, res) => {
  const { projectId, previewURL, title, volume = 0.12 } = req.body;
  if (!projectId || !previewURL) return res.status(400).json({ error: '파라미터 부족' });

  try {
    const r = await fetch(previewURL, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': new URL(previewURL).origin } });
    if (!r.ok) throw new Error(`다운로드 실패 HTTP ${r.status}`);
    const contentType = r.headers.get('content-type') || '';
    if (contentType.includes('text/html')) throw new Error('이 URL은 오디오 파일을 직접 다운로드할 수 없습니다.\n파일을 직접 다운로드한 뒤 [📂 파일 업로드]로 올려주세요.');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) throw new Error('오디오 파일이 너무 작습니다');
    // 파일 헤더로 오디오 여부 확인 (MP3/WAV/OGG/M4A)
    const header = buf.slice(0, 12).toString('hex');
    const isAudio = header.startsWith('494433')       // ID3 (MP3)
      || header.startsWith('fffb') || header.startsWith('fff3') || header.startsWith('fff2') // MP3 frame
      || header.startsWith('52494646')                // RIFF (WAV)
      || header.startsWith('4f676753')                // OggS (OGG)
      || buf.slice(4,8).toString('ascii') === 'ftyp'; // M4A/AAC
    if (!isAudio) throw new Error('오디오 파일이 아닙니다 (HTML 또는 다른 형식). 파일을 직접 업로드해주세요.');

    const bgmDir = pDir(projectId, 'bgm');
    mkDir(bgmDir);
    fs.writeFileSync(path.join(bgmDir, 'bgm.mp3'), buf);

    const metaPath = pDir(projectId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.bgm = { title, volume: parseFloat(volume) };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    console.log(`[BGM] 저장: "${title}" (${(buf.length/1024).toFixed(0)}KB, vol=${volume})`);
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BGM 파일 직접 업로드 (base64)
app.post('/api/media/bgm-upload', express.json({ limit: '64mb' }), (req, res) => {
  const { projectId, audioData, title, volume = 0.12 } = req.body;
  if (!projectId || !audioData) return res.status(400).json({ error: '파라미터 부족' });
  try {
    const buf = Buffer.from(audioData, 'base64');
    if (buf.length < 5000) throw new Error('오디오 파일이 너무 작습니다');
    // 파일 헤더로 오디오 여부 확인
    const hex = buf.slice(0, 12).toString('hex');
    const isAudio = hex.startsWith('494433')       // ID3 (MP3)
      || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2') // MP3 frame
      || hex.startsWith('52494646')                // RIFF (WAV)
      || hex.startsWith('4f676753')                // OggS (OGG)
      || buf.slice(4, 8).toString('ascii') === 'ftyp'; // M4A/AAC
    if (!isAudio) throw new Error('오디오 파일이 아닙니다.\n다운로드한 파일이 실제 MP3가 아닐 수 있습니다.\n음악 사이트에서 파일을 직접 다운로드(우클릭→다른 이름으로 저장)해주세요.');
    const bgmDir = pDir(projectId, 'bgm');
    mkDir(bgmDir);
    fs.writeFileSync(path.join(bgmDir, 'bgm.mp3'), buf);
    const meta = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
    meta.bgm = { title: title || '업로드 파일', volume: parseFloat(volume) };
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log(`[BGM] 업로드: "${title}" (${(buf.length/1024).toFixed(0)}KB)`);
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BGM 볼륨만 업데이트
app.post('/api/media/bgm-volume', (req, res) => {
  const { projectId, title, volume = 0.12 } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId 필요' });
  try {
    const meta = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
    if (meta.bgm) {
      meta.bgm.volume = parseFloat(volume);
      if (title) meta.bgm.title = title;
    }
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));
    res.json({ updated: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// BGM 삭제
app.post('/api/media/music-delete', (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId 필요' });
  try {
    const bgmPath = path.join(pDir(projectId, 'bgm'), 'bgm.mp3');
    if (fs.existsSync(bgmPath)) fs.unlinkSync(bgmPath);
    const metaPath = pDir(projectId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.bgm;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 쇼츠 자막 설정 저장
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/shorts/subtitle', (req, res) => {
  const { projectId, enabled } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId 필요' });
  try {
    const metaPath = pDir(projectId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.shortsSubtitle = !!enabled;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ shortsSubtitle: meta.shortsSubtitle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 썸네일 생성 — 대본 분석 → 핵심 텍스트 추출 → 배경 이미지 생성
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/generate-thumbnail', async (req, res) => {
  const { projectId, topic, script, imageStyle } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey)  return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!projectId)  return res.status(400).json({ error: 'projectId 필요' });
  if (!script && !topic) return res.status(400).json({ error: '대본 또는 주제 필요' });

  // isShorts 여부 확인
  let isShorts = false;
  try {
    const m = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
    isShorts = !!m.isShorts;
  } catch (_) {}
  const aspectRatio   = isShorts ? '9:16' : '16:9';
  const ratioLabel    = isShorts ? '9:16 세로 (쇼츠)' : '16:9 가로 (롱폼)';
  const ratioPrompt   = isShorts ? '9:16 vertical portrait composition, centered subject, close-up or medium shot, bold centered layout' : '16:9 composition, wide cinematic framing';

  try {
    // 1단계: Gemini로 썸네일 2종 (감정형 / 궁금증형) 텍스트 + 이미지 프롬프트 추출
    const analysisPrompt = `당신은 유튜브 썸네일 전문 크리에이티브 디렉터입니다.
아래 영상 주제와 대본을 분석하여 1000만 조회수급 썸네일 2가지 버전을 설계하세요.

영상 주제: "${topic || ''}"
대본 (요약): "${(script || '').slice(0, 2000)}"
비율: ${ratioLabel}

버전 A — 감정형 (감동·공감·충격 감정을 자극):
- 메인 타이틀: 5~10자, 보는 순간 가슴에 꽂히는 감정적 한 마디
- 서브 타이틀: 12~22자, 공감과 감정을 자극하는 문장
- 이미지: 강렬한 감정 표정, 드라마틱한 인물 중심 장면, 따뜻하거나 충격적인 색감

버전 B — 궁금증형 (호기심·반전·비밀을 자극):
- 메인 타이틀: 5~10자, "이게 뭐야?" 싶은 충격적 궁금증 유발
- 서브 타이틀: 12~22자, 클릭 안 하면 못 배기게 만드는 문장
- 이미지: 의문·반전을 암시하는 장면, 강렬한 대비, 비밀스러운 분위기

공통 이미지 규칙:
- NO TEXT, NO LETTERS, NO WATERMARK
- 최고 퀄리티, 8K, 시네마틱 조명, 선명한 색감
- ${ratioLabel} 비율 최적화
- 200자 이내 영어 프롬프트

다음 JSON 형식으로만 응답 (마크다운 블록 없이):
{"A":{"mainText":"","subText":"","imagePrompt":""},"B":{"mainText":"","subText":"","imagePrompt":""}}`;

    const rawJson = await geminiText({
      apiKey: geminiKey,
      prompt: analysisPrompt,
      maxTokens: 800,
      temp: 0.85,
      thinkingBudget: 0
    });

    let parsedA = { mainText: topic || '핵심 메시지', subText: '', imagePrompt: `cinematic emotional scene related to "${topic}"` };
    let parsedB = { mainText: topic || '핵심 메시지', subText: '', imagePrompt: `mysterious curiosity scene related to "${topic}"` };
    try {
      const clean = rawJson.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'').replace(/^```\s*/,'');
      const j = JSON.parse(clean);
      if (j.A) parsedA = { ...parsedA, ...j.A };
      if (j.B) parsedB = { ...parsedB, ...j.B };
    } catch (_) {
      console.log('[Thumbnail] JSON 파싱 실패, 기본값 사용');
    }

    // 2단계: 문화 컨텍스트
    let culturalCtx = '';
    try {
      const metaPath = pDir(projectId, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if ((m.scriptLang || 'ko') === 'ko')
          culturalCtx = 'Korean cultural setting, East Asian subjects. ';
      }
    } catch (_) {}

    const baseStyle = `NO TEXT NO LETTERS NO WORDS NO SUBTITLES NO WATERMARK ANYWHERE IN IMAGE. ${imageStyle || 'Cinematic photorealistic'}, ${culturalCtx}`;
    const baseQuality = `dramatic cinematic lighting, high contrast, vivid saturated colors, sharp focus, professional photography, YouTube thumbnail style, ${ratioPrompt}, ultra detailed, 8K quality`;

    const fullPromptA = [baseStyle, parsedA.imagePrompt, baseQuality].filter(Boolean).join(', ');
    const fullPromptB = [baseStyle, parsedB.imagePrompt, baseQuality].filter(Boolean).join(', ');

    const imgDir = pDir(projectId, 'images');
    mkDir(imgDir);
    const styleSeed = parseInt(projectId.replace(/-/g,'').slice(0,8), 16) % 99999;

    // 3단계: 두 이미지 병렬 생성
    console.log(`[Thumbnail] 2종 생성 시작 (${aspectRatio})`);
    const [inlineA, inlineB] = await Promise.all([
      tryGenerateImage(geminiKey, fullPromptA, styleSeed,     aspectRatio),
      tryGenerateImage(geminiKey, fullPromptB, styleSeed + 1, aspectRatio),
    ]);

    const extA = (inlineA.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
    const extB = (inlineB.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
    fs.writeFileSync(path.join(imgDir, `thumbnail_A.${extA}`), Buffer.from(inlineA.data, 'base64'));
    fs.writeFileSync(path.join(imgDir, `thumbnail_B.${extB}`), Buffer.from(inlineB.data, 'base64'));
    // 기본 thumbnail도 A로 저장 (기존 호환)
    fs.writeFileSync(path.join(imgDir, `thumbnail.${extA}`), Buffer.from(inlineA.data, 'base64'));

    console.log(`[Thumbnail] 2종 완료 → A: ${parsedA.mainText} / B: ${parsedB.mainText}`);
    res.json({
      saved: true,
      A: { path: `/api/project/${projectId}/images/thumbnail_A.${extA}`, mainText: parsedA.mainText, subText: parsedA.subText, imagePrompt: fullPromptA, label: '감정형' },
      B: { path: `/api/project/${projectId}/images/thumbnail_B.${extB}`, mainText: parsedB.mainText, subText: parsedB.subText, imagePrompt: fullPromptB, label: '궁금증형' },
      // 기존 호환
      path: `/api/project/${projectId}/images/thumbnail.${extA}`,
      mainText: parsedA.mainText, subText: parsedA.subText, imagePrompt: fullPromptA
    });
  } catch (err) {
    console.error('[Thumbnail] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 로컬 이미지 직접 업로드 (base64) — Whisk 등 외부 도구에서 받은 이미지 저장
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/upload-scene-image', (req, res) => {
  const { projectId, sceneIndex, imageData, mimeType = 'image/jpeg' } = req.body;
  if (!projectId || sceneIndex == null || !imageData) return res.status(400).json({ error: '파라미터 부족' });

  const imgDir  = pDir(projectId, 'images');
  mkDir(imgDir);
  const ext      = mimeType.includes('png') ? 'png' : 'jpg';
  const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.${ext}`;
  const filePath = path.join(imgDir, fileName);

  try {
    const buf = Buffer.from(imageData, 'base64');
    if (buf.length < 500) return res.status(400).json({ error: '이미지 데이터가 너무 작습니다' });
    fs.writeFileSync(filePath, buf);
    console.log(`[Upload] scene_${sceneIndex} 저장: ${(buf.length / 1024).toFixed(0)}KB`);
    res.json({ saved: true, path: `/api/project/${projectId}/images/${fileName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Whisk/Grok 프롬프트 TXT 내보내기
// ?lang=en  (기본) — 영문 이미지 프롬프트 (Auto Whisk용)
// ?lang=ko           — 한글 프롬프트 (Grok 이미지 생성용)
// ?dialogLang=none|ko|en|both — 대사 포함 옵션
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/whisk-prompts', (req, res) => {
  const { id } = req.params;
  const lang       = req.query.lang       || 'en';   // 'en' | 'ko'
  const dialogLang = req.query.dialogLang || 'none';
  const maxScenes  = req.query.maxScenes ? parseInt(req.query.maxScenes, 10) : 0;

  const metaPath = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  let scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });
  if (maxScenes > 0) scenes = scenes.slice(0, maxScenes);

  const style    = meta.imageStyle || 'Cinematic realistic photography';
  const charDesc = meta.characterDesc || '';
  const charNote = charDesc ? `Character: ${charDesc}. ` : '';

  const lines = scenes.map(sc => {
    const sceneNum = `[${sc.sceneNumber}]`;
    let line;

    if (lang === 'ko') {
      // ── 한글 내보내기 (Grok용) ───────────────────────────────────────────
      const koBase   = (sc.promptKo || sc.relatedLine || sc.sceneTitle || '').replace(/[\r\n]+/g, ' ').trim();
      const koScript = (sc.scriptChunk || sc.relatedLine || '').replace(/[\r\n]+/g, ' ').trim();
      const koExtra  = koScript && koScript !== koBase ? ` | 대사: ${koScript.slice(0, 150)}` : '';
      line = `${sceneNum} ${koBase}${koExtra}`.replace(/[ \t]+/g, ' ').trim();
    } else {
      // ── 영문 내보내기 (Auto Whisk용) ─────────────────────────────────────
      const base = sc.prompt || sc.searchQuery || sc.sceneTitle || '';
      line = `${sceneNum} ${style}, ${charNote}${base}`.replace(/[ \t]+/g, ' ').trim();
      // 대사 포함 옵션
      if (dialogLang === 'ko' && sc.relatedLine) {
        line += ` | ${sc.relatedLine}`;
      } else if (dialogLang === 'en' && sc.relatedLineEn) {
        line += ` | ${sc.relatedLineEn}`;
      } else if (dialogLang === 'both') {
        if (sc.relatedLine)   line += ` | KO: ${sc.relatedLine}`;
        if (sc.relatedLineEn) line += ` | EN: ${sc.relatedLineEn}`;
      }
    }
    return line;
  });

  const fname = lang === 'ko'
    ? `prompts_ko_${id.slice(0,8)}.txt`
    : `whisk_prompts_${id.slice(0,8)}.txt`;

  // UTF-8 BOM 추가 — 한글이 메모장/엑셀에서 깨지지 않게
  const BOM = '\uFEFF';
  const txt = BOM + lines.join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(txt);
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow Auto Studio 프롬프트 내보내기 (짧고 깔끔한 영문)
// GET /api/project/:id/flow-prompts
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/flow-prompts', (req, res) => {
  const { id } = req.params;
  const maxScenes = req.query.maxScenes ? parseInt(req.query.maxScenes, 10) : 0;

  const metaPath = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  let scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });
  if (maxScenes > 0) scenes = scenes.slice(0, maxScenes);

  const style = (meta.imageStyle || 'cinematic realistic photography')
    .replace(/,?\s*DO NOT.*$/i, '')   // 혹시 NO_TEXT 섞여있으면 제거
    .trim();

  const lines = scenes.map(sc => {
    // AI 생성 프롬프트 우선 사용, 없으면 기존 필드에서 정제
    let scene;
    if (sc.flowPromptEn) {
      scene = sc.flowPromptEn.trim();
    } else {
      const base = (sc.prompt || sc.searchQuery || sc.sceneTitle || '')
        .replace(/Keep the attached main character exactly the same\.?\s*/gi, '')
        .replace(/Keep the main character exactly the same\.?\s*/gi, '')
        .replace(/Keep the character exactly the same\.?\s*/gi, '')
        .replace(/DO NOT RENDER ANY TEXT.*$/i, '')
        .replace(/ABSOLUTE RULE\s*[—-].*$/i, '')
        .replace(/,?\s*no text[^,\n]*/gi, '')
        .replace(/,?\s*no watermark[^,\n]*/gi, '')
        .replace(/,\s*,/g, ',')
        .trim();
      scene = base.length > 220 ? base.slice(0, 220).replace(/,\s*$/, '') : base;
    }

    // Flow Auto Studio용: Scene N 헤더 + 프롬프트
    // AI 생성 프롬프트는 이미 스타일 포함 → style 중복 추가 안 함
    const prompt = sc.flowPromptEn
      ? `${scene}, no text, no watermark`.replace(/,\s*,/g, ',').trim()
      : `${style}, ${scene}, no text, no watermark`.replace(/,\s*,/g, ',').trim();
    return `Scene ${sc.sceneNumber}\n${prompt}`;
  });

  const fname = `flow_prompts_${id.slice(0, 8)}.txt`;
  const BOM = '﻿';
  const txt = BOM + lines.join('\n\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(txt);
});

// ─────────────────────────────────────────────────────────────────────────────
// Grok 영상 프롬프트 일괄 생성 (EN + KO)
// POST /api/scenes/grok-prompts
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scenes/grok-prompts', async (req, res) => {
  const { projectId } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!projectId) return res.status(400).json({ error: 'projectId 없음' });
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 없음' });

  const metaPath = pDir(projectId, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });

  const imageStyle = meta.imageStyle || 'Cinematic realistic photography';
  const charDesc   = meta.characterDesc || '';
  const charNote   = charDesc ? `Main character: ${charDesc}. ` : '';

  // Gemini에 보낼 장면 목록 (번호 + 영문 프롬프트 + 한글 대사)
  const sceneList = scenes.map(sc => {
    const en = (sc.prompt || sc.searchQuery || sc.sceneTitle || '').slice(0, 300);
    const ko = (sc.relatedLine || sc.scriptChunk || '').slice(0, 200);
    return `[SCENE ${sc.sceneNumber}]\nEN_PROMPT: ${en}\nKO_SCRIPT: ${ko}`;
  }).join('\n\n');

  const sysPrompt = `You are a Grok Aurora AI video prompt specialist.
Transform each scene's static image description into a Grok video generation prompt.

MANDATORY elements for EVERY Grok prompt (comma-separated):
1. Core visual scene (from EN_PROMPT, keep essence)
2. Camera movement (e.g., slow camera pan right, gentle zoom in, slow dolly forward, subtle camera tilt)
3. Subject/character action (natural subtle movement fitting the scene)
4. Ambient natural motion (wind, particles, fabric, atmosphere, fire flicker, water ripple — pick what fits)
5. "5 seconds"
6. "smooth cinematic motion"
7. "4K quality"

Rules:
- NO text, subtitles, watermarks in prompt
- Keep each EN prompt under 220 characters
- Keep each KO prompt under 220 characters (Korean, same meaning)
- Match the scene's mood and ${imageStyle} style
- ${charNote}

【SCENE CONTINUITY — MANDATORY from scene 1 to last】
- Characters: maintain identical appearance (face, clothing, hair) across ALL scenes
- The end of each scene and the beginning of the next must share the same character/location/atmosphere so they flow seamlessly
- Scene 1 sets the visual world — all subsequent scenes must stay consistent with it
- No abrupt changes in character appearance or background between consecutive scenes
- If location changes, character appearance must remain identical

Return ONLY a JSON array, no markdown:
[{"sceneNumber":0,"en":"...","ko":"..."}, ...]`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt: `${sysPrompt}\n\nSCENES:\n${sceneList}`, temp: 0.7, model: 'gemini-2.5-flash' });
    const clean = raw.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
    let parsed;
    try { parsed = JSON.parse(clean); } catch (e) {
      // JSON 파싱 실패 시 배열 부분만 추출 시도
      const m = clean.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('Grok 프롬프트 JSON 파싱 실패');
      parsed = JSON.parse(m[0]);
    }

    // scene 데이터에 grokEn / grokKo 저장
    const grokMap = {};
    parsed.forEach(item => { grokMap[item.sceneNumber] = item; });

    meta.scenes = scenes.map(sc => {
      const g = grokMap[sc.sceneNumber];
      if (!g) return sc;
      return { ...sc, grokEn: g.en || '', grokKo: g.ko || '' };
    });

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ scenes: meta.scenes.map(sc => ({ sceneNumber: sc.sceneNumber, grokEn: sc.grokEn || '', grokKo: sc.grokKo || '' })) });
  } catch (e) {
    console.error('[GROK-PROMPT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow Auto Studio 이미지 프롬프트 AI 생성
// POST /api/scenes/flow-prompts-generate
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scenes/flow-prompts-generate', async (req, res) => {
  const { projectId } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!projectId) return res.status(400).json({ error: 'projectId 없음' });
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 없음' });

  const metaPath = pDir(projectId, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });

  const imageStyle = (meta.imageStyle || 'cinematic realistic photography')
    .replace(/,?\s*DO NOT.*$/i, '').trim();
  const charDesc = meta.characterDesc || '';
  const charNote = charDesc ? `Main character appearance: ${charDesc}.` : '';

  const sceneList = scenes.map(sc => {
    // scriptChunk = 실제 대본 전문 (최우선), relatedLine = 핵심 대사 (보조)
    const fullText  = (sc.scriptChunk  || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    const keyLine   = (sc.relatedLine  || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const enHint    = (sc.prompt       || sc.searchQuery || '').slice(0, 150);
    const ko = fullText || keyLine || sc.sceneTitle || '';
    return `[SCENE ${sc.sceneNumber}]
FULL_SCRIPT: ${ko}
KEY_LINE: ${keyLine}
EN_HINT (참고만): ${enHint}`;
  }).join('\n\n');

  // 신체 특성(장애/상처 등) 키워드 감지 — 별도 강제 규칙 생성
  const physicalTraits = charNote ? (() => {
    const keywords = [
      { pattern: /left arm|왼팔|왼쪽 팔/i,   rule: 'left arm must be visibly crippled/limp/hanging — NEVER shown as normal or in use' },
      { pattern: /right arm|오른팔|오른쪽 팔/i, rule: 'right arm must be visibly crippled/limp/hanging — NEVER shown as normal or in use' },
      { pattern: /blind|실명|장님|한쪽 눈/i,   rule: 'one eye must be visibly closed/scarred — NEVER shown with two normal eyes' },
      { pattern: /limp|절름|다리.*다쳐/i,       rule: 'character must be visibly limping — NEVER shown walking normally' },
      { pattern: /scar|흉터/i,                rule: 'visible scars must always be present on the character' },
    ];
    const matched = keywords.filter(k => k.pattern.test(charNote)).map(k => `⚠️ PHYSICAL TRAIT (NON-NEGOTIABLE): ${k.rule}`);
    return matched.length ? '\n' + matched.join('\n') : '';
  })() : '';

  const sysPrompt = `You are an expert AI image prompt writer for Flow Auto Studio (text-to-image).

Your ONLY job: read FULL_SCRIPT and generate an image prompt that EXACTLY visualizes what is happening in that scene.

PROMPT STRUCTURE (comma-separated, in this order):
1. Style: ${imageStyle}
2. ${charNote ? `Character: ${charNote}` : 'Character appearance consistent with story'}
3. ⭐ CHARACTER ACTION — what the character is SPECIFICALLY doing RIGHT NOW in FULL_SCRIPT (THIS IS THE MOST CRITICAL PART)
4. ⭐ SETTING — the exact location/environment described in FULL_SCRIPT
5. MOOD/LIGHTING — the emotional atmosphere matching FULL_SCRIPT

ABSOLUTE RULES:
- FULL_SCRIPT is the ONLY source of truth — base everything on it
- EN_HINT is FORBIDDEN to copy — use only as a loose visual reference
- If FULL_SCRIPT says "lying in bed staring at the ceiling seeing a ghost" → the prompt MUST show exactly that
- If FULL_SCRIPT says "standing at a grave in the snow" → the prompt MUST show exactly that
- Generic or vague descriptions are NOT acceptable
- Each scene must be visually UNIQUE and specific to its FULL_SCRIPT
- No style duplication
- Max 250 characters per EN prompt
- Max 220 characters per KO prompt (Korean)${physicalTraits}

Return ONLY a JSON array, no markdown:
[{"sceneNumber":1,"en":"...","ko":"..."}, ...]`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt: `${sysPrompt}\n\nSCENES:\n${sceneList}`, temp: 0.7, model: 'gemini-2.5-flash' });
    const clean = raw.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(clean); } catch {
      const m = clean.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('Flow 프롬프트 JSON 파싱 실패');
      parsed = JSON.parse(m[0]);
    }

    const flowMap = {};
    parsed.forEach(item => { flowMap[item.sceneNumber] = item; });

    meta.scenes = scenes.map(sc => {
      const f = flowMap[sc.sceneNumber];
      if (!f) return sc;
      return { ...sc, flowPromptEn: f.en || '', flowPromptKo: f.ko || '' };
    });

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ scenes: meta.scenes.map(sc => ({ sceneNumber: sc.sceneNumber, flowPromptEn: sc.flowPromptEn || '', flowPromptKo: sc.flowPromptKo || '' })) });
  } catch (e) {
    console.error('[FLOW-PROMPT-GEN]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow Auto Studio — 텍스트 → 비디오 (Veo 3.1) 프롬프트 AI 생성
// POST /api/scenes/flow-video-prompts-generate
// ─────────────────────────────────────────────────────────────────────────────
const FLOW_VIDEO_STYLES = {
  cinematic:   'cinematic live-action film, shallow depth of field, dramatic lighting, film grain, widescreen',
  drama:       'emotional drama, warm soft lighting, intimate close-ups, heartfelt atmosphere, gentle color grade',
  documentary: 'nature documentary, natural lighting, wide establishing shots, crisp detail, David Attenborough style',
  nightscape:  'night cityscape, neon reflections, blue-purple tones, bokeh city lights, moody noir atmosphere',
  animation:   '2D vector animation, bold outlines, flat color, expressive motion, cartoon style',
  noir:        'noir thriller, high contrast black and white, shadow patterns, tense atmosphere, dramatic angles',
  fantasy:     'fantasy epic, magical particles, ethereal lighting, rich saturated colors, otherworldly atmosphere',
  commercial:  'commercial advertisement, bright clean lighting, polished look, dynamic energy, product-quality finish',
};

app.post('/api/scenes/flow-video-prompts-generate', async (req, res) => {
  const { projectId, videoStyle = 'cinematic' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!projectId) return res.status(400).json({ error: 'projectId 없음' });
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 없음' });

  const metaPath = pDir(projectId, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });

  const styleDesc = FLOW_VIDEO_STYLES[videoStyle] || FLOW_VIDEO_STYLES.cinematic;
  const charDesc  = meta.characterDesc || '';
  const charNote  = charDesc ? `Main character: ${charDesc}.` : '';

  const videoPhysicalTraits = charNote ? (() => {
    const keywords = [
      { pattern: /left arm|왼팔|왼쪽 팔/i,   rule: 'left arm must be visibly crippled/limp throughout all motion — NEVER animated as normal or in use' },
      { pattern: /right arm|오른팔|오른쪽 팔/i, rule: 'right arm must be visibly crippled/limp throughout all motion — NEVER animated as normal or in use' },
      { pattern: /blind|실명|장님|한쪽 눈/i,   rule: 'one eye visibly closed/scarred in all frames' },
      { pattern: /limp|절름|다리.*다쳐/i,       rule: 'character must visibly limp in all motion' },
      { pattern: /scar|흉터/i,                rule: 'scars must remain visible throughout' },
    ];
    const matched = keywords.filter(k => k.pattern.test(charNote)).map(k => `- ⚠️ PHYSICAL TRAIT (NON-NEGOTIABLE): ${k.rule}`);
    return matched.length ? '\n' + matched.join('\n') : '';
  })() : '';

  const sceneList = scenes.map(sc => {
    const ko  = (sc.relatedLine || sc.scriptChunk || sc.sceneTitle || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
    const img = (sc.flowPromptEn || sc.prompt || sc.searchQuery || '').slice(0, 150);
    return `[SCENE ${sc.sceneNumber}]\nKO_DIALOGUE: ${ko}\nIMAGE_CONTEXT: ${img}`;
  }).join('\n\n');

  const sysPrompt = `You are a Veo 3.1 video prompt specialist for Flow Auto Studio.

Generate a cinematic video prompt for each scene based on the Korean dialogue and image context.

STYLE FOR THIS BATCH: ${styleDesc}

Veo 3.1 prompt structure (comma-separated, natural English):
1. Subject + setting (faithful to KO_DIALOGUE, specific not generic)
2. Subject action/motion (subtle natural movement matching the scene mood)
3. Camera movement (choose one: slow zoom in, gentle pan left/right, slow dolly forward/back, subtle tilt up/down, static shot, handheld slight shake)
4. Lighting + atmosphere — MUST match the selected style above
5. Style descriptors from: ${styleDesc}
6. "5 seconds", "no text", "no watermark"

Rules:
- ${charNote}
- Every scene must be DISTINCT and SPECIFIC to its dialogue — no generic descriptions
- Max 250 characters per prompt
- Maintain consistent character appearance across all scenes
- NO "Keep the attached character" type phrases${videoPhysicalTraits}

Return ONLY a JSON array, no markdown:
[{"sceneNumber":1,"en":"...","ko":"..."}, ...]

ko: Korean version (same visual meaning, max 200 chars)`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt: `${sysPrompt}\n\nSCENES:\n${sceneList}`, temp: 0.7, model: 'gemini-2.5-flash', thinkingBudget: 0 });
    const clean = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(clean); } catch {
      const m = clean.match(/\[[\s\S]*?\]/s);
      if (!m) throw new Error(`Flow 텍스트→비디오 JSON 파싱 실패 (raw: ${raw.slice(0, 200)})`);
      parsed = JSON.parse(m[0]);
    }

    const flowMap = {};
    parsed.forEach(item => { flowMap[item.sceneNumber] = item; });
    meta.scenes = scenes.map(sc => {
      const f = flowMap[sc.sceneNumber];
      if (!f) return sc;
      return { ...sc, flowVideoEn: f.en || '', flowVideoKo: f.ko || '' };
    });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ scenes: meta.scenes.map(sc => ({ sceneNumber: sc.sceneNumber, flowVideoEn: sc.flowVideoEn || '', flowVideoKo: sc.flowVideoKo || '' })) });
  } catch (e) {
    console.error('[FLOW-VIDEO-GEN]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow Auto Studio — 에셋 → 비디오 (Veo 3.1) 프롬프트 AI 생성
// POST /api/scenes/flow-asset-video-prompts-generate
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scenes/flow-asset-video-prompts-generate', async (req, res) => {
  const { projectId, videoStyle = 'cinematic' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!projectId) return res.status(400).json({ error: 'projectId 없음' });
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 없음' });

  const metaPath = pDir(projectId, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });

  const styleDesc = FLOW_VIDEO_STYLES[videoStyle] || FLOW_VIDEO_STYLES.cinematic;
  const charDesc  = meta.characterDesc || '';
  const charNote  = charDesc ? `Main character: ${charDesc}.` : '';

  const sceneList = scenes.map(sc => {
    const ko  = (sc.relatedLine || sc.scriptChunk || sc.sceneTitle || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
    const img = (sc.flowPromptEn || sc.prompt || sc.searchQuery || '').slice(0, 200);
    return `[SCENE ${sc.sceneNumber}]\nKO_DIALOGUE: ${ko}\nEXISTING_IMAGE: ${img}`;
  }).join('\n\n');

  const sysPrompt = `You are a Veo 3.1 asset-to-video prompt specialist for Flow Auto Studio.

The user already has a static IMAGE for each scene. Your job is to write a prompt that ANIMATES that existing image.

STYLE FOR THIS BATCH: ${styleDesc}

Asset-to-video prompt structure (comma-separated, natural English):
1. Brief image description (match EXISTING_IMAGE exactly — same subject, setting, style)
2. Animation: what moves and how — choose motion that fits the style (${styleDesc})
3. Camera movement (match the style — dramatic for cinematic, gentle for drama, wide for documentary)
4. Atmosphere motion (ambient light shift, shadows, depth)
5. "seamless loop", "5 seconds", "no text", "no watermark"

Rules:
- ${charNote}
- The image content must NOT change — only ADD motion to what already exists
- Keep movements subtle and natural (not dramatic or unrealistic)
- Every scene must match its existing image faithfully
- Max 250 characters per prompt

Return ONLY a JSON array, no markdown:
[{"sceneNumber":1,"en":"...","ko":"..."}, ...]

ko: Korean version (same meaning, max 200 chars)`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt: `${sysPrompt}\n\nSCENES:\n${sceneList}`, temp: 0.7, model: 'gemini-2.5-flash', thinkingBudget: 0 });
    const clean = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(clean); } catch {
      const m = clean.match(/\[[\s\S]*?\]/s);
      if (!m) throw new Error(`Flow 에셋→비디오 JSON 파싱 실패 (raw: ${raw.slice(0, 200)})`);
      parsed = JSON.parse(m[0]);
    }

    const flowMap = {};
    parsed.forEach(item => { flowMap[item.sceneNumber] = item; });
    meta.scenes = scenes.map(sc => {
      const f = flowMap[sc.sceneNumber];
      if (!f) return sc;
      return { ...sc, flowAssetVideoEn: f.en || '', flowAssetVideoKo: f.ko || '' };
    });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ scenes: meta.scenes.map(sc => ({ sceneNumber: sc.sceneNumber, flowAssetVideoEn: sc.flowAssetVideoEn || '', flowAssetVideoKo: sc.flowAssetVideoKo || '' })) });
  } catch (e) {
    console.error('[FLOW-ASSET-VIDEO-GEN]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow Auto Studio 비디오 프롬프트 내보내기
// GET /api/project/:id/flow-video-prompts?type=text|asset
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/flow-video-prompts', (req, res) => {
  const { id } = req.params;
  const type = req.query.type || 'text'; // 'text' | 'asset'

  const metaPath = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });

  const lines = scenes.map(sc => {
    const prompt = type === 'asset'
      ? (sc.flowAssetVideoEn || '')
      : (sc.flowVideoEn || '');
    if (!prompt) return null;
    return `Scene ${sc.sceneNumber}\n${prompt}`;
  }).filter(Boolean);

  if (!lines.length) return res.status(400).json({ error: '먼저 AI 생성을 실행하세요' });

  const label = type === 'asset' ? 'asset_video' : 'text_video';
  const fname = `flow_${label}_prompts_${id.slice(0, 8)}.txt`;
  const BOM = '﻿';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(BOM + lines.join('\n\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Grok 영상 프롬프트 저장 (클라이언트 자동완성 결과)
// POST /api/scenes/grok-prompts-save
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scenes/grok-prompts-save', (req, res) => {
  const { projectId, scenes: builtScenes } = req.body;
  if (!projectId || !Array.isArray(builtScenes)) return res.status(400).json({ error: '파라미터 부족' });

  const metaPath = pDir(projectId, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const grokMap = {};
  builtScenes.forEach(g => { grokMap[g.sceneNumber] = g; });

  meta.scenes = (meta.scenes || []).map(sc => {
    const g = grokMap[sc.sceneNumber];
    if (!g) return sc;
    return { ...sc, grokEn: g.grokEn || '', grokKo: g.grokKo || '' };
  });

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ ok: true, count: builtScenes.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grok 영상 프롬프트 TXT 내보내기
// GET /api/project/:id/grok-prompts?lang=en|ko|both
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/grok-prompts', (req, res) => {
  const { id } = req.params;
  const lang = req.query.lang || 'both';

  const metaPath = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scenes = meta.scenes || [];
  if (!scenes.length) return res.status(400).json({ error: '장면 먼저 생성하세요' });

  const hasSome = scenes.some(sc => sc.grokEn || sc.grokKo);
  if (!hasSome) return res.status(400).json({ error: 'Grok 프롬프트를 먼저 생성하세요' });

  let output = '';
  const BOM = '\uFEFF';

  if (lang === 'vids') {
    // ── Google Vids 포맷: 장면별 제목 + 영문 프롬프트 블록
    const topic = meta.topic || '영상';
    const blocks = scenes.map(sc => {
      const title  = sc.sceneTitle ? `Scene ${sc.sceneNumber}: ${sc.sceneTitle}` : `Scene ${sc.sceneNumber}`;
      const prompt = sc.grokEn || '';
      const ko     = sc.grokKo ? `(KO) ${sc.grokKo}` : '';
      return [title, prompt, ko].filter(Boolean).join('\n');
    }).filter(Boolean);
    output = `# ${topic} — Google Vids Script\n\n` + blocks.join('\n\n---\n\n');
  } else {
    // ── Grok EN / KO / both 포맷: 한 줄씩
    const lines = scenes.map(sc => {
      const num = `[${sc.sceneNumber}]`;
      if (lang === 'en')   return `${num} ${sc.grokEn || ''}`;
      if (lang === 'ko')   return `${num} ${sc.grokKo || ''}`;
      // both
      const parts = [];
      if (sc.grokEn) parts.push(`${num} EN: ${sc.grokEn}`);
      if (sc.grokKo) parts.push(`${num} KO: ${sc.grokKo}`);
      return parts.join('\n');
    }).filter(Boolean);
    output = lines.join('\n');
  }

  const fname = lang === 'vids'
    ? `google_vids_${id.slice(0,8)}.txt`
    : `grok_prompts_${lang}_${id.slice(0,8)}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(BOM + output);
});

// 이미지 선택 → 서버 저장
app.post('/api/media/save-image', async (req, res) => {
  const { projectId, sceneIndex, imgUrl } = req.body;
  if (!projectId || !imgUrl) return res.status(400).json({ error: '파라미터 부족' });

  const imgDir  = pDir(projectId, 'images');
  mkDir(imgDir);
  const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.jpg`;
  const filePath = path.join(imgDir, fileName);

  try {
    const r   = await fetch(imgUrl);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    res.json({ saved: true, path: `/api/project/${projectId}/images/${fileName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 씬별 Grok 영상 업로드 (base64)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/upload-scene-video', express.json({ limit: '200mb' }), (req, res) => {
  const { projectId, sceneIndex, videoData } = req.body;
  if (!projectId || !videoData || sceneIndex == null)
    return res.status(400).json({ error: '파라미터 부족' });

  const videoDir = pDir(projectId, 'videos');
  mkDir(videoDir);
  const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.mp4`;
  const filePath = path.join(videoDir, fileName);

  try {
    const buf = Buffer.from(videoData, 'base64');
    if (buf.length < 1000) return res.status(400).json({ error: '영상 파일이 너무 작습니다' });
    fs.writeFileSync(filePath, buf);
    console.log(`[Video] scene_${sceneIndex} 업로드: ${(buf.length/1024/1024).toFixed(1)}MB`);
    res.json({ saved: true, path: `/api/project/${projectId}/videos/${fileName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 일괄 이미지 업로드 (Whisk 이미지 → 장면순 자동 매핑)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/bulk-upload-images', express.json({ limit: '200mb' }), (req, res) => {
  const { projectId, files } = req.body;
  // files = [{ sceneIndex, imageData, mimeType }]
  if (!projectId || !Array.isArray(files) || !files.length)
    return res.status(400).json({ error: '파라미터 부족' });

  const imgDir = pDir(projectId, 'images');
  mkDir(imgDir);

  const results = [];
  for (const f of files) {
    const { sceneIndex, imageData, mimeType = 'image/jpeg' } = f;
    if (!imageData || sceneIndex == null) continue;
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.${ext}`;
    const filePath = path.join(imgDir, fileName);
    try {
      const buf = Buffer.from(imageData, 'base64');
      fs.writeFileSync(filePath, buf);
      results.push({ sceneIndex, path: `/api/project/${projectId}/images/${fileName}` });
    } catch (e) {
      results.push({ sceneIndex, error: e.message });
    }
  }
  res.json({ saved: results.length, results });
});

// ─────────────────────────────────────────────────────────────────────────────
// 일괄 영상 업로드 (Grok 영상 → 장면순 자동 매핑)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/bulk-upload-videos', express.json({ limit: '500mb' }), (req, res) => {
  const { projectId, files } = req.body;
  // files = [{ sceneIndex, videoData }]
  if (!projectId || !Array.isArray(files) || !files.length)
    return res.status(400).json({ error: '파라미터 부족' });

  const videoDir = pDir(projectId, 'videos');
  mkDir(videoDir);

  const results = [];
  for (const f of files) {
    const { sceneIndex, videoData } = f;
    if (!videoData || sceneIndex == null) continue;
    const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.mp4`;
    const filePath = path.join(videoDir, fileName);
    try {
      const buf = Buffer.from(videoData, 'base64');
      fs.writeFileSync(filePath, buf);
      results.push({ sceneIndex, path: `/api/project/${projectId}/videos/${fileName}` });
    } catch (e) {
      results.push({ sceneIndex, error: e.message });
    }
  }
  res.json({ saved: results.length, results });
});

// ─────────────────────────────────────────────────────────────────────────────
// 장면 미디어 삭제 (이미지 또는 영상)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/delete-scene-media', (req, res) => {
  const { projectId, sceneIndex, mediaType } = req.body; // mediaType: 'image' | 'video'
  if (!projectId || sceneIndex == null || !mediaType)
    return res.status(400).json({ error: '파라미터 부족' });

  const idx = String(sceneIndex).padStart(3, '0');
  let deleted = false;

  if (mediaType === 'image') {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const p = pDir(projectId, `images/scene_${idx}.${ext}`);
      if (fs.existsSync(p)) { fs.unlinkSync(p); deleted = true; break; }
    }
  } else if (mediaType === 'video') {
    const p = pDir(projectId, `videos/scene_${idx}.mp4`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); deleted = true; }
  }

  res.json({ deleted });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pexels 영상 검색
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/videos', async (req, res) => {
  const { pexelsKey, query, projectId: vidProjectId, ethnicityHint } = req.body;
  if (!pexelsKey) return res.status(400).json({ error: 'Pexels API Key 필요' });
  if (!query)     return res.status(400).json({ error: '검색어 필요' });

  let finalQuery = query;
  try {
    let hint = ethnicityHint || '';
    if (!hint && vidProjectId) {
      const m = JSON.parse(fs.readFileSync(pDir(vidProjectId, 'meta.json'), 'utf8'));
      if ((m.scriptLang || 'ko') === 'ko') hint = 'Korean';
    }
    if (hint) finalQuery = `${query} ${hint}`;
  } catch (_) {}

  try {
    const r = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(finalQuery)}&per_page=12&orientation=landscape&size=medium`,
      { headers: { Authorization: pexelsKey } }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || `Pexels 오류 (${r.status})`);
    const videos = (d.videos || []).map(v => {
      const file = (v.video_files || [])
        .filter(f => f.file_type === 'video/mp4')
        .sort((a, b) => (b.width || 0) - (a.width || 0))
        .find(f => (f.width || 0) >= 1280)
        || (v.video_files || []).find(f => f.file_type === 'video/mp4')
        || v.video_files?.[0];
      return { id: v.id, duration: v.duration, thumb: v.image, url: file?.link, width: file?.width, user: v.user?.name || '' };
    }).filter(v => v.url);
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pexels 영상 저장 (클립 다운로드)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/media/save-video', async (req, res) => {
  const { projectId, sceneIndex, videoUrl } = req.body;
  if (!projectId || !videoUrl) return res.status(400).json({ error: '파라미터 부족' });

  const videoDir = pDir(projectId, 'videos');
  mkDir(videoDir);
  const fileName = `scene_${String(sceneIndex).padStart(3, '0')}.mp4`;
  const filePath = path.join(videoDir, fileName);

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000); // 3분 타임아웃
    let rsp;
    try {
      rsp = await fetch(videoUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!rsp.ok) throw new Error(`다운로드 실패 (${rsp.status})`);
    const buf = Buffer.from(await rsp.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    console.log(`[Video] scene_${sceneIndex} 저장: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
    res.json({ saved: true, path: `/api/project/${projectId}/videos/${fileName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 최종 MP4 렌더
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/render/final', async (req, res) => {
  sseHeaders(res);
  const { projectId, videoRenderMode = 'loop' } = req.body;
  if (!projectId) { sseSend(res, { type: 'error', error: 'projectId 필요' }); return res.end(); }

  sseSend(res, { type: 'progress', pct: 3, msg: '렌더 준비 중…' });

  const audioPath = pDir(projectId, 'audio', 'audio_full.wav');
  const imgDir    = pDir(projectId, 'images');
  const finalDir  = pDir(projectId, 'final');
  const finalPath = path.join(finalDir, 'final.mp4');

  mkDir(finalDir);

  const meta     = JSON.parse(fs.readFileSync(pDir(projectId, 'meta.json'), 'utf8'));
  const isShorts = !!meta.isShorts;
  const shortsSubtitle = !!meta.shortsSubtitle;
  // 쇼츠: 1080x1920 (9:16 세로), 롱폼: 1920x1080
  const VW = isShorts ? 1080 : 1920;
  const VH = isShorts ? 1920 : 1080;
  const scaleFilter = `scale=${VW}:${VH}:force_original_aspect_ratio=decrease,pad=${VW}:${VH}:(ow-iw)/2:(oh-ih)/2`;
  const audioDir = pDir(projectId, 'audio');

  // audio_full.wav 없거나 손상(< 1KB)이면 세그먼트 파일로 자동 재조립
  const audioExists  = fs.existsSync(audioPath);
  const audioTooSmall = audioExists && fs.statSync(audioPath).size < 1000;

  if (!audioExists || audioTooSmall) {
    const segFiles = fs.existsSync(audioDir)
      ? fs.readdirSync(audioDir).filter(f => /^segment_\d+\.wav$/i.test(f)).sort()
          .map(f => path.join(audioDir, f))
          .filter(f => fs.existsSync(f) && fs.statSync(f).size > 1000)
      : [];

    if (!segFiles.length) {
      sseSend(res, { type: 'error', error: 'TTS 오디오가 없습니다. TTS를 다시 생성해주세요.' });
      return res.end();
    }

    sseSend(res, { type: 'progress', pct: 8, msg: `오디오 재조립 중… (세그먼트 ${segFiles.length}개)` });
    console.log(`[Render] audio_full.wav ${audioExists ? '손상' : '없음'} → 세그먼트 ${segFiles.length}개로 재조립`);
    const listFile    = path.join(audioDir, 'concat_render.txt');
    const listContent = segFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-af', 'dynaudnorm=f=500:g=31:r=0.9,loudnorm=I=-16:LRA=7:TP=-1.5', '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1'])
        .output(audioPath)
        .on('end', resolve)
        .on('error', (e) => {
          // fallback: loudnorm만
          ffmpeg()
            .input(listFile).inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-af', 'loudnorm=I=-16:LRA=11:TP=-1.5', '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1'])
            .output(audioPath).on('end', resolve).on('error', reject).run();
        })
        .run();
    });
    console.log('[Render] 재조립 완료 →', audioPath);
  }

  // duration 계산 (4단계 fallback)
  let totalDuration = await audioDuration(audioPath);

  if (!totalDuration || totalDuration <= 0) {
    totalDuration = meta.tts?.totalDuration || 0;
    if (totalDuration > 0) console.log('[Render] ffprobe 실패 → meta 값 사용:', totalDuration);
  }
  if (!totalDuration || totalDuration <= 0) {
    totalDuration = (meta.tts?.segments || []).filter(s => !s.error).reduce((acc, s) => acc + (s.duration || 0), 0);
    if (totalDuration > 0) console.log('[Render] meta 없음 → 세그먼트 합산:', totalDuration);
  }
  if (!totalDuration || totalDuration <= 0) {
    try {
      const stat     = fs.statSync(audioPath);
      const dataBytes = stat.size - 44;
      if (dataBytes > 0) {
        totalDuration = dataBytes / 48000;
        console.log(`[Render] 파일크기 계산 → ${totalDuration.toFixed(1)}초 (${stat.size} bytes)`);
      }
    } catch (e) { console.log('[Render] 파일크기 계산 실패:', e.message); }
  }
  if (!totalDuration || totalDuration <= 0) {
    sseSend(res, { type: 'error', error: 'TTS 오디오 길이를 확인할 수 없습니다. TTS를 다시 생성해주세요.' });
    return res.end();
  }
  console.log(`[Render] totalDuration=${totalDuration.toFixed(1)}초 (${fmtSec(totalDuration)})`);
  sseSend(res, { type: 'progress', pct: 12, msg: `오디오 확인 완료 (${fmtSec(totalDuration)})` });

  const videoDir   = pDir(projectId, 'videos');
  const videoFiles = fs.existsSync(videoDir)
    ? fs.readdirSync(videoDir).filter(f => /^scene_\d+\.mp4$/i.test(f)).sort()
    : [];
  const images = fs.existsSync(imgDir)
    ? fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort()
    : [];

  // allNums는 interview splice 후처리에서도 사용하므로 try 밖에 선언
  let allNums = [], imgMap = {}, vidMap = {};

  try {
    const durStr = totalDuration.toFixed(3); // 정확한 오디오 길이 사용 (Math.ceil 제거 — 올림 시 영상이 먼저 끝나 정지되는 버그)

    // ── 장면 번호별 미디어 매핑 (영상 우선, 없으면 이미지) ──────────────────
    images.forEach(f => { const m = f.match(/(\d+)/); if (m) imgMap[parseInt(m[1])] = f; });
    videoFiles.forEach(f => { const m = f.match(/(\d+)/); if (m) vidMap[parseInt(m[1])] = f; });
    allNums = [...new Set([...Object.keys(imgMap).map(Number), ...Object.keys(vidMap).map(Number)])].sort((a, b) => a - b);

    // BGM 경로 및 여부 (검은 화면 경로에서도 공유 사용)
    const bgmPathGlobal = path.join(pDir(projectId, 'bgm'), 'bgm.mp3');
    const _bgmExists = fs.existsSync(bgmPathGlobal) && fs.statSync(bgmPathGlobal).size > 5000;
    const _bgmIsAudio = (() => {
      if (!_bgmExists) return false;
      try {
        const hdr = Buffer.alloc(12);
        const fd  = fs.openSync(bgmPathGlobal, 'r');
        fs.readSync(fd, hdr, 0, 12, 0);
        fs.closeSync(fd);
        const hex = hdr.toString('hex');
        return hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3')
          || hex.startsWith('fff2') || hex.startsWith('52494646') || hex.startsWith('4f676753')
          || hdr.slice(4,8).toString('ascii') === 'ftyp';
      } catch (_) { return false; }
    })();
    const hasBgmGlobal = _bgmIsAudio;
    if (_bgmExists && !_bgmIsAudio) console.warn('[Render] ⚠ BGM 파일이 오디오가 아님 (HTML?) — BGM 없이 렌더링');
    const bgmVolGlobal  = parseFloat(meta.bgm?.volume ?? 0.12);

    if (allNums.length === 0) {
      // 미디어 없음 → 검은 화면 + 오디오 (+ BGM 있으면 믹싱)
      sseSend(res, { type: 'progress', pct: 30, msg: '미디어 없음 — 검은 화면으로 렌더링 중…' });
      console.log('[Render] 미디어 없음 → 검은 화면');
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg()
          .input(`color=black:s=${VW}x${VH}:r=1`)
          .inputOptions(['-f', 'lavfi', '-t', durStr])
          .input(audioPath);

        if (hasBgmGlobal) {
          cmd = cmd.input(bgmPathGlobal).inputOptions(['-stream_loop', '-1']);
          const fadeDur = Math.min(2.5, totalDuration * 0.05);
          const fadeOut = Math.max(0, totalDuration - fadeDur);
          cmd.outputOptions([
            '-filter_complex',
            `[1:a]volume=1.0[tts];` +
            `[2:a]volume=${bgmVolGlobal},afade=t=in:st=0:d=${fadeDur.toFixed(2)},afade=t=out:st=${fadeOut.toFixed(2)}:d=${fadeDur.toFixed(2)}[bgm];` +
            `[tts][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`,
            '-map', '0:v', '-map', '[aout]',
            '-c:v', 'libx264', '-c:a', 'aac', '-t', durStr, '-pix_fmt', 'yuv420p'
          ]);
          console.log(`[Render] 검은화면 BGM 믹싱: "${meta.bgm?.title}" vol=${bgmVolGlobal}`);
        } else {
          cmd.outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-t', durStr, '-pix_fmt', 'yuv420p']);
        }

        cmd.output(finalPath).on('end', resolve).on('error', reject).run();
      });

    } else {
      // ── 혼합 모드: 장면별 영상 + 이미지 클립 혼합 렌더 ────────────────────
      const sceneCount  = allNums.length;
      const segDuration = totalDuration / sceneCount;
      const procDir     = path.join(finalDir, '_proc');
      mkDir(procDir);

      console.log(`[Render] 혼합 모드: 총 ${sceneCount}장면, 씬당 ${segDuration.toFixed(1)}초 (영상:${Object.keys(vidMap).length}개 이미지:${Object.keys(imgMap).length}개)`);

      const clipFiles = [];

      const PRESET = 'ultrafast'; // 중간 클립은 빠르게 (최종 합성 때 재인코딩됨)

      const makeVidClip = (src, outPath, dur) => new Promise((resolve, reject) => {
        ffmpeg()
          .input(src).inputOptions(['-t', dur.toFixed(3)])
          .outputOptions([
            '-vf', `${scaleFilter},fps=25`,
            '-c:v', 'libx264', '-crf', '23', '-preset', PRESET, '-an', '-pix_fmt', 'yuv420p'
          ])
          .output(outPath).on('end', resolve).on('error', reject).run();
      });

      const makeImgClip = (src, outPath, dur) => new Promise((resolve, reject) => {
        ffmpeg()
          .input(src).inputOptions(['-loop', '1', '-t', dur.toFixed(3)])
          .outputOptions([
            '-vf', `${scaleFilter},fps=25`,
            '-c:v', 'libx264', '-crf', '23', '-preset', PRESET, '-an', '-pix_fmt', 'yuv420p',
            '-t', dur.toFixed(3)
          ])
          .output(outPath).on('end', resolve).on('error', reject).run();
      });

      // ── 루프 모드: 영상 클립을 장면 전체 시간 동안 반복 재생 ─────────────────
      const makeLoopVidClip = (src, outPath, dur) => new Promise((resolve, reject) => {
        ffmpeg()
          .input(src).inputOptions(['-stream_loop', '-1', '-t', dur.toFixed(3)])
          .outputOptions([
            '-vf', `${scaleFilter},fps=25`,
            '-c:v', 'libx264', '-crf', '23', '-preset', PRESET, '-an', '-pix_fmt', 'yuv420p',
            '-t', dur.toFixed(3)
          ])
          .output(outPath).on('end', resolve).on('error', reject).run();
      });

      // ── 검은 화면 클립 (이미지 없는 장면용) ──────────────────────────────────
      const makeBlackClip = (outPath, dur) => new Promise((resolve, reject) => {
        ffmpeg()
          .input(`color=black:s=${VW}x${VH}:r=25`)
          .inputOptions(['-f', 'lavfi', '-t', dur.toFixed(3)])
          .outputOptions([
            '-c:v', 'libx264', '-crf', '23', '-preset', PRESET, '-an', '-pix_fmt', 'yuv420p',
            '-t', dur.toFixed(3)
          ])
          .output(outPath).on('end', resolve).on('error', reject).run();
      });

      // ── 오버레이 1회 모드: 이미지 배경 + 영상 클립 1회 재생 → 나머지 이미지 ──
      const makeOverlayOnceClip = (imgSrc, vidSrc, outPath, dur) => new Promise((resolve, reject) => {
        const overlayFilter =
          `[0:v]${scaleFilter}[bg];` +
          `[1:v]${scaleFilter}[fg];` +
          '[bg][fg]overlay=0:0';
        ffmpeg()
          .input(imgSrc).inputOptions(['-loop', '1', '-t', dur.toFixed(3)])
          .input(vidSrc)
          .outputOptions([
            '-filter_complex', overlayFilter,
            '-c:v', 'libx264', '-crf', '23', '-preset', PRESET, '-an', '-pix_fmt', 'yuv420p',
            '-t', dur.toFixed(3)
          ])
          .output(outPath).on('end', resolve).on('error', reject).run();
      });

      sseSend(res, { type: 'progress', pct: 15, msg: `장면 클립 생성 시작 (총 ${allNums.length}장면)` });

      // ── 4개씩 병렬 처리 (마지막 장면은 순서 보장 위해 별도 처리) ──────────────
      const PARALLEL = 4;
      const lastIdx   = allNums.length - 1;
      const clipMap   = {}; // index → [파일경로, ...]

      // 일반 장면(0 ~ lastIdx-1) 병렬 처리
      for (let b = 0; b < lastIdx; b += PARALLEL) {
        const batch = allNums.slice(b, Math.min(b + PARALLEL, lastIdx));
        await Promise.all(batch.map(async (num, bi) => {
          const i       = b + bi;
          const pfx     = `clip_${String(i).padStart(3, '0')}`;
          const hasVid  = !!vidMap[num];
          const hasImg  = !!imgMap[num];
          const clipDur = segDuration;
          const clipPct = 15 + Math.round(((b + bi + 1) / allNums.length) * 55);
          sseSend(res, { type: 'progress', pct: clipPct, msg: `장면 ${i + 1}/${allNums.length} 처리 중… (scene_${num})` });

          if (hasVid && hasImg) {
            const vidSrc  = path.join(videoDir, vidMap[num]);
            const imgSrc  = path.join(imgDir,   imgMap[num]);
            const clipPath = path.join(procDir, `${pfx}.mp4`);
            if (videoRenderMode === 'loop') {
              await makeLoopVidClip(vidSrc, clipPath, clipDur);
            } else {
              await makeOverlayOnceClip(imgSrc, vidSrc, clipPath, clipDur);
            }
            clipMap[i] = [clipPath];
          } else if (hasVid) {
            const clipPath = path.join(procDir, `${pfx}.mp4`);
            const src = path.join(videoDir, vidMap[num]);
            if (videoRenderMode === 'loop') {
              await makeLoopVidClip(src, clipPath, clipDur);
            } else {
              await makeVidClip(src, clipPath, clipDur);
            }
            clipMap[i] = [clipPath];
          } else if (hasImg) {
            const clipPath = path.join(procDir, `${pfx}.mp4`);
            const src = path.join(imgDir, imgMap[num]);
            await makeImgClip(src, clipPath, clipDur);
            clipMap[i] = [clipPath];
          } else {
            clipMap[i] = []; // 미디어 없음
          }
        }));
      }

      // 마지막 장면 처리 (별도 — 특수 로직 있음)
      if (allNums.length > 0) {
        const i      = lastIdx;
        const num    = allNums[i];
        const pfx    = `clip_${String(i).padStart(3, '0')}`;
        const hasVid = !!vidMap[num];
        const hasImg = !!imgMap[num];
        const clipDur = segDuration + 0.5;
        sseSend(res, { type: 'progress', pct: 70, msg: `마지막 장면 처리 중… (scene_${num})` });

        if (hasVid) {
          const vidSrc       = path.join(videoDir, vidMap[num]);
          const actualVidDur = await getVideoDuration(vidSrc);
          const imgClipPath  = path.join(procDir, `${pfx}_a.mp4`);
          if (hasImg) {
            await makeImgClip(path.join(imgDir, imgMap[num]), imgClipPath, clipDur);
          } else {
            await makeBlackClip(imgClipPath, clipDur);
          }
          const vidClipPath = path.join(procDir, `${pfx}_b.mp4`);
          await makeVidClip(vidSrc, vidClipPath, actualVidDur);
          clipMap[i] = [imgClipPath, vidClipPath];
        } else if (hasImg) {
          const clipPath = path.join(procDir, `${pfx}.mp4`);
          await makeImgClip(path.join(imgDir, imgMap[num]), clipPath, clipDur);
          clipMap[i] = [clipPath];
        } else {
          clipMap[i] = [];
        }
      }

      // 순서대로 clipFiles 조립
      for (let i = 0; i < allNums.length; i++) {
        (clipMap[i] || []).forEach(f => clipFiles.push(f));
      }

      sseSend(res, { type: 'progress', pct: 72, msg: '영상 클립 합치는 중…' });

      // 클립 concat + 오디오 합성
      const concatTxt = path.join(procDir, 'concat.txt');
      fs.writeFileSync(concatTxt, clipFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

      // BGM 믹싱 여부 결정 (상위에서 선언한 bgmPathGlobal/hasBgmGlobal/bgmVolGlobal 재사용)
      const bgmPath = bgmPathGlobal;
      const hasBgm  = hasBgmGlobal;
      const bgmVol  = bgmVolGlobal;

      if (hasBgm) {
        console.log(`[Render] BGM 파일 확인: ${bgmPath} (${(fs.statSync(bgmPath).size / 1024).toFixed(0)}KB)`);
        sseSend(res, { type: 'progress', pct: 75, msg: `오디오 + BGM 믹싱 중… (${meta.bgm?.title || 'BGM'})` });
      } else {
        if (meta.bgm) console.warn(`[Render] ⚠ meta.bgm 존재하지만 파일 없음: ${bgmPath}`);
        else console.log('[Render] BGM 없음 → TTS 단독 오디오');
        sseSend(res, { type: 'progress', pct: 75, msg: '오디오 합성 중…' });
      }

      const runFinalCmd = (withBgm) => new Promise((resolve, reject) => {
        let cmd = ffmpeg()
          .input(concatTxt).inputOptions(['-f', 'concat', '-safe', '0'])
          .input(audioPath);

        if (withBgm) {
          cmd = cmd.input(bgmPath).inputOptions(['-stream_loop', '-1']);
          const fadeDur = Math.min(2.5, totalDuration * 0.05);
          const fadeOut = Math.max(0, totalDuration - fadeDur);
          cmd.outputOptions([
            '-filter_complex',
            `[1:a]volume=1.0[tts];` +
            `[2:a]volume=${bgmVol},afade=t=in:st=0:d=${fadeDur.toFixed(2)},afade=t=out:st=${fadeOut.toFixed(2)}:d=${fadeDur.toFixed(2)}[bgm];` +
            `[tts][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`,
            '-map', '0:v', '-map', '[aout]',
            '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-t', durStr
          ]);
          console.log(`[Render] BGM 믹싱 시작: "${meta.bgm?.title}" vol=${bgmVol} fade=${fadeDur.toFixed(1)}s`);
        } else {
          cmd.outputOptions([
            '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-t', durStr
          ]);
        }

        cmd.output(finalPath).on('end', resolve).on('error', reject).run();
      });

      if (hasBgm) {
        try {
          await runFinalCmd(true);
          console.log('[Render] BGM 믹싱 완료');
        } catch (bgmErr) {
          console.error('[Render] BGM 믹싱 실패, BGM 없이 재시도:', bgmErr.message);
          await runFinalCmd(false);
        }
      } else {
        await runFinalCmd(false);
      }
    }

    sseSend(res, { type: 'progress', pct: 82, msg: '영상 완성 중…' });

    // ── 인터뷰 클립 후처리 (post-process splice) ─────────────────────────────
    const ivClips = (meta.interviewClips || [])
      .filter(c => {
        const f = path.join(pDir(projectId, 'interview'), c.fileName);
        return fs.existsSync(f);
      })
      .sort((a,b) => a.sceneNumber - b.sceneNumber);

    if (ivClips.length > 0) {
      const sceneCount  = allNums?.length || 1;
      const segDur      = totalDuration / sceneCount;
      let   currentFile = finalPath;
      let   timeOffset  = 0;
      const procDir2    = path.join(finalDir, '_proc');
      mkDir(procDir2);

      for (let i = 0; i < ivClips.length; i++) {
        const iv     = ivClips[i];
        const ivFile = path.join(pDir(projectId, 'interview'), iv.fileName);

        // duration 확인 (저장된 값 우선, 없으면 ffprobe)
        let ivDur = iv.duration > 0 ? iv.duration : await getVideoDuration(ivFile);
        if (ivDur <= 0) { console.log(`[Interview] scene_${iv.sceneNumber} duration=0 → 건너뜀`); continue; }

        // 삽입 위치: 해당 씬 시작 직전
        const sceneIdx   = (allNums || []).indexOf(iv.sceneNumber);
        if (sceneIdx < 0) { console.log(`[Interview] scene_${iv.sceneNumber} 씬 목록 미포함 → 건너뜀`); continue; }

        // 메인 영상의 현재 실제 길이 다시 측정 (이전 splice로 늘어났을 수 있음)
        const mainDur    = await getVideoDuration(currentFile);
        const insertTime = Math.min(sceneIdx * segDur + timeOffset, mainDur - 0.1);
        if (insertTime < 0) { console.log(`[Interview] scene_${iv.sceneNumber} insertTime=${insertTime.toFixed(2)}s 음수 → 0으로 보정`); }
        const safeInsert = Math.max(insertTime, 0);

        const outFile = path.join(procDir2, `iv_splice_${String(i).padStart(3,'0')}.mp4`);

        console.log(`[Interview] scene_${iv.sceneNumber} 삽입: T=${safeInsert.toFixed(2)}s dur=${ivDur.toFixed(2)}s fade=${iv.fadeDuration || 0.8}s`);
        try {
          await spliceInterviewClip(currentFile, ivFile, safeInsert, ivDur, iv.fadeDuration || 0.8, outFile);
          // 결과 파일 유효성 확인
          const outDur = await getVideoDuration(outFile);
          if (outDur < 1) throw new Error(`출력 파일 길이 이상: ${outDur}s`);
          currentFile  = outFile;
          timeOffset  += ivDur;
          console.log(`[Interview] splice 완료 → 총 길이 ${outDur.toFixed(1)}s`);
        } catch (spliceErr) {
          console.error(`[Interview] scene_${iv.sceneNumber} splice 실패, 건너뜀:`, spliceErr.message);
          // 실패해도 다음 클립은 계속 처리 (currentFile 유지)
        }
      }

      // 후처리 결과를 final.mp4에 덮어씌움
      if (currentFile !== finalPath) {
        fs.copyFileSync(currentFile, finalPath);
        console.log(`[Interview] ${ivClips.length}개 클립 삽입 완료`);
      }
    }

    // ── 인트로 / 아웃트로 붙이기 ────────────────────────────────────────────────
    const bookendDir    = pDir(projectId, 'bookend');
    const introPath     = path.join(bookendDir, 'intro.mp4');
    const outroPath     = path.join(bookendDir, 'outro.mp4');
    const hasIntro      = fs.existsSync(introPath) && fs.statSync(introPath).size > 10000;
    const hasOutro      = fs.existsSync(outroPath) && fs.statSync(outroPath).size > 10000;

    if (hasIntro || hasOutro) {
      sseSend(res, { type: 'progress', pct: 92, msg: `인트로/아웃트로 합치는 중…` });
      console.log(`[Bookend] 인트로=${hasIntro} 아웃트로=${hasOutro}`);
      const procDir3   = path.join(finalDir, '_proc');
      mkDir(procDir3);

      // 인트로/아웃트로를 메인 영상과 동일 스펙으로 트랜스코딩 (해상도·코덱 통일)
      const transcodeBookend = async (srcPath, label) => {
        const outPath = path.join(procDir3, `${label}_norm.mp4`);
        // 오디오 트랙 존재 여부 확인
        const srcInfo = await new Promise(resolve => {
          ffmpeg.ffprobe(srcPath, (err, meta) => {
            if (err || !meta) return resolve({ hasAudio: false });
            const hasAudio = (meta.streams || []).some(s => s.codec_type === 'audio');
            resolve({ hasAudio });
          });
        });
        await new Promise((resolve, reject) => {
          const cmd = ffmpeg().input(srcPath);
          const outputOpts = [
            '-vf', `scale=${VW}:${VH}:force_original_aspect_ratio=decrease,pad=${VW}:${VH}:(ow-iw)/2:(oh-ih)/2`,
            '-c:v', 'libx264', '-crf', '23', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          ];
          if (srcInfo.hasAudio) {
            outputOpts.push('-map', '0:v', '-map', '0:a');
          } else {
            // 오디오 없는 영상 → 무음 트랙 삽입 후 concat 스펙 통일
            cmd.input('anullsrc=r=44100:cl=stereo').inputOptions(['-f', 'lavfi']);
            outputOpts.push('-map', '0:v', '-map', '1:a', '-shortest');
          }
          cmd.outputOptions(outputOpts)
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        return outPath;
      };

      // 메인 영상도 동일 스펙으로 재인코딩 (concat 스펙 통일)
      const mainNormPath = path.join(procDir3, 'main_norm.mp4');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(finalPath)
          .outputOptions([
            '-c:v', 'libx264', '-crf', '22', '-preset', 'fast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          ])
          .output(mainNormPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // concat 파일 구성
      const concatParts = [];
      if (hasIntro)  concatParts.push(await transcodeBookend(introPath,  'intro'));
      concatParts.push(mainNormPath);
      if (hasOutro)  concatParts.push(await transcodeBookend(outroPath,  'outro'));

      const bookendConcat = path.join(procDir3, 'bookend_concat.txt');
      fs.writeFileSync(bookendConcat, concatParts.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

      const bookendOut = path.join(procDir3, 'bookend_final.mp4');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bookendConcat)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])  // 스펙 통일 후 스트림 복사
          .output(bookendOut)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      fs.copyFileSync(bookendOut, finalPath);
      console.log(`[Bookend] 완료 → ${hasIntro ? '인트로+' : ''}본편${hasOutro ? '+아웃트로' : ''}`);
    }

    // ── BGM 믹싱 ─────────────────────────────────────────────────────────────
    const bgmPath   = meta.bgm?.path ? path.join(PROJECTS_DIR, projectId, meta.bgm.path.replace(/^.*projects\/[^/]+\//, '')) : null;
    const bgmVolume = meta.bgm?.volume ?? 0.15; // 기본 15%
    if (bgmPath && fs.existsSync(bgmPath)) {
      sseSend(res, { type: 'progress', pct: 96, msg: 'BGM 믹싱 중…' });
      const bgmOut = path.join(finalDir, 'final_bgm.mp4');
      try {
        const finalDuration = await getVideoDuration(finalPath);
      await new Promise((resolve, reject) => {
          ffmpeg()
            .input(finalPath)
            .input(bgmPath)
            .complexFilter([
              // BGM을 영상 길이에 맞게 루프 처리 + 볼륨 조절
              `[1:a]aloop=loop=-1:size=2e+09,atrim=duration=${finalDuration},volume=${bgmVolume}[bgm]`,
              `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
            ])
            .outputOptions([
              '-map', '0:v', '-map', '[aout]',
              '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'
            ])
            .output(bgmOut)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        fs.copyFileSync(bgmOut, finalPath);
        console.log(`[BGM] 믹싱 완료 (볼륨: ${Math.round(bgmVolume * 100)}%)`);
      } catch (e) {
        console.log('[BGM] 믹싱 실패 (BGM 없이 계속):', e.message);
      }
    }

    const renderMode = Object.keys(vidMap).length > 0 && Object.keys(imgMap).length > 0 ? 'mixed'
      : Object.keys(vidMap).length > 0 ? 'video'
      : Object.keys(imgMap).length > 0 ? 'image' : 'black';

    meta.status = 'render_done';
    meta.finalVideo = `/api/project/${projectId}/final/final.mp4`;
    fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify(meta, null, 2));

    sseSend(res, { type: 'done', url: `/api/project/${projectId}/final/final.mp4`, status: 'done', mode: renderMode, isShorts });
    res.end();
  } catch (err) {
    sseSend(res, { type: 'error', error: err.message });
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 인물 이미지 분석 → 한국어 + 영어 외모 설명 추출
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/character/extract', async (req, res) => {
  const { imageData, mimeType = 'image/jpeg' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey)  return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!imageData)  return res.status(400).json({ error: '이미지 데이터 필요' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: `이 이미지에 등장하는 인물(들)의 시각적 외모를 분석하라.

아래 형식을 반드시 지켜라. 다른 설명 절대 쓰지 마라.

[KOREAN]
인물명(또는 인물1): 나이대, 체형, 얼굴형, 머리카락(색·길이·스타일), 눈, 피부톤, 의상, 특징적 요소
(인물이 여러 명이면 한 줄씩)
[/KOREAN]

[ENGLISH]
CharacterName (or Person1): age range, body type, face shape, hair (color, length, style), eyes, skin tone, clothing, distinctive features
(one line per person)
[/ENGLISH]

- 성격·역할·배경 설명 금지, 오직 눈에 보이는 외모만 작성
- 인물이 없으면 [KOREAN]없음[/KOREAN][ENGLISH]none[/ENGLISH] 출력`
            },
            { inlineData: { mimeType, data: imageData } }
          ]
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `Gemini 오류 (${r.status})`);

    const text    = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const korean  = parseSingleTag(text, 'KOREAN').trim();
    const english = parseSingleTag(text, 'ENGLISH').trim();

    if (!korean && !english) throw new Error('인물 외모 추출 실패 — 인물이 포함된 이미지인지 확인하세요');
    res.json({ korean, english });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 상태 조회
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/status/:projectId', (req, res) => {
  const dir = pDir(req.params.projectId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '프로젝트 없음' });
  res.json(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')));
});

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 목록 조회
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/projects/list', (req, res) => {
  if (!fs.existsSync(PROJECTS_DIR)) return res.json({ projects: [] });
  const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
    const mp = path.join(PROJECTS_DIR, d, 'meta.json');
    return fs.existsSync(mp);
  });
  const projects = dirs.map(d => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, d, 'meta.json'), 'utf8'));
      const imgDir = path.join(PROJECTS_DIR, d, 'images');
      const imgCount = fs.existsSync(imgDir)
        ? fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).length : 0;
      return {
        id: d,
        topic:       meta.topic       || '(제목 없음)',
        channelName: meta.channelName || '',
        createdAt:   meta.createdAt   || '',
        uploadedAt:  meta.uploadedAt  || '',   // 유튜브 업로드 날짜
        status:      meta.status      || 'created',
        videoLength: meta.videoLength || '',
        sceneCount:  (meta.scenes || []).length,
        imgCount,
        hasTTS:   !!meta.tts,
        hasFinal: !!meta.finalVideo,
        isShorts: !!meta.isShorts
      };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const longform = projects.filter(p => !p.isShorts).slice(0, 30);
  const shorts   = projects.filter(p =>  p.isShorts).slice(0, 30);
  res.json({ projects: [...longform, ...shorts], all: projects });
});

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈 관리
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// BGM 업로드 / 삭제 / 추천
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/:id/bgm/upload', (req, res) => {
  const { id } = req.params;
  const { audioData, mimeType = 'audio/mpeg', volume = 0.15 } = req.body;
  if (!audioData) return res.status(400).json({ error: '오디오 데이터 필요' });
  const ext     = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : 'mp3';
  const bgmDir  = path.join(PROJECTS_DIR, id, 'bgm');
  mkDir(bgmDir);
  const bgmFile = path.join(bgmDir, `bgm.${ext}`);
  fs.writeFileSync(bgmFile, Buffer.from(audioData, 'base64'));
  const mp = pDir(id, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  meta.bgm = { path: `bgm/bgm.${ext}`, volume: Number(volume), fileName: `bgm.${ext}` };
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
  res.json({ ok: true, path: meta.bgm.path });
});

app.post('/api/project/:id/bgm/volume', (req, res) => {
  const { id } = req.params;
  const { volume } = req.body;
  const mp = pDir(id, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (!meta.bgm) return res.status(400).json({ error: 'BGM 없음' });
  meta.bgm.volume = Math.max(0, Math.min(1, Number(volume)));
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
  res.json({ ok: true });
});

app.delete('/api/project/:id/bgm', (req, res) => {
  const { id } = req.params;
  const mp = pDir(id, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (meta.bgm?.path) {
    const f = path.join(PROJECTS_DIR, id, meta.bgm.path);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  delete meta.bgm;
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
  res.json({ ok: true });
});

app.post('/api/bgm/suggest', async (req, res) => {
  const { topic, isShorts, shortsStyle, mode, scriptLang = 'ko' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });

  const styleHint = shortsStyle || (isShorts ? '쇼츠' : '롱폼');
  const prompt = `당신은 유튜브 영상 음악 전문 큐레이터입니다.
아래 영상에 어울리는 배경음악을 추천하세요.

영상 주제: ${topic || ''}
스타일: ${styleHint}
언어: ${scriptLang === 'en' ? '영어' : '한국어'}

다음 JSON 형식으로만 응답:
{
  "mood": "음악 분위기 (예: 따뜻하고 감동적인, 경쾌하고 유쾌한)",
  "genre": "장르 (예: 피아노 발라드, 어쿠스틱 팝)",
  "tempo": "템포 (예: 느린 70BPM, 보통 100BPM)",
  "keywords": ["유튜브 오디오 라이브러리 검색 키워드1", "키워드2", "키워드3"],
  "volume": 0.15,
  "reason": "이 음악이 어울리는 이유 한 문장"
}`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt, maxTokens: 256, temp: 0.5, thinkingBudget: 0 });
    const clean = raw.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'').replace(/^```\s*/,'');
    res.json(JSON.parse(clean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 시리즈 중복 정리 — 각 화별 최신본만 남기고 나머지 삭제
app.post('/api/series/cleanup', (req, res) => {
  const { seriesName } = req.body;
  if (!seriesName) return res.status(400).json({ error: 'seriesName 필요' });
  if (!fs.existsSync(PROJECTS_DIR)) return res.json({ deleted: 0 });

  // 같은 시리즈의 같은 화 프로젝트를 모아서 최신본만 남김
  const epMap = {}; // episode → [{id, createdAt}]
  fs.readdirSync(PROJECTS_DIR).forEach(d => {
    const mp = path.join(PROJECTS_DIR, d, 'meta.json');
    if (!fs.existsSync(mp)) return;
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (m.seriesName !== seriesName) return;
      const ep = m.episode || 1;
      if (!epMap[ep]) epMap[ep] = [];
      epMap[ep].push({ id: d, createdAt: m.createdAt || '' });
    } catch (_) {}
  });

  let deleted = 0;
  Object.values(epMap).forEach(list => {
    if (list.length <= 1) return;
    // 최신본(createdAt 기준 내림차순) 첫 번째만 남기고 나머지 삭제
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    list.slice(1).forEach(({ id }) => {
      try {
        fs.rmSync(path.join(PROJECTS_DIR, id), { recursive: true, force: true });
        deleted++;
      } catch (_) {}
    });
  });
  res.json({ deleted });
});

app.get('/api/series/list', (req, res) => {
  if (!fs.existsSync(PROJECTS_DIR)) return res.json({ series: [] });
  const seriesMap = {};
  fs.readdirSync(PROJECTS_DIR).forEach(d => {
    const mp = path.join(PROJECTS_DIR, d, 'meta.json');
    if (!fs.existsSync(mp)) return;
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (!m.seriesName) return;
      if (!seriesMap[m.seriesName]) seriesMap[m.seriesName] = { name: m.seriesName, episodes: [] };
      seriesMap[m.seriesName].episodes.push({
        id: d, episode: m.episode || 1, topic: m.topic, status: m.status, createdAt: m.createdAt,
        description:      m.description      || '',
        hashtags:         m.hashtags         || '',
        thumbnailTexts:   m.thumbnailTexts   || [],
        selectedThumbnail: m.selectedThumbnail || '',
        selectedTitle:    m.selectedTitle    || '',
      });
    } catch (_) {}
  });
  Object.values(seriesMap).forEach(s => s.episodes.sort((a,b) => a.episode - b.episode));
  res.json({ series: Object.values(seriesMap) });
});

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈 일괄 생성 — STEP1: AI가 화별 세부 주제 분배
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/series/plan', async (req, res) => {
  const { seriesName, ep1Topic, count = 5, mode = 'longform', channelName = '', scriptLang = 'ko' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!ep1Topic)  return res.status(400).json({ error: '1화 주제를 입력하세요' });

  const remaining = count - 1; // AI가 생성할 화 수 (2화~N화)
  const modeHint  = mode === 'shorts' ? '유튜브 쇼츠(60초 내외)' : '유튜브 롱폼(5~15분)';
  const chHint    = channelName ? `채널명: ${channelName}` : '';

  const prompt = scriptLang === 'en'
    ? `You are a YouTube series content planner.
Series name: "${seriesName || ep1Topic}"
Episode 1 (set by user): "${ep1Topic}"
Total episodes: ${count}
Format: ${modeHint}
${chHint}

If there is a source story or original work, divide it equally into exactly ${count} parts — one part per episode.
- Episode 1: First ${Math.round(100/count)}% of the story (introduction — characters, world, first conflict)
- Middle episodes: Each covers its consecutive ${Math.round(100/count)}% segment (no overlap, no repeating earlier content)
- Episode ${count}: Final ${Math.round(100/count)}% (resolution — closure, transformation, finale)
Each episode covers different scenes and emotions. No episode may repeat or pre-empt another episode's content.

Output ONLY this exact format (Episodes 1~${count}):
[PLAN]
${Array.from({length:count},(_,i)=>`EP${i+1}:\n주제: (episode ${i+1} specific topic)\n지침: (episode ${i+1} role + emotional arc + key scenes in 2~3 sentences)`).join('\n')}
[/PLAN]`
    : `당신은 유튜브 시리즈 콘텐츠 기획자입니다.
시리즈명: "${seriesName || ep1Topic}"
1화 주제 (사용자 확정): "${ep1Topic}"
총 편수: ${count}편
형식: ${modeHint}
${chHint}

원작이나 원본 이야기가 있다면, 그 이야기를 정확히 ${count}등분하여 각 화에 균등하게 배분하라.
- 1화: 이야기의 첫 번째 ${Math.round(100/count)}% (도입부 — 인물 소개, 세계관 설정, 첫 갈등)
- 중간화: 각각 연속된 ${Math.round(100/count)}% 구간 담당 (겹치거나 앞화 내용 반복 금지)
- ${count}화: 이야기의 마지막 ${Math.round(100/count)}% (결말 — 해소, 변화, 마무리, 여운)
각 화는 서로 다른 장면과 감정을 담당하며, 이전 화에서 다룬 내용을 다시 쓰지 않는다.
어떤 화도 다른 화의 내용을 반복하거나 선취하지 말 것.

반드시 아래 형식으로만 출력하세요 (1화~${count}화 전체):
[PLAN]
${Array.from({length:count},(_,i)=>`EP${i+1}:\n주제: (${i+1}화 구체적 주제)\n지침: (${i+1}화의 역할 + 감정 흐름 + 핵심 장면을 2~3문장으로)`).join('\n')}
[/PLAN]`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt, maxTokens: 1500, temp: 0.7, thinkingBudget: 0 });
    const block = raw.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/i)?.[1] || raw;
    const episodes = [];
    for (let i = 1; i <= count; i++) {
      const epBlock = block.match(new RegExp(`EP${i}:[\\s\\S]*?(?=EP${i+1}:|$)`, 'i'))?.[0] || '';
      const topic     = epBlock.match(/주제:\s*(.+)/i)?.[1]?.trim() || (i === 1 ? ep1Topic : '');
      const directive = epBlock.match(/지침:\s*([\s\S]+?)(?=\n주제:|\n지침:|$)/i)?.[1]?.trim() || '';
      episodes.push({ episode: i, topic: i === 1 ? ep1Topic : topic, directive });
    }
    if (episodes.length < 2) return res.status(500).json({ error: 'AI가 주제를 생성하지 못했습니다. 다시 시도하세요.' });
    res.json({ episodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 시리즈 일괄 생성 — STEP2: 화별 프로젝트 생성 + 대본 생성 (SSE 스트리밍)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/series/batch', async (req, res) => {
  const {
    episodes,           // [{episode, topic, directive?}, ...]
    seriesName,
    videoLength = '10분',
    channelName = '',
    scriptTone  = '따뜻하고 잔잔한 이야기형',
    chapterCount = 5,
    scriptLang  = 'ko',
    isShorts    = false,
    shortsStyle = '',
    batchDirective = '',
  } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!episodes?.length) return res.status(400).json({ error: 'episodes 필요' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const results = [];
  for (const ep of episodes) {
    send({ type: 'progress', episode: ep.episode, status: 'creating', message: `${ep.episode}화 프로젝트 생성 중…` });
    try {
      // 같은 시리즈명 + 같은 화수의 기존 프로젝트가 있으면 삭제 (최신본만 유지)
      if (fs.existsSync(PROJECTS_DIR)) {
        for (const d of fs.readdirSync(PROJECTS_DIR)) {
          const mp = path.join(PROJECTS_DIR, d, 'meta.json');
          if (!fs.existsSync(mp)) continue;
          try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            if (m.seriesName === seriesName && m.episode === ep.episode) {
              fs.rmSync(path.join(PROJECTS_DIR, d), { recursive: true, force: true });
            }
          } catch (_) {}
        }
      }
      // 새 프로젝트 생성
      const projectId = newId();
      const dir = pDir(projectId);
      mkDir(dir);
      mkDir(pDir(projectId, 'audio'));
      mkDir(pDir(projectId, 'images'));
      mkDir(pDir(projectId, 'final'));
      fs.writeFileSync(pDir(projectId, 'meta.json'), JSON.stringify({
        projectId, topic: ep.topic, seriesName, episode: ep.episode,
        videoLength, channelName, scriptTone, chapterCount, scriptLang,
        isShorts, shortsStyle, status: 'created', createdAt: new Date().toISOString()
      }, null, 2));

      send({ type: 'progress', episode: ep.episode, status: 'scripting', message: `${ep.episode}화 대본 생성 중…` });

      // 대본 생성 — 기존 /api/script/generate 내부 로직 재사용을 위해 내부 fetch
      const epDirective = ep.directive?.trim() || batchDirective;
      const isFinalEpisode = ep.episode === episodes.length;
      const scriptRes = await fetch(`http://localhost:${PORT}/api/script/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId, topic: ep.topic, seriesName, episode: ep.episode,
          totalEpisodes: episodes.length,
          isFinalEpisode,
          videoLength, channelName, scriptTone, chapterCount, scriptLang,
          isShorts, shortsStyle, geminiKey,
          customDirective: epDirective,
        })
      });
      const scriptData = await scriptRes.json();
      if (scriptData.error) throw new Error(scriptData.error);

      results.push({ episode: ep.episode, topic: ep.topic, projectId, ok: true });
      send({ type: 'done', episode: ep.episode, projectId, topic: ep.topic });
    } catch (err) {
      results.push({ episode: ep.episode, topic: ep.topic, ok: false, error: err.message });
      send({ type: 'error', episode: ep.episode, projectId, error: err.message });
    }
  }
  send({ type: 'complete', results });
  res.end();
});

app.post('/api/project/:id/series', (req, res) => {
  const { id } = req.params;
  const { seriesName, episode } = req.body;
  const mp = pDir(id, 'meta.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: '프로젝트 없음' });
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  meta.seriesName = seriesName || '';
  meta.episode    = Number(episode) || 1;
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEO 메타데이터 자동 생성
// POST /api/meta/generate  { projectId, topic, script, isShorts, shortsStyle }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/meta/generate', async (req, res) => {
  const { projectId, topic, script, isShorts, shortsStyle } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!topic && !script) return res.status(400).json({ error: 'topic 또는 script 필요' });

  const typeHint = isShorts ? `유튜브 쇼츠 (${shortsStyle || ''})` : '유튜브 롱폼 영상';
  const scriptSnippet = (script || '').slice(0, 1500);

  const prompt = `당신은 유튜브 SEO 전문가입니다. 아래 영상 정보를 분석해 최적화된 메타데이터를 생성하세요.

영상 유형: ${typeHint}
주제: ${topic || ''}
대본 일부:
${scriptSnippet}

아래 JSON 형식으로만 응답하세요. 다른 텍스트 절대 포함하지 마세요:
{
  "titleA": "감성/공감형 제목 (30자 이내, 이모지 1개 포함)",
  "titleB": "호기심/궁금증형 제목 (30자 이내, 물음표 또는 반전 활용)",
  "titleC": "정보/실용형 제목 (30자 이내, 숫자 또는 핵심 키워드 포함)",
  "description": "YouTube 설명란 (3~4문단, 총 200자 내외. 1문단: 영상 핵심 요약. 2문단: 시청 후 얻을 것. 3문단: 구독/좋아요 CTA. 해시태그 5개 포함)",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5", "태그6", "태그7", "태그8", "태그9", "태그10", "태그11", "태그12", "태그13", "태그14", "태그15"],
  "hashtags": ["#해시태그1", "#해시태그2", "#해시태그3", "#해시태그4", "#해시태그5"]
}`;

  try {
    const raw = await geminiText({ apiKey: geminiKey, prompt, maxTokens: 1024, temp: 0.7, thinkingBudget: 0 });
    const clean = raw.trim().replace(/^```json\s*/i,'').replace(/\s*```$/,'').replace(/^```\s*/,'');
    const parsed = JSON.parse(clean);

    // 프로젝트 meta.json에 저장
    if (projectId) {
      const mp = pDir(projectId, 'meta.json');
      if (fs.existsSync(mp)) {
        const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
        meta.seoMeta = parsed;
        fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
      }
    }
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SRT 자막 파일 다운로드
// GET /api/project/:id/srt
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/srt', (req, res) => {
  const { id } = req.params;
  const srtPath = path.join(pDir(id, 'audio'), 'subtitles.srt');

  if (!fs.existsSync(srtPath)) {
    // SRT가 없으면 meta.json의 ttsSegments로 생성
    const mp = pDir(id, 'meta.json');
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'SRT 파일 없음' });
    try {
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      const segs = meta.ttsSegments || [];
      if (!segs.length) return res.status(404).json({ error: 'TTS 세그먼트 없음 — TTS를 먼저 생성하세요' });

      let srt = '';
      let idx = 1;
      let timeAcc = 0;
      for (const seg of segs) {
        const dur = seg.duration || 3;
        const start = timeAcc;
        const end   = timeAcc + dur;
        const fmt = t => {
          const h = Math.floor(t / 3600);
          const m = Math.floor((t % 3600) / 60);
          const s = Math.floor(t % 60);
          const ms = Math.round((t % 1) * 1000);
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
        };
        const text = (seg.text || seg.content || '').trim();
        if (!text) { timeAcc += dur; continue; }
        // 20자 단위 줄바꿈
        const lines = [];
        for (let i = 0; i < text.length; i += 20) lines.push(text.slice(i, i + 20));
        srt += `${idx}\n${fmt(start)} --> ${fmt(end)}\n${lines.join('\n')}\n\n`;
        idx++;
        timeAcc += dur;
      }
      const topic = meta.topic || id;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(topic)}.srt"`);
      return res.send(srt);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const meta = (() => { try { return JSON.parse(fs.readFileSync(pDir(id, 'meta.json'), 'utf8')); } catch(_){ return {}; } })();
  const topic = meta.topic || id;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(topic)}.srt"`);
  res.sendFile(srtPath);
});

// ─────────────────────────────────────────────────────────────────────────────
// 유튜브 업로드 날짜 기록 (제출)
// POST /api/project/:id/submit  { uploadedAt: "2026-04-14" }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/:id/submit', (req, res) => {
  const { id }         = req.params;
  const { uploadedAt } = req.body;           // "YYYY-MM-DD" 형식
  const metaPath = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.uploadedAt = uploadedAt || new Date().toISOString().slice(0, 10);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`[Submit] ${id} → uploadedAt=${meta.uploadedAt}`);
    res.json({ ok: true, uploadedAt: meta.uploadedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 삭제
// POST /api/project/:id/delete
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/:id/delete', (req, res) => {
  const { id } = req.params;
  const dir = pDir(id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '프로젝트 없음' });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[Project] 삭제: ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '삭제 실패: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TTS 세그먼트 개별 재시도
// POST /api/tts/retry-segment  { projectId, segIndex, voiceName, geminiKey }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/tts/retry-segment', async (req, res) => {
  const { projectId, segIndex, voiceName = 'Aoede' } = req.body;
  const geminiKey = resolveKey(req.body.geminiKey);
  if (!geminiKey) return res.status(400).json({ error: 'Gemini API Key 필요' });
  if (!projectId || segIndex == null) return res.status(400).json({ error: '파라미터 부족' });

  const metaPath = pDir(projectId, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const segs = meta.tts?.segments;
  if (!segs || !segs[segIndex]) return res.status(400).json({ error: '세그먼트 없음' });

  const seg     = segs[segIndex];
  const text    = seg.fullText || seg.text || '';
  const ttsLang = meta.scriptLang || 'ko';
  const audioDir = pDir(projectId, 'audio');
  const fileName = `segment_${String(segIndex + 1).padStart(3, '0')}.wav`;
  const filePath = path.join(audioDir, fileName);

  try {
    const b64 = await geminiTTS({ apiKey: geminiKey, text, voiceName, lang: ttsLang });
    const wav  = pcmToWav(b64);
    fs.writeFileSync(filePath, wav);

    const { duration } = await new Promise((resolve, reject) =>
      ffmpeg.ffprobe(filePath, (err, d) => err ? reject(err) : resolve(d.format))
    );

    segs[segIndex] = { ...seg, error: undefined, duration, durationFmt: fmtSec(duration),
      url: `/api/project/${projectId}/audio/${fileName}`, fileName };
    meta.tts.segments = segs;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    res.json({ ok: true, index: segIndex + 1, duration, durationFmt: fmtSec(duration),
      url: `/api/project/${projectId}/audio/${fileName}`, fileName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 클론
// POST /api/project/:id/clone
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/project/:id/clone', (req, res) => {
  const { id } = req.params;
  const srcDir = pDir(id);
  if (!fs.existsSync(srcDir)) return res.status(404).json({ error: '프로젝트 없음' });

  const newId  = crypto.randomUUID();
  const dstDir = pDir(newId);

  try {
    const copyRecursive = (src, dst) => {
      mkDir(dst);
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyRecursive(s, d);
        else fs.copyFileSync(s, d);
      }
    };
    copyRecursive(srcDir, dstDir);

    // meta.json 업데이트
    const metaPath = pDir(newId, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.projectId  = newId;
      meta.clonedFrom = id;
      meta.createdAt  = new Date().toISOString();
      meta.topic      = (meta.topic || '') + ' (복사본)';
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }
    console.log(`[Project] 클론: ${id} → ${newId}`);
    res.json({ ok: true, newId });
  } catch (e) {
    res.status(500).json({ error: '클론 실패: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 유튜브 챕터 생성
// GET /api/project/:id/chapters
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/chapters', async (req, res) => {
  const { id } = req.params;
  const geminiKey = resolveKey(req.query.geminiKey);
  const metaPath  = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta  = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const segs  = meta.tts?.segments || [];
  if (!segs.length) return res.status(400).json({ error: 'TTS를 먼저 생성하세요' });

  const scriptPath = pDir(id, 'script.txt');
  const script     = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  const totalDur   = segs.filter(s => !s.error).reduce((acc, s) => acc + (s.duration || 0), 0);
  const chapterCount = meta.chapterCount || 5;

  // 챕터 타임스탬프: 스크립트 내 챕터별 문자 위치 → 오디오 시간으로 변환
  let chapters = [];

  if (geminiKey && script) {
    try {
      const prompt = `아래 대본을 ${chapterCount}개 챕터로 나눠라.
각 챕터의 시작 대사(첫 5~10글자)와 챕터 제목을 JSON으로 반환하라.
반드시 JSON만 출력하라:
[{"title":"챕터명","startText":"시작 대사 첫 글자들"}, ...]

대본:
${script.slice(0, 8000)}`;
      const raw   = await geminiText({ apiKey: geminiKey, prompt, temp: 0.3, maxTokens: 512, thinkingBudget: 0 });
      const clean = raw.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
      const parsed = JSON.parse(clean);

      const scriptLen = script.length;
      chapters = parsed.map((ch, i) => {
        const pos     = ch.startText ? script.indexOf(ch.startText) : -1;
        const ratio   = pos >= 0 ? pos / scriptLen : i / parsed.length;
        const timeSec = Math.round(ratio * totalDur);
        return { title: ch.title, timeSec };
      });
    } catch (_) {}
  }

  // fallback: 균등 분할
  if (!chapters.length) {
    for (let i = 0; i < chapterCount; i++) {
      chapters.push({ title: i === 0 ? '인트로' : `챕터 ${i}`, timeSec: Math.round((i / chapterCount) * totalDur) });
    }
  }

  // 첫 챕터는 항상 00:00
  chapters[0].timeSec = 0;

  const lines = chapters.map(ch => {
    const m = Math.floor(ch.timeSec / 60);
    const s = String(ch.timeSec % 60).padStart(2, '0');
    return `${m}:${s} ${ch.title}`;
  });

  res.json({ chapters: lines, totalDuration: Math.round(totalDur) });
});

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 전체 데이터 불러오기
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/load', (req, res) => {
  const { id } = req.params;
  const dir = pDir(id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '프로젝트 없음' });

  try {
    const metaPath = pDir(id, 'meta.json');
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'meta.json 없음' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const scriptPath = pDir(id, 'script.txt');
    const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';

    const imgDir = pDir(id, 'images');
    const images = fs.existsSync(imgDir)
      ? fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).map(f => {
          const m = f.match(/(\d+)/);
          return m ? { sceneIndex: parseInt(m[1]), path: `/api/project/${id}/images/${f}` } : null;
        }).filter(Boolean)
      : [];

    const vidDir = pDir(id, 'videos');
    const videos = fs.existsSync(vidDir)
      ? fs.readdirSync(vidDir).filter(f => /^scene_\d+\.mp4$/i.test(f)).map(f => {
          const m = f.match(/(\d+)/);
          return m ? { sceneIndex: parseInt(m[1]), path: `/api/project/${id}/videos/${f}` } : null;
        }).filter(Boolean)
      : [];

    res.json({ meta, script, scenes: meta.scenes || [], tts: meta.tts || null, images, videos, finalVideo: meta.finalVideo || null });
  } catch (e) {
    res.status(500).json({ error: '프로젝트 데이터 읽기 오류: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 파일 서빙 / 다운로드
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/project/:id/audio/:file', (req, res) => {
  const fp = pDir(req.params.id, 'audio', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  // stream for playback (range support) or download
  const dl = req.query.download === '1';
  if (dl) return res.download(fp);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(fp);
});

app.get('/api/project/:id/images/download-zip', (req, res) => {
  const imgDir = pDir(req.params.id, 'images');
  if (!fs.existsSync(imgDir)) return res.status(404).json({ error: '이미지 없음' });

  const images = fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (!images.length) return res.status(404).json({ error: '생성된 이미지가 없습니다' });

  let archiver;
  try { archiver = require('archiver'); }
  catch(e) { return res.status(500).json({ error: 'ZIP 기능 사용을 위해 npm install 후 서버를 재시작하세요.' }); }

  const zipName = `scenes_${req.params.id.slice(0, 8)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('[ZIP]', err.message); res.end(); });
  archive.pipe(res);
  images.forEach(img => archive.file(path.join(imgDir, img), { name: img }));
  archive.finalize();
});

app.get('/api/project/:id/images/:file', (req, res) => {
  const fp = pDir(req.params.id, 'images', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  if (req.query.download === '1') return res.download(fp);
  res.sendFile(fp);
});

app.get('/api/project/:id/videos/:file', (req, res) => {
  const fp = pDir(req.params.id, 'videos', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  if (req.query.download === '1') return res.download(fp);
  res.sendFile(fp);
});

app.get('/api/project/:id/bgm/:file', (req, res) => {
  const fp = pDir(req.params.id, 'bgm', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(fp);
});

app.get('/api/project/:id/final/:file', (req, res) => {
  const fp = pDir(req.params.id, 'final', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.download(fp);
});

// ── YouTube OAuth 인증 URL 발급 ───────────────────────────────────────────────
app.get('/api/youtube/auth-url', (req, res) => {
  try {
    res.json({ url: getAuthUrl() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube OAuth 콜백 (자동 토큰 저장) ──────────────────────────────────────
app.get('/api/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('인증 코드가 없습니다.');
  try {
    const oAuth2 = getOAuthClient();
    const { tokens } = await oAuth2.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:60px">
      <h2 style="color:#4caf50">✅ Google 인증 완료!</h2>
      <p>이 창을 닫고 롱폼 자동화 페이지로 돌아가세요.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (e) {
    res.status(500).send('인증 실패: ' + e.message);
  }
});

// ── YouTube OAuth 코드 교환 → 토큰 저장 ──────────────────────────────────────
app.post('/api/youtube/auth-token', async (req, res) => {
  const { code } = req.body;
  try {
    const oAuth2 = getOAuthClient();
    const { tokens } = await oAuth2.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube 인증 상태 확인 ────────────────────────────────────────────────────
app.get('/api/youtube/status', (req, res) => {
  res.json({ authorized: fs.existsSync(TOKEN_PATH) });
});

// ── YouTube 업로드 ────────────────────────────────────────────────────────────
app.post('/api/project/:id/youtube-upload', async (req, res) => {
  const { id } = req.params;
  const metaPath = pDir(id, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: '프로젝트 없음' });

  const meta     = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const finalDir = pDir(id, 'final');
  const mp4      = fs.readdirSync(finalDir).find(f => f.endsWith('.mp4'));
  if (!mp4) return res.status(400).json({ error: 'MP4 파일이 없습니다. 먼저 렌더링하세요.' });

  const videoPath = path.join(finalDir, mp4);

  try {
    const auth    = await getAuthorizedClient();
    const youtube = google.youtube({ version: 'v3', auth });

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title:       meta.selectedTitle || meta.topic || '유튜브 영상',
          description: meta.description   || '',
          tags:        (meta.hashtags || '').replace(/#/g, '').split(/\s+/).filter(Boolean),
          categoryId:  '22',
        },
        status: { privacyStatus: 'private' },
      },
      media: {
        body: fs.createReadStream(videoPath),
      },
    });

    const videoId  = response.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    meta.youtubeVideoId  = videoId;
    meta.youtubeUrl      = videoUrl;
    meta.uploadedAt      = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    res.json({ ok: true, videoId, videoUrl });
  } catch (e) {
    console.error('[YouTube Upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n롱폼 자동화 v2 — http://localhost:${PORT}\n`);
});
