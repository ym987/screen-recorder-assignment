## Plan: מערכת הקלטה והעלאת Chunkים

הגישה המומלצת: MVP יציב ב-Vanilla TypeScript עם חלוקה ברורה ל-Recorder, Uploader ו-State Machine, כשכל 30 שניות נוצר chunk ונשלח לשרת עם מנגנון Retry + Resume מקומי. כך מקבלים פשטות מימוש לצד עמידות רשת טובה, בלי להיכנס למורכבות פרודקשן מלאה.

**Steps**
1. Phase 1 - חוזה מערכת וזרימות (Foundation)
1. להגדיר חוזה נתונים אחיד בין לקוח לשרת עם envelope משותף (requestId, serverTime) ו-envelope שגיאה (error.code, error.message, error.retryable).
2. להגדיר Chunk Metadata מלא הנשלח עם כל chunk: sessionId, segmentIndex, chunkIndex, clientTimestamp, startedAt, durationMs, mimeType, sizeBytes, checksumAlgo (sha256), checksum, idempotencyKey (`session:{id}|segment:{s}|chunk:{c}`), blob.
3. להגדיר Session Model (sessionId, status, createdAt, interruptedAt, expiresAt, finalTtlExpiresAt) ו-Checkpoint Model (lastAcceptedSegmentIndex, lastAcceptedChunkIndexBySegment, updatedAt).
4. להגדיר Chunk ACK: accepted, duplicate, lastAcceptedSegmentIndex, lastAcceptedChunkIndexBySegment, serverStoredAt.
5. להגדיר API מינימלי מלא: start session, resume, get checkpoint, upload chunk, complete session.
6. לנסח טבלת מצבים למסך: idle, recording, uploading, paused/retrying, recovered, success, error.
7. לתאר זרימות חובה: happy path, נפילת רשת זמנית, refresh באמצע הקלטה, duplicate chunk, out-of-order chunk, stop בזמן retry.

1. Phase 2 - Frontend Vanilla TS (Core Client)
1. לבנות מודול RecordingController שעוטף MediaStream + MediaRecorder ומייצר chunk כל 30 שניות. תלות: Step 1.
2. לבנות UploadQueue עם תור זיכרון + התמדה ב-IndexedDB (כולל Blob chunks + מטא-דאטה + checkpoint). תלות: Step 1.
3. לממש ChunkUploader עם retry אקספוננציאלי, timeout, idempotency key לכל chunk. תלות: Step 1.
4. לחבר State Store קטן (ללא framework) שמעדכן UI לפי אירועים (record_started, chunk_created, upload_failed, retrying, resumed, completed). parallel with Step 2.3.
5. להוסיף בקרי UI: Start/Stop, סטטוס מילולי, מונה chunkים, חיווי error/warning/success.
6. להגדיר Build למסירה כ-single-file: קובץ dist/index.html יחיד עם JS/CSS inline כדי לעבוד ב-double-click.

1. Phase 3 - Mock Server Node/Express (Protocol Validation)
1. לממש endpoint לקבלת chunk (multipart: meta+blob) עם ולידציה לסדר chunkIndex לפי segmentIndex ו-sessionId, ואימות checksum (sha256) לפני ACK.
2. לשמור chunks בתיקיית session עם manifest.json ולשמור checkpoint.json לשחזור.
3. לטפל ב-idempotency: אם chunk קיים כבר, להחזיר ACK עם duplicate:true בלי יצירה כפולה.
4. לממש complete endpoint שסוגר session ומחזיר סיכום (receivedSegments, receivedChunksTotal, missingChunks).
5. להחזיר error codes עקביים עם retryable בהתאם לטבלת Server Error Codes.

