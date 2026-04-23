# Online Learning Platform — Demo MVP

Session-based teaching platform with browser screen+audio recording and later playback.

แผนสถาปัตยกรรม + roadmap ฉบับเต็ม: **[TECHNICAL-PLAN.md](./TECHNICAL-PLAN.md)**

---

## โครงสร้างโปรเจกต์

```
online-education/
├── TECHNICAL-PLAN.md       # เอกสารวางแผน 12 หัวข้อ
├── docker-compose.yml      # postgres + redis + minio (S3-compatible)
├── backend/                # Node.js + Express + Prisma + BullMQ + FFmpeg
└── frontend/               # Next.js 14 (App Router) + Tailwind
```

---

## Prerequisites

| Tool            | ใช้ทำอะไร                                 |
|-----------------|--------------------------------------------|
| Node.js ≥ 20    | รัน backend + frontend                     |
| pnpm            | package manager                            |
| Docker Desktop  | รัน Postgres + Redis + MinIO               |

ติดตั้ง pnpm ถ้ายังไม่มี:
```bash
npm install -g pnpm
```

---

## วิธี run (ครั้งแรก)

### 1. Start infra — Postgres, Redis, MinIO

เปิด Docker Desktop ให้ running ก่อน แล้ว:

```bash
cd "/Users/jiraphonieotrakoon/iCloud Drive (Archive) - 3/Documents/AllWebProject/online-education"
docker compose up -d
docker compose ps
```

ควรเห็น 3 services (postgres, redis, minio) สถานะ `running` — พร้อมกับ `minio-init` ที่สร้าง bucket `olp-recordings` เสร็จแล้ว exit

**หน้า console ที่ใช้เช็ค:**
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)
- Postgres: `localhost:5432` (user `olp`, pw `olp`, db `olp`)
- Redis: `localhost:6379`

### 2. Setup backend

```bash
cd backend
cp .env.example .env
pnpm install
pnpm prisma generate
pnpm prisma migrate dev --name init   # สร้าง schema ใน Postgres
pnpm seed                              # ใส่ demo users + courses + sessions
```

### 3. Setup frontend

```bash
cd ../frontend
cp .env.example .env.local
pnpm install
```

---

## ⚠️ ถ้าเคย setup ไปแล้ว — ต้อง run migration เพิ่ม

schema เปลี่ยนหลายรอบ (thumbnail+chapters, progress, questions, chat, **joinCode, visibility, chat attachments, transcript**). รันครั้งเดียวก็พอ:

```bash
cd backend
pnpm install
pnpm prisma migrate dev --name add-join-code-visibility-attachments-transcript
pnpm seed   # สร้าง joinCode ให้ course ที่ seed ไว้

cd ../frontend
pnpm install
```

## Optional: Whisper transcription (audio → text)

Pipeline: `recording.mp4` → extract audio (64kbps mono mp3) → `POST /audio/transcriptions` → transcript + timestamps → เก็บเข้า DB

ใช้ provider ไหนก็ได้ที่พูด OpenAI-compat ASR format เลือกได้ 3 แบบ:

### แบบ A — Groq ⭐ (แนะนำ: เร็วสุด, free tier 8 ชม./วัน)

```bash
# backend/.env
WHISPER_API_KEY=gsk_...                        # จาก console.groq.com
WHISPER_API_BASE_URL=https://api.groq.com/openai/v1
WHISPER_MODEL=whisper-large-v3
```

### แบบ B — Self-hosted (ฟรี, offline, ไม่ส่ง audio ออกนอก)

```bash
# 1. Start local whisper container
docker compose --profile whisper up -d
# รอ 1-2 นาทีครั้งแรก (download model ~500MB–3GB)

# 2. backend/.env
WHISPER_API_KEY=any-non-empty-string           # server ไม่เช็ค
WHISPER_API_BASE_URL=http://localhost:8000/v1  # http://whisper:8000/v1 ใน docker
WHISPER_MODEL=Systran/faster-whisper-small
WHISPER_MAX_UPLOAD_MB=500                      # lift cap สำหรับ local
```

Model size แลกกับ RAM/quality:

