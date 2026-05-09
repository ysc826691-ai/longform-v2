'use strict';

const fs   = require('fs');
const path = require('path');

const PROJECTS_DIR = path.join(__dirname, 'projects');
const SCRIPTS_DIR  = path.join(__dirname, 'scripts');

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

const safe = (s) => s.replace(/[\\/:*?"<>|\t\n\r]/g, '_').replace(/\s+/g, ' ').trim();

let saved = 0, skipped = 0;

for (const id of fs.readdirSync(PROJECTS_DIR)) {
  const metaPath   = path.join(PROJECTS_DIR, id, 'meta.json');
  const scriptPath = path.join(PROJECTS_DIR, id, 'script.txt');

  if (!fs.existsSync(metaPath) || !fs.existsSync(scriptPath)) { skipped++; continue; }

  const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const script = fs.readFileSync(scriptPath, 'utf8');
  const topic  = meta.topic || '무제';
  const series = meta.seriesName || '';
  const ep     = Number(meta.episode) || 1;

  const name = series
    ? `${safe(series)}_${ep}화_${safe(topic)}.txt`
    : `${safe(topic)}.txt`;

  const dest = path.join(SCRIPTS_DIR, name);

  // 같은 이름이 이미 있으면 날짜 suffix 추가
  const finalDest = fs.existsSync(dest)
    ? dest.replace('.txt', `_${meta.createdAt ? meta.createdAt.slice(0,10) : id.slice(0,8)}.txt`)
    : dest;

  fs.writeFileSync(finalDest, script, 'utf8');
  console.log(`✓ ${path.basename(finalDest)}`);
  saved++;
}

console.log(`\n완료: ${saved}개 저장, ${skipped}개 건너뜀`);