1. Phase 4 - Reliability: Retry + Resume
1. בעת כשל רשת, להעביר UI למצב retrying ולהמשיך תזמון ניסיונות לפי backoff.
2. בעת טעינת דף מחדש, להריץ recovery flow: קריאת checkpoint מהשרת/מקומי, השוואת chunkIndex אחרון, והמשך העלאה מהנקודה הנכונה עבור chunks שכבר קיימים מקומית.
3. להגדיר גבולות: max retries לכל chunk, circuit-breaker קצר, הודעת שגיאה ידידותית כשנכשל סופית.
4. להגדיר מודל segments: אחרי refresh לא ממשיכים MediaRecorder קודם; פותחים הקלטה חדשה תחת אותו sessionId עם segmentIndex חדש.
5. לוודא שהשרת שומר segmentIndex, ובאיחוד סופי ממזג לפי sessionId -> segmentIndex -> chunkIndex.
6. טיפול WebM merge (MVP-safe): לשמור קבצים per-segment + manifest.json; לסמן complete לפי סט chunks מאומת ולא לפי merge מיידי; להריץ remux אסינכרוני לפלט single-file; בכשל remux להשאיר session כ-`completed_with_segments`, לחשוף רשימת segments להורדה/נגינה, ולהוסיף רשומת remediation ל-log.
7. Flush של הקלטה פעילה לפני refresh/סגירה: ה-`MediaRecorder` פולט chunk רק כל 30 שניות, ולכן השמע שנצבר מאז גבול ה-chunk האחרון (עד ~30 שניות) אינו נשלח בעת רענון/סגירת טאב. הפתרון: לחשוף `flush()` ב-RecordingController שקורא ל-`recorder.requestData()` כדי לפלוט מיד את השמע המאוגר כ-chunk, ולהתמיד אותו ב-IndexedDB (best-effort). בעלייה הבאה ה-recovery flow ישלים את העלאתו.
8. חיבור ל-lifecycle של הדף ב-`main.ts`: בעת `visibilitychange` ל-hidden וב-`pagehide` בזמן הקלטה פעילה — לקרוא ל-`recorder.flush()` כדי להתמיד את הזנב האחרון לפני שהדפדפן משמיד את הדף. הסתמכות על `visibilitychange`/`pagehide` (ולא על unload) נותנת ל-IndexedDB את הסיכוי הטוב ביותר לסיים כתיבה.
9. הגנה מפני סגירה בטעות: בעת `beforeunload` בזמן הקלטה פעילה, להציג את אישור העזיבה המובנה של הדפדפן (`preventDefault` + `returnValue`) כדי שרענון/סגירה מקריים לא יאבדו שמע לא-שמור.
10. הבהרה על מגבלה: ה-flush הוא best-effort. chunkים שלמים שכבר הותמדו ל-IndexedDB תמיד שורדים ומועלים ב-resume; רק הזנב החלקי תלוי בהצלחת ה-flush לפני ההשמדה.

**Session Continuity (זהות שיחה והמשכיות)**
1. לא להניח שהדף יציב; זהות שיחה תיקבע לפי sessionId מפורש ולא לפי מצב הדפדפן.
2. לחיצה על Start תיצור שיחה חדשה רק אם אין session פעיל או אם session קודם הושלם/פג תוקף.
3. אם קיימת שיחה במצב active או interrupted, יש לבצע Resume לאותה שיחה עם אותו sessionId.
4. במקרה refresh בזמן הקלטה: ממשיכים את אותה שיחה לוגית, אך ההקלטה עצמה עוברת ל-segment חדש.
5. לחיצה על Stop עם אישור מהשרת תסמן את השיחה completed; הלחיצה הבאה על Start תיצור session חדש.
6. אחרי refresh, מוצג ללקוח כפתור "שיחה חדשה" שמאפשר לזנוח את השיחה המשוחזרת ולפתוח שיחה חדשה מיד — בלי להתחיל הקלטה ובלי לבצע complete. הכפתור זמין רק במצב recovered ומנוטרל בזמן הקלטה פעילה.
7. להגדיר TTL כפול: timeout קצר לסימון interrupted (למשל 2-5 דקות), ו-TTL סופי ליכולת Resume (למשל 30-60 דקות).
8. אחרי פקיעת TTL סופי, כל Start חדש חייב לפתוח session חדש.
9. השרת ישמור מצב שיחה: active, interrupted, completed, expired.
10. הלקוח ישמור מקומית sessionId, segmentIndex ו-lastChunkIndex, ובעלייה מחדש יבצע reconcile מול השרת לפני המשך upload.
11. כל chunk יישלח עם sessionId, segmentIndex, chunkIndex, clientTimestamp, ו-idempotencyKey למניעת כפילויות.

**API Additions for Session Continuity**
1. POST /sessions/start - יצירת session חדש (clientId, mimePreference[]) ומחזיר Session Model עם status=active (201).
2. POST /sessions/{sessionId}/resume - מקבל lastKnownSegmentIndex + lastKnownChunkIndexBySegment, מחזיר session + checkpoint + resumable (200).
3. GET /sessions/{sessionId}/checkpoint - מחזיר Checkpoint Model (lastAcceptedSegmentIndex, lastAcceptedChunkIndexBySegment, status) (200).
4. POST /sessions/{sessionId}/chunks - multipart/form-data עם `meta` (JSON) + `blob` (binary), מחזיר Chunk ACK (200).
5. POST /sessions/{sessionId}/complete - מקבל expectedLastSegmentIndex + expectedLastChunkIndexBySegment + idempotencyKey, מחזיר סיכום (status, receivedSegments, receivedChunksTotal, missingChunks) (200).

