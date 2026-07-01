# Audio Chunk Upload

מערכת MVP להקלטת אודיו והעלאתה לשרת ב-**chunkים של 30 שניות**, עם מנגנוני
**Retry**, **Resume** ו-**Idempotency** לעמידות רשת גבוהה. הלקוח נכתב ב-Vanilla
TypeScript (ללא framework) והשרת הוא Mock Server מבוסס Node/Express לאימות הפרוטוקול.

## תכולה עיקרית

- **הקלטה מתמשכת** – `MediaRecorder` מייצר chunk כל 30 שניות.
- **תור העלאה מתמיד** – התור נשמר ב-IndexedDB (Blob + מטא-דאטה + checkpoint), כך
  שרענון דף או נפילת רשת אינם מאבדים נתונים.
- **Retry אקספוננציאלי** – backoff `1s, 2s, 4s, 8s, 16s`, עד 7 ניסיונות ל-chunk,
  timeout של 20s לניסיון, ו-circuit breaker אחרי 5 כשלים רצופים.
- **Resume אחרי refresh** – שחזור לפי `sessionId`, פתיחת `segment` חדש והמשך
  העלאה מנקודת ה-checkpoint.
- **Idempotency + Checksum** – כל chunk נושא `idempotencyKey` ו-`sha256`, והשרת
  מאמת סדר ו-checksum לפני ACK.
- **Complete barrier** – סגירת session מתאפשרת רק לאחר ACK לכל ה-chunks.
- **מדיניות אחסון** – soft limit של 150MB (אזהרה) ו-hard limit של 300MB (השהיית
  הרקורדר עד ששחרור מקום).

## מבנה הפרויקט

```
shared/contract.ts       חוזה נתונים משותף בין לקוח לשרת (envelopes, models, policies)
frontend/                לקוח Vanilla TS
  index.html             מעטפת HTML
  src/
    main.ts              חיווט UI <-> שירותים, recovery, complete barrier
    recording-controller.ts  עטיפת MediaStream/MediaRecorder, יצירת chunkים
    upload-queue.ts      תור העלאה מתמיד (IndexedDB)
    chunk-uploader.ts    העלאה עם retry/timeout/idempotency
    api-client.ts        קריאות REST לשרת
    checksum.ts          חישוב sha256
    idb.ts               שכבת IndexedDB
    storage-guard.ts     בקרת מגבלות אחסון מקומי
    state/store.ts       State store קטן מבוסס אירועים
mock-server/src/
  server.ts              Express endpoints (start/resume/checkpoint/chunk/complete)
  session-store.ts       ניהול sessions, checkpoints, ולידציית פרוטוקול
scripts/
  build.ts               בניית dist/index.html יחיד (JS inline)
  dev.ts                 dev runner: לקוח + שרת על אותו origin :3000 (rebuild חי)
tests/                   בדיקות unit + integration (Vitest)
```

## API

| Method | Endpoint | תיאור |
| --- | --- | --- |
| `POST` | `/sessions/start` | יצירת session חדש (status=active) |
| `POST` | `/sessions/{id}/resume` | חידוש session קיים + החזרת checkpoint |
| `GET`  | `/sessions/{id}/checkpoint` | קבלת מצב ה-checkpoint הנוכחי |
| `POST` | `/sessions/{id}/chunks` | העלאת chunk (`multipart`: `meta` JSON + `blob`) |
| `POST` | `/sessions/{id}/complete` | סגירת session + סיכום קבלה |

## דרישות מקדימות

- Node.js 18+ (מומלץ 20+)
- npm

## התקנה

```powershell
npm install
```

## הרצה

### מצב פיתוח

מריץ את הלקוח ואת השרת על אותו origin – `http://localhost:3000`. הלקוח נבנה מחדש
בכל בקשה כך שעריכות מופיעות ברענון, וההגשה מ-`http://localhost` מספקת secure
context הנדרש ל-`getUserMedia`:

```powershell
npm run dev
```

### בנייה + הרצת שרת

```powershell
npm start
```

הפקודה בונה קובץ `dist/index.html` יחיד ומריצה את השרת.

### פקודות נוספות

```powershell
npm run build     # בניית dist/index.html יחיד (ניתן לפתיחה ב-double-click)
npm run server    # הרצת השרת במצב watch
npm run typecheck # בדיקת טיפוסים (tsc --noEmit)
npm test          # הרצת בדיקות (Vitest)
npm run test:watch
```

## בדיקות

הפרויקט כולל בדיקות unit ו-integration המורצות ב-Vitest:

```powershell
npm test
```

- `tests/unit/` – contract, session-store, store, uploader, upload-queue
- `tests/integration/` – זרימת record → upload מלאה

## מגבלות ידועות ומימוש עתידי

- **ריבוי טאבים באותו דפדפן אינו מוגן כרגע.** שני טאבים באותו דפדפן חולקים את אותו
  IndexedDB ואת אותו מפתח session מקומי (`"current"`), ולכן פתיחת שני טאבים
  והקלטה בשניהם במקביל עלולה לגרום להתנגשות (תור העלאה משותף ומצביע session
  שנדרס). הצד-שרת עצמו מבודד היטב שני דפדפנים נפרדים — כל session הוא UUID עם
  רשומה נפרדת — כך ששתי הקלטות במקביל בשני דפדפנים שונים עובדות תקין.
  הגנת "טאב יחיד" (למשל דרך Web Locks API או BroadcastChannel) נותרה **למימוש
  עתידי**.

## הערות

- כשהלקוח מוגש מהשרת (same origin) אין CORS; כשנפתח כקובץ מקומי (`file://`)
  הוא פונה ל-`http://localhost:3000`.
- ניתן לעקוף את כתובת ה-API בעזרת `window.__API_BASE__`.