| Model | RAM | Speed (CPU) | Quality |
|---|---|---|---|
| `faster-whisper-tiny` | ~0.5 GB | เร็วสุด | ใช้ได้ |
| `faster-whisper-small` | ~1 GB | สมดุล | ดี |
| `faster-whisper-medium` | ~2.5 GB | ช้า | ดีมาก |
| `faster-whisper-large-v3` | ~5 GB | ช้ามาก CPU | ดีสุด |

มี GPU → เปลี่ยน image เป็น `fedirz/faster-whisper-server:latest-cuda`

### แบบ C — ปิดทิ้ง

เว้น `WHISPER_API_KEY=` ว่างไว้ — recording ยังทำงาน แค่ไม่มี transcript/search

---

## Optional: LLM post-processing (summary + auto-chapters)

หลัง transcript เสร็จ worker เรียก LLM ต่อเพื่อ:
1. **สรุป lecture** 2–3 ประโยค → แสดงข้างบน video
2. **Auto-chapter** ถ้าครูไม่ได้ mark เอง → badge "AI-generated"

ใช้ provider ไหนก็ได้ที่พูด `/v1/chat/completions`:

```bash
# Groq (ฟรี, เร็ว)
LLM_API_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_...                            # key เดียวกับ Whisper ได้
LLM_MODEL=llama-3.3-70b-versatile

# หรือ Ollama Cloud (Gemma)
LLM_API_URL=https://ollama.com/v1
LLM_API_KEY=ollama_...
LLM_MODEL=gemma3:27b-cloud

# หรือ Ollama local
LLM_API_URL=http://localhost:11434/v1
LLM_MODEL=gemma3:4b

# หรือ Typhoon (ภาษาไทย)
LLM_API_URL=https://api.opentyphoon.ai/v1
LLM_API_KEY=typhoon_...
LLM_MODEL=typhoon-v2-70b-instruct
```

**Single-provider shortcut**: ถ้า `LLM_API_URL` ว่าง → fallback ไปใช้ `WHISPER_API_BASE_URL` + `WHISPER_API_KEY` ทำให้ 1 key (เช่น Groq) คลุมทั้ง Whisper + LLM

**⚠️ ข้อจำกัด**: summary + auto-chapters ต้องการ transcript — ถ้า Whisper ไม่ได้ตั้ง → LLM ก็ไม่มี input ให้ทำงาน

### ตารางสรุป

| Setup | Whisper | LLM | ค่าใช้จ่าย | Note |
|---|---|---|---|---|
| **Groq ตัวเดียว** | Groq | Groq | ฟรี tier 8 ชม./วัน | 1 key, เร็วมาก |
| **Groq Whisper + Ollama LLM** | Groq | Ollama Cloud/local | ฟรี | แยก provider |
| **Local ทั้งหมด** | faster-whisper | Ollama local | $0 | offline, ต้อง self-host 2 services |
| **ปิดทั้งคู่** | — | — | $0 | ไม่มี transcript/search/summary |

## รันระบบในแต่ละวัน (ต้องเปิด 3 terminal)

เปิด Docker Desktop → `docker compose up -d` → แล้วเปิด 3 terminal:

**Terminal 1 — API**
```bash
cd backend
pnpm dev
# [api] listening on http://localhost:4000
```

**Terminal 2 — Worker (FFmpeg processing)**
```bash
cd backend
pnpm worker
# [worker] ready
```

**Terminal 3 — Frontend**
```bash
cd frontend
pnpm dev
# http://localhost:3000
```

เปิด http://localhost:3000 แล้วคลิก persona เพื่อ login แบบ 1 click

---

## Demo personas (seed password: `demo1234` ทุกคน)

| Email              | Role ใน ENG-101 | Note                        |
|--------------------|-----------------|-----------------------------|
| priya@acme.edu     | TEACHER (owner) | สอน ENG-101 + PM-305        |
| marcus@acme.edu    | —               | สอน DS-220                  |
| jae@corp.com       | STUDENT         | เรียน ENG-101 + DS-220      |
| lena@corp.com      | STUDENT         | เรียน ENG-101 + PM-305      |
| omar@corp.com      | STUDENT         | เรียน ENG-101               |
| tess@corp.com      | STUDENT         | เรียน ENG-101               |

---

## Demo flow แนะนำ

1. Login เป็น **Priya** → `/dashboard` → คลิกเข้าคอร์ส ENG-101
2. กด **Start recording** ที่ session ไหนก็ได้ → เลือก screen + อนุญาต mic
3. พูดสัก 30 วินาที → กด **Stop recording** → status จะเป็น `processing…`
4. รอ worker transcode เสร็จ (ปกติ 5–30 วิ สำหรับคลิปสั้นๆ) → status เป็น `ready`
5. เปิด incognito window อีกอัน → login เป็น **Jae-won** → เปิด session เดียวกัน → กด play

---

## เช็คว่า API ขึ้นจริง

```bash
curl http://localhost:4000/health
# {"ok":true}

curl -X POST http://localhost:4000/api/v1/auth/demo/switch \
  -H 'Content-Type: application/json' \
  -d '{"email":"priya@acme.edu"}'
# {"token":"...","user":{...}}
```

---

## Commands cheat sheet

รันจาก root เลย (มี workspace script ใน root `package.json`):

| Command                     | ทำอะไร                              |
|-----------------------------|--------------------------------------|
| `pnpm infra:up`             | Start Postgres/Redis/MinIO          |
| `pnpm infra:down`           | Stop infra                           |
| `pnpm infra:reset`          | Stop + ลบ volume + start ใหม่ (reset ทั้งหมด) |
| `pnpm backend:dev`          | Start API server                     |
| `pnpm backend:worker`       | Start FFmpeg worker                  |
| `pnpm backend:seed`         | Re-seed demo data                    |
| `pnpm backend:migrate`      | Run Prisma migrations                |
| `pnpm backend:studio`       | เปิด Prisma Studio (DB viewer)       |
| `pnpm frontend:dev`         | Start Next.js                        |
| `pnpm setup`                | install + migrate + seed (one-shot)  |

---

## Troubleshooting

| ปัญหา                                                | วิธีแก้                                                                 |
|------------------------------------------------------|--------------------------------------------------------------------------|
| `docker: command not found`                          | เปิด Docker Desktop; `brew install --cask docker` ถ้ายังไม่มี           |
| Prisma: `Can't reach database server at localhost:5432` | `docker compose ps` เช็ค postgres; `lsof -i :5432` เช็ค port ชนกันมั้ย |
| Worker log `ffmpeg: not found`                       | `pnpm install` ใหม่ใน `backend/` — `ffmpeg-static` จะโหลด binary มาให้  |
| MinIO bucket missing                                 | http://localhost:9001 → login → สร้าง bucket `olp-recordings` เอง        |
| Recording UI ขอ permission ไม่ขึ้น                   | ใช้ Chrome/Edge; Safari ยังไม่ support ใน MVP (ดู Known limits ด้านล่าง) |
| `CORS` error ที่ browser                             | เช็ค `CORS_ORIGIN=http://localhost:3000` ใน `backend/.env`              |
| หลัง login แล้วเด้งกลับ `/login`                     | cookie ถูก block — เปิด browser ธรรมดา (ไม่ incognito เข้มๆ) หรือใช้ Chrome |

---

## Deploy architecture (single-origin, ไม่มี cross-domain cookie)

```
                  ┌──────────────────────────────┐
Browser ───────►  │ Next.js (port 3000)          │
 cookies          │  /                → Next SSR │
 same-origin      │  /api/*           → BACKEND  │ (rewrite)
                  │  /socket.io/*     → BACKEND  │ (rewrite + WS upgrade)
                  └──────────────┬───────────────┘
                                 │ BACKEND_URL
                                 │ (internal only)
                                 ▼
                  ┌──────────────────────────────┐
                  │ Express API + Socket.IO      │
                  │ (port 4000)                  │
                  └──────────────────────────────┘
```

Browser พูดคุยกับ Next.js origin อย่างเดียว:
- **Cookies** = first-party → `SameSite=lax` ก็พอ ไม่ต้อง `SameSite=none; Secure` + CORS
- **CORS** ไม่เกี่ยวเพราะ same-origin
- **WebSocket** Next 14 self-hosted proxy WS upgrade ได้ ไม่ต้อง configure อะไร

Env ที่ต้องตั้ง:

| Var | Scope | ใส่อะไร |
|---|---|---|
| `BACKEND_URL` | Next server | internal URL ของ API เช่น `http://api:4000` ใน docker, หรือ `http://localhost:4000` ใน dev |
| `NEXT_PUBLIC_API_BASE` | **build-time** | `/api/v1` (relative) — bake เข้า bundle |
| `COOKIE_SECURE` | backend | `true` เมื่อ serve ผ่าน HTTPS |
| `COOKIE_SAMESITE` | backend | `lax` (default) |
| `JWT_SECRET` | backend | random string ยาวๆ |

### Deploy ด้วย Docker Compose

```bash
# 1. Build + start ทุก service (รวม api, worker, web + infra)
JWT_SECRET='your-long-prod-secret' \
COOKIE_SECURE=true \
docker compose --profile app up -d --build

# 2. Migration ครั้งแรก
docker compose exec api npx prisma migrate deploy
docker compose exec api npx tsx prisma/seed.ts   # optional

# 3. เปิด http://localhost:3000 — ไม่ต้องเข้า :4000 จาก browser อีกเลย
```

Prod tip: ลบบรรทัด `ports: ["4000:4000"]` ออกจาก `api` service ใน `docker-compose.yml` เพื่อปิด API ไม่ให้ expose ตรงสู่อินเทอร์เน็ต (browser จะวิ่งผ่าน Next.js proxy อย่างเดียว)

### Deploy หลัง reverse proxy (nginx/caddy)

ถ้าอยากมี reverse proxy เพิ่มด้านหน้า (terminate TLS, rate limit, etc.):

```nginx
# nginx.conf — one domain, both services
server {
  server_name app.example.com;
  listen 443 ssl http2;
  # ssl_* directives...

  location / {
    proxy_pass http://web:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # WS through Next
    proxy_set_header Connection "upgrade";
  }
}
```

Next.js เป็นคนทำ rewrite `/api` + `/socket.io` ต่อไปข้างหลัง — nginx ไม่ต้องแตะ API โดยตรง

## Tests

Smoke tests (vitest + supertest) ที่ทดสอบ auth + course CRUD + permission:

```bash
docker compose up -d   # infra ต้องขึ้นก่อน
pnpm backend:seed       # seed data
cd backend && pnpm test
```

## Live classroom (ใหม่)

ตอนนี้ระบบรองรับ live classroom แล้ว:
- ครูกด Start recording → record ไปด้วย + stream ไปที่นักเรียนพร้อมกัน (WebRTC mesh + Socket.io signaling)
- นักเรียนเปิด session ขณะ LIVE → เห็นวิดีโอ + chat + ถามคำถาม real-time
- นักเรียนกด **✋ Raise hand** → ครู Accept → browser ขอ cam+mic → นักเรียน publish กลับไปที่ครู
- คำถามค้างไว้ถามทีหลังก็ได้ (archive questions ใน session page)

**Scale limit ของ MVP demo**: mesh WebRTC โอเคสำหรับ 1 teacher + ≤ 8 students; ถ้าห้องเรียนใหญ่กว่านี้ต้อง SFU (เช่น LiveKit/mediasoup) แทน

## Known MVP limits (จงใจ defer)

- **Chrome/Edge only** สำหรับ recording (WebM/VP8+Opus) — Safari คือ Phase 2
- **Chapters บน playback page เป็น placeholder** — auto-chapter detection คือ Phase 2
- **ไม่มี email notification** — worker log ว่า "would notify" เฉยๆ
- **Live class mesh** — demo scale เท่านั้น; ต้อง SFU สำหรับ > 8 students

ดู [TECHNICAL-PLAN.md §1 & §12](./TECHNICAL-PLAN.md) สำหรับ exclusion list + risk table แบบเต็ม