**Protocol Rules (Fixed)**
1. Ordering: השרת מקבל רק `chunkIndex = lastAccepted + 1` לכל segmentIndex; duplicate (אותו idempotencyKey) מחזיר 200 עם duplicate:true; out-of-order מחזיר 409 OUT_OF_ORDER_CHUNK (retryable).
2. Idempotency: מפתח ייחודי `sessionId + segmentIndex + chunkIndex`; ל-complete מפתח idempotency נפרד.
3. Checksum: אלגוריתם חובה sha256; השרת מאמת checksum לפני ACK.

**Retry / Resume / State Policy (Fixed)**
1. Retry: backoff `1s, 2s, 4s, 8s, 16s` (max 16s), max 7 ניסיונות ל-chunk, timeout 20s לכל ניסיון.
2. Circuit breaker: 5 chunks רצופים שנכשלו סופית -> state=error והקלטה מושהית.
3. Resume אחרי refresh: אותו sessionId, segmentIndex חדש = lastAcceptedSegmentIndex + 1, reconcile של התור המקומי מול checkpoint לפני המשך upload.
4. Complete barrier (חוקה קשיחה): complete חסום כל עוד יש פריט pending בתור; complete רק אחרי ACK לכל ה-chunks המקומיים.

**Local Storage Limits (IndexedDB)**
1. Soft limit: 150MB -> באנר אזהרה.
2. Hard limit: 300MB או 20% מה-quota האפקטיבי (הנמוך מביניהם).
3. ב-hard limit: השהיית הרקורדר תוך שמירה על ה-uploader פעיל עד שהשימוש יורד.

**Deletion / Retention Policy (Fixed)**
1. ב-ACK חיובי: מחיקת blob מיידית מ-IndexedDB, שמירת tombstone קטן (sessionId, segmentIndex, chunkIndex, ackedAt) ל-30 דקות.
2. בכשל סופי (אחרי max retries): סימון chunk כ-permanent_failed ושמירתו ל-retry ידני/ניקוי אוטומטי.
3. ב-complete מוצלח: הסרת כל ה-chunks והמטא-דאטה של השיחה.
4. בפקיעה: cleaner ברקע מסיר sessions + blobs שפגו.

**Minimal Telemetry**
- counters/timers: chunks_created_total, chunks_uploaded_ok_total, chunks_duplicate_total, chunks_failed_total, retry_attempts_total, time_to_recover_ms, complete_blocked_total.

**Server Error Codes**
- SESSION_NOT_FOUND -> 404 (retryable false)
- SESSION_EXPIRED -> 410 (retryable false)
- SESSION_NOT_RESUMABLE -> 409 (retryable false)
- OUT_OF_ORDER_CHUNK -> 409 (retryable true)
- CHECKSUM_MISMATCH -> 422 (retryable true)
- PAYLOAD_TOO_LARGE -> 413 (retryable false)
- RATE_LIMITED -> 429 (retryable true)
- INTERNAL_UPLOAD_ERROR -> 500 (retryable true)

1. Phase 5 - Testing & Hardening
1. בדיקות יחידה ל-state machine, retry policy, ומנגנון merge של checkpoint.
2. בדיקות אינטגרציה לקוח-שרת: רצף תקין, ניתוק רשת, duplicate, out-of-order, refresh באמצע.
3. בדיקת דפדפנים רלוונטיים (לפחות Chrome + Edge) לווידוא MediaRecorder MIME בפועל.
4. תרחיש קצה: stop מיד אחרי יצירת chunk, וידוא flush אחרון לפני complete.
5. להוסיף Complete Barrier Test: complete נחסם עד שכל ה-chunks בתור קיבלו ACK; אין complete במקביל ל-upload האחרון.
6. להוסיף בדיקת double-click ל-dist/index.html כדי לוודא הרצה תקינה ללא שרת סטטי.

1. Phase 6 - הרצה מקומית ומגבלת file:// (Local Run & Origin Fix)

**תיאור הבעיה (Root Cause)**
1. פתיחת `dist/index.html` בדאבל-קליק טוענת את הדף תחת פרוטוקול `file://`, שהוא origin ייחודי/opaque. לכן `fetch("http://localhost:3000/...")` נחסם ע"י הדפדפן (`Unsafe attempt to load URL ... 'file:' URLs are treated as unique security origins`).
2. `getUserMedia` ו-`MediaRecorder` דורשים secure context; `file://` אינו נחשב secure באופן עקבי, ולכן גם התחלת ההקלטה עלולה להיכשל ("כשל בתחילת הקלטה").
3. באג משני: `fetch` מועבר כברירת מחדל ונשמר כ-`this.fetchImpl` ואז נקרא כמתודה, כך שהוא מאבד את הקישור ל-`window` וזורק `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`.

**Steps**
1. תיקון קישור fetch: לעטוף את ברירת המחדל של `fetch` ב-wrapper שמקבע את ה-this. תלות: אין.
   - ב-`frontend/src/api-client.ts` וב-`frontend/src/chunk-uploader.ts` להחליף `fetchImpl: FetchLike = fetch` ל-`fetchImpl: FetchLike = (...args) => fetch(...args)` (או `fetch.bind(globalThis)`).
2. הגשת הפרונט מאותו origin של ה-API (הפתרון המומלץ): שהשרת יגיש את `dist/index.html` כסטטי תחת `http://localhost:3000`, כך שהפרונט וה-API חולקים origin זהה. תלות: Phase 3.
   - ב-`mock-server/src/server.ts` להוסיף `app.use(express.static(distDir))` שמגיש את תיקיית `dist`.
   - כך אין CORS, וההקשר הוא secure context תקין ל-`getUserMedia`.
3. Base URL יחסי כשמאותו origin: כאשר `location.protocol` הוא `http:`/`https:`, לגזור `BASE_URL` מ-`window.location.origin` במקום להצמיד ל-`http://localhost:3000`. תלות: Step 2.
   - ב-`frontend/src/main.ts` לעדכן את `BASE_URL` לזהות origin נוכחי ולהשתמש בנתיבים יחסיים.
4. סקריפט הרצה בפקודה אחת: להוסיף `npm start` שבונה את ה-dist, מפעיל את השרת שמגיש גם סטטי, ופותח דפדפן על `http://localhost:3000`. תלות: Steps 2-3.
   - להוסיף ל-`package.json` script (למשל `"start": "npm run build && node --loader ... mock-server/src/server.ts"`), ולוודא ש-`scripts/dev.ts` מתיישר עם אותו זרימה.
5. Fallback ידידותי ל-file:// טהור: אם `location.protocol === "file:"`, להציג באנר ברור ("יש להריץ `npm start` ולגשת ל-http://localhost:3000") ולנטרל את כפתור Start במקום כשל טכני. תלות: Step 1.
   - להוסיף בדיקת פרוטוקול ב-`frontend/src/main.ts` לפני אתחול ה-controllers.
6. עדכון תיעוד המסירה: להבהיר שהאספקה היא single-file `dist/index.html` המוגש דרך שרת מקומי קל (`npm start`), ולא דאבל-קליק ישיר, בגלל מגבלות אבטחה של הדפדפן. תלות: Steps 2-5.

**Decisions (Local Run)**
- הפתרון הראשי: same-origin — השרת המקומי מגיש גם את הפרונט וגם את ה-API על `http://localhost:3000`, מבטל CORS ומספק secure context.
- שומרים על ה-artifact ה-single-file, אך ההרצה הנתמכת היא דרך `npm start` (localhost), לא `file://`.
- Fallback ל-file:// מציג הנחיה ידידותית במקום להיכשל בשקט; ההקלטה מושבתת עד שרצים דרך localhost.
- מתקנים את קישור ה-`fetch` כדי למנוע `Illegal invocation` בכל סביבת הרצה.

**הבהרה / הנחת יסוד (Port 3000)**
- יצאנו מנקודת הנחה שפורט `3000` יהיה פנוי בזמן ההרצה, ולא מימשנו מנגנון fallback לפורט חלופי אם הוא תפוס.
- אם `3000` תפוס, השרת ייכשל בעליית ה-listen; אין כרגע בחירת פורט אוטומטית, קונפיגורציה דינמית או retry על פורט אחר.
- שיפור עתידי אפשרי: לקרוא פורט מ-`process.env.PORT` / ארגומנט CLI, או לחפש פורט פנוי אוטומטית ולעדכן את כתובת הפתיחה בדפדפן בהתאם.

**Verification (Local Run)**
1. להריץ `npm start`, לפתוח `http://localhost:3000`, ולוודא שאין שגיאות origin/CORS בקונסול.
2. ללחוץ Start ולוודא ש-`getUserMedia` עובד וההקלטה מתחילה ללא "כשל בתחילת הקלטה".
3. לוודא ש-chunk נשלח ומתקבל ACK ללא `Illegal invocation`.
4. לפתוח את `dist/index.html` בדאבל-קליק ולוודא שמוצג הבאנר עם הנחיה ל-localhost במקום כשל טכני.

**Relevant files**
- /frontend/src/recording-controller.ts - עטיפת MediaRecorder, timers, events
- /frontend/src/upload-queue.ts - ניהול תור, persistence, dequeue policy
- /frontend/src/chunk-uploader.ts - HTTP client, retry/backoff, idempotency
- /frontend/src/state/store.ts - state machine ופעולות UI
- /frontend/src/main.ts - חיבור בין UI ל-services
- /mock-server/src/server.ts - endpoints וולידציה
- /mock-server/src/session-store.ts - שמירת chunks/checkpoints
- /tests/integration/record-upload.spec.ts - תרחישי end-to-end בסיסיים

**Verification**
1. להריץ mock server ולוודא שהוא מחזיר session + chunk ACK עקביים.
2. להריץ את הלקוח, להקליט 2-3 מחזורים של 30 שניות, ולוודא שכל chunk מתקבל בסדר.
3. לנתק רשת בזמן upload, לבדוק retry אוטומטי וחזרה אוטומטית להצלחה.
4. לרענן דף באמצע הקלטה/העלאה, לוודא resume מנקודת checkpoint.
5. להריץ suite אוטומטית לבדיקות יחידה ואינטגרציה לפני סגירה.

**Decisions**
- Include: Vanilla TypeScript בלבד, chunk interval של 30 שניות, MVP עם Retry/Resume.
- Exclude כרגע: auth מתקדם, הצפנה מקצה לקצה, סקייל אופקי אמיתי, observability מלא לפרודקשן.
- transport: HTTP POST לכל chunk (החלטה סופית ל-MVP) בגלל פשטות דיבוג, idempotency, ו-retry.
- session lifecycle: resume לאותה שיחה לפי sessionId כשיש active/interrupted; שיחה חדשה רק ב-Start ללא session תקף, אחרי compleמה te, או אחרי TTL סופי.
- refresh handling: אחרי refresh ממשיכים אותה שיחה לוגית עם sessionId קיים, אך פותחים segment חדש בהקלטה.
- persistence: IndexedDB בלבד לשמירת Blob chunks + metadata; לא משתמשים ב-localStorage לשמירת תוכן בינארי.
- completion rule: שולחים POST /complete רק אחרי flush מלא ו-ACK לכל chunks (barrier קשיח).
- checksum: sha256 חובה לכל chunk, אימות בצד השרת לפני ACK.
- retry policy: backoff 1/2/4/8/16s, max 7 ניסיונות, timeout 20s; circuit-breaker אחרי 5 כשלונות רצופים.
- storage limits: soft 150MB, hard 300MB או 20% quota (הנמוך); ב-hard limit משהים רקורדר וממשיכים uploader.
- retention: מחיקת blob ב-ACK + tombstone ל-30 דקות; permanent_failed נשמר ל-retry ידני.
- remux: single-file מופק ב-remux אסינכרוני; בכשל נשארים עם completed_with_segments.
- delivery requirement: מפיקים dist/index.html כ-single-file עם JS/CSS inline כדי לאפשר הרצה ב-double-click.

**Further Considerations**
1. פורמט שמע: להעדיף webm/opus כברירת מחדל, עם fallback לפי תמיכת דפדפן.
2. אם בעתיד נדרש latency נמוך במיוחד, ניתן לשקול WebSocket כשלב מתקדם אחרי MVP.

**מגבלה ידועה — ריבוי טאבים באותו דפדפן (מימוש עתידי)**
- כרגע **אין הגנה מפני פתיחת שני טאבים באותו דפדפן במקביל**. שני טאבים חולקים את אותו IndexedDB (`DB_NAME`) ואת אותו מפתח session מקומי (`"current"`), ולכן הם עלולים לדרוס זה את זה: תור העלאה משותף, ומצביע session שנדרס.
- הצד-שרת מבודד היטב שני דפדפנים נפרדים (כל session הוא UUID עם רשומה נפרדת), כך ששתי הקלטות במקביל בשני דפדפנים שונים עובדות ללא התנגשות (מכוסה בבדיקת אינטגרציה).
- שיפור עתידי אפשרי: נעילת "טאב יחיד" באמצעות Web Locks API או BroadcastChannel/leader-election, שתמנע התחלת הקלטה בטאב שני כל עוד טאב פעיל אחר קיים.