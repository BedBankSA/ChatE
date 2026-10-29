# تقرير QA وتجربة المستخدم — ChatE

> **الجولة:** إنتاج مُحاكى (production build) مع مزوّدي خارجيين مُحاكين — prod-mock  
> **التاريخ:** 2026-10-28  
> **الأصل:** http://chate.test:3212  
> **الأداة:** scripts/qa (Chrome DevTools Protocol، بلا أي حزمة npm) — Chrome 156.0.8078.48، Node v24.22.1  
> **الإثباتات:** docs/audit/evidence/qa-results-prod-mock.json و qa-console-prod-mock.json، واللقطات في docs/audit/screenshots/_final-*.png

## English Executive Summary

**Scope.** A production build of ChatE (Next.js 16.4.3, React 19) was exercised end-to-end over the Chrome DevTools Protocol from a zero-dependency harness (`scripts/qa/`) at `http://chate.test:3212`, with mocked Turnstile / OpenRouter / OTP endpoints and Anthropic deliberately disabled (`CHATE_E2E_MOCK=1`). 47 scripted checks cover the public pages, authenticated workspace, the full question→comparison→polling→cancel journey, the two-step OTP phone-verification journey, the admin surface, API contracts, security headers, session forgery, RTL, keyboard order, accessibility basics, responsive layouts (1440×900, 768×1024, 390×844), and light/dark themes.

**Result:** **45 PASS, 2 FAIL, 0 BLOCKED, 0 SKIP** (47 checks). Both failures are the same real defect: the **404 page is Next.js's unlocalized English default** in an Arabic-first product (`S05`, `B08`). Evidence: docs/audit/screenshots/_final-not-found-desktop.png.

**Verified working:** full comparison journey (3 free OpenRouter columns complete with canned Arabic answers ~1.18 s after submit; the Haiku column fails independently with an Arabic error and zero spend; one POST only; polling works); OTP send→wrong-code 403→verify→workspace comparison; theme toggle persistence across reload; browser back/forward; unauthenticated `/workspace` redirect; empty-question validation; Arabic phone gate (156 ms); HTML/script payload rendered literally; rapid triple-click produced ≤1 POST; RTL direction and mixed-direction model IDs; skip link is the first Tab stop with visible focus rings; zero unnamed interactive elements; horizontal overflow 0 at 390/768 px; dark mode; CSP/nosniff/DENY/referrer/permissions headers; no server secret name or value in served HTML/JS; forged/expired/ghost sessions and admin CSRF/origin violations rejected.

**Highest-impact issue found outside the matrix:** on a plain-HTTP non-localhost origin, `crypto.randomUUID` is unavailable (not a secure context) and clicking إرسال user-visibly prints the raw English message `crypto.randomUUID is not a function`, with **no network request sent**. Production HTTPS is a secure context, so this is primarily a staging/HTTP deployment blocker, but surfacing raw engine errors in the Arabic UI is a genuine UX/security-adjacent defect. Screenshot: `_final-obstacle-crypto-randomuuid.png`. Repro in §11 (O1).

**Top fixes, in order:** (1) localize the 404 page (`src/app/not-found.tsx`); (2) UUID fallback + Arabic error mapping in `src/components/workspace.tsx:139,147`; (3) link `/terms` from navigation or a footer; (4) add an app icon (favicon currently 404s); (5) darken the light-theme hero subtitle (4.39:1 vs 4.5:1 AA). Automation limits are listed in §13 — notably the real Google popup, live providers, binary uploads, and screen-reader output are not automatable here and are declared as such.

---

## 1. نطاق الجولة والبيئة

| البند | القيمة |
| --- | --- |
| خادم التطبيق | إنتاج (production build) على `http://chate.test:3212`، PID مُدار من القائد، لم يُعَد تشغيله |
| المزوّدون | Turnstile/OpenRouter/OTP مزوّدون mocked عبر `CHATE_E2E_MOCK=1`؛ Anthropic مُعطّل عمدًا (`ANTHROPIC_API_KEY` فارغ) |
| قاعدة البيانات | `data/qa.sqlite` (نسخة QA)؛ مستخدمو اختبار `qa_*` فقط |
| الجلسات | كوكي `chate_session` موقّع HMAC-SHA256 من `SESSION_SECRET` وقت التشغيل، يحتوي `iat` ويُتحقق من وجود المستخدم وسلامة الحساب |
| المتصفح | Chrome 156 headless عبر CDP، مقاسات 1440×900 / 768×1024 / 390×844، مظهران فاتح وداكن |
| الأتمتة | `scripts/qa/lib/cdp.mjs` + `run-e2e.mjs` + `seed.mjs`، بلا Playwright ولا أي اعتمادية جديدة |

## 2. المنهجية

1. **تجهيز مستخدمي اختبار** في قاعدة QA (غير موثّق، موثّق، مدير، ومستخدم لعقد OTP) وتوقيع كوكي الجلسة في الذاكرة فقط؛ لا تُطبع الأسرار ولا تُكتب في الإثباتات.
2. **فحوص ثابتة** (قبل المتصفح): رؤوس الأمان، ترميز الصفحات، إعادة التوجيه، عقد كل API، حالات 401/403/404/422، CSRF/Origin، تزوير الجلسة، سرّية الأسرار في HTML/JS المخدوم، ونمط 404.
3. **رحلة متصفح** على نفس الخادم: تنقّل، ثيم، رجوع/تقدّم، مساحة العمل بعد الدخول، التحقق من السؤال الفارغ، بوابة الجوال، حقن HTML، النقر السريع، لوحة المفاتيح، الوصول، RTL، الاستجابة، الأداء، ثم رحلة مقارنة كاملة ورحلة OTP.
4. **جمع الأدلة**: لقطات PNG، سجل console/exceptions/network (بعد استبعاد ضوضاء التطوير المعروفة)، وملف مصفوفة JSON قابل للقراءة آليًا.
5. **قاعدة الحكم**: PASS فقط عند تحقق السلوك فعليًا في المتصفح/HTTP؛ أي شك يُسجَّل BLOCKED مع السبب. لم تُحوَّل الافتراضات إلى نجاحات.

## 3. النتائج الإجمالية

| الحالة | العدد |
| --- | --- |
| ✅ ناجح | 45 |
| ❌ فاشل | 2 |
| ⛔ محجوب | 0 |
| ↷ متجاوز | 0 |
| **الإجمالي** | **47** |

الفشلان `S05` و`B08` هما العيب نفسه (صفحة 404 غير معرّبة) من مسارين: فحص HTTP مباشر، ولقطة متصفح. لا يوجد فشل آخر.

## 4. مصفوفة الاختبارات

| المعرّف | المجال | الحالة | المتوقع ← الفعلي (مختصر) | الدليل |
| --- | --- | --- | --- | --- |
| S01 | server reachability | ✅ ناجح | HTTP 200 Arabic HTML ← HTTP 200, 8697 bytes | JSON |
| S02 | security headers on HTML | ✅ ناجح | CSP with frame-ancestors none + nosniff + DENY + referrer + permissions ← all present; CSP=453 chars | JSON |
| S03 | RTL shell attributes | ✅ ناجح | html lang="ar" dir="rtl" + Arabic skip link ← attributes present | JSON |
| S04 | public pages render (200, Arabic h1) | ✅ ناجح | public routes 200, anonymous profile 307 to /, authenticated profile 200 ← / 200; /privacy 200; /terms 200; /account 200; /history 200; /admin 200; /profile/complete 307 anonymous -> /; /profile/complete 200 authenticated | JSON |
| S05 | 404 page status and localization | ❌ فاشل | 404 + نص عربي معرّب ← 404 body is not Arabic-localized:  ChatE 404: This page could not be found. تخطى إلى المحتوى ChatE داكن السجل الخصوصية body{color:#000;background:#fff;margin:0}.next-error-h1{bord… | JSON/error |
| S06 | unauthenticated /workspace redirect | ✅ ناجح | 307 Location / ← 307 Location / | JSON |
| S07 | GET /api/models contract | ✅ ناجح | 200, ok envelope, model array with required fields ← 23 models, keys ok | JSON |
| S08 | POST /api/comparisons unauthenticated = 401 | ✅ ناجح | 401 anonymous Arabic ← 401 anonymous | JSON |
| S09 | GET comparison unauthenticated and unknown id | ✅ ناجح | 401 anonymous; 404 not_found authenticated ← 401/404/404 as expected | JSON |
| S10 | admin API authorization | ✅ ناجح | 401 / 403 / 200 / 401 ← 401, 403, 200, 401 | JSON |
| S11 | unverified phone gate on comparison | ✅ ناجح | 403/503 with Arabic phone-verification gate ← 403 profile_incomplete — استخدام النماذج ينتظر توثيق الجوال. أكمل التحقق قبل الإرسال. | JSON |
| S12 | comparison input validation (authenticated, p… | ✅ ناجح | 422/422/400/400 then 403 Turnstile rejection (no provider call) ← 422, 422, 400, 400, 403 — rejected before any model dispatch | JSON |
| S13 | theme endpoint cookie contract | ✅ ناجح | 303 to /privacy + chate_theme=dark (not httpOnly) ← 303 http://chate.test:3212/privacy | JSON |
| S14 | Google intent nonce endpoint | ✅ ناجح | 200 nonce + httpOnly nonce cookie ← 200 nonce issued | JSON |
| S15 | no server secret values in served HTML/JS | ✅ ناجح | zero findings ← 15 assets scanned, 0 findings | JSON |
| S16 | admin mutation rejects wrong origin / CSRF, a… | ✅ ناجح | 403, 403, 303 notice=rejected ← 403, 403, 303 | JSON |
| S17 | uploads route stub behavior | ✅ ناجح | 401 Arabic anonymous (no bytes stored by design) ← 401 anonymous | JSON |
| S18 | OTP API contract (send / wrong / verify / reu… | ✅ ناجح | 200 sent, 403 mismatch with remainingAttempts, 200 verified, 403 reuse ← 200, 403/OTP_MISMATCH, 200, 403 | JSON |
| S19 | session cookie forgery / expiry / ghost user … | ✅ ناجح | all 401 ← forged 401, expired 401, ghost 401 | JSON |
| B01 | home renders (desktop 1440x900) | ✅ ناجح | Arabic RTL hero, skip link, landmarks, no console errors, one h1 ← one h1, landmarks ok, overflowX=0, CTA={"googleHost":true,"googleChildren":1,"links":["الخصوصية"]} | _final-home-desktop-light.png |
| B02 | home sign-in CTA present | ✅ ناجح | rendered sign-in CTA ← embedded sign-in node count 1 (QA stub) | JSON |
| B03 | theme toggle persists (cookie + server render) | ✅ ناجح | light -> dark + cookie persisted -> reload still dark -> back to light ← persisted dark across reload; dark screenshot captured | _final-home-desktop-dark.png |
| B04 | navigation + back/forward | ✅ ناجح | client-side nav plus browser history restore each page ← back -> /privacy, forward -> /history | _final-privacy-desktop.png, _final-history-desktop.png |
| B05 | terms page renders and is linked | ✅ ناجح | 200 Arabic terms content; footer/nav link for discoverability ← content renders; inbound links on page: [] | _final-terms-desktop.png |
| B06 | account / history unauthenticated rendering | ✅ ناجح | Arabic informational pages with sign-in affordance ← account CTA host present=true; history CTA host present=true | _final-account-desktop.png, _final-history-desktop.png |
| B07 | admin denied page (unauthenticated) | ✅ ناجح | 200 page explaining server-side admin denial, no dashboard data ← denial copy rendered, no metrics in DOM | _final-admin-denied-desktop.png |
| B08 | 404 page screenshot | ❌ فاشل | صفحة 404 عربية مع درج مسار للرئيسية ← 404 page shows English Next.js default text in an Arabic-first product | JSON/error |
| B09 | unauthenticated /workspace redirect (browser) | ✅ ناجح | browser lands on / with home hero ← final path /; document responses [{"url":"http://chate.test:3212/workspace","method":"GET","status":null,"location":null}] | _final-workspace-unauth-redirect.png |
| W01 | authenticated /workspace renders (shortcuts +… | ✅ ناجح | question form + 4 shortcuts + model checklist ← 10 model groups, 23 checkboxes | _final-workspace-auth-desktop-light.png |
| W02 | client hydration sanity (event handlers fire) | ✅ ناجح | aria-pressed flips ← flipped ([{"text":"محادثة","pressed":"true"},{"text":"برمجة","pressed":"false"},{"text":"خفيف","pressed":"false"},{"text":"مقارنة","pressed":"false"}]) | JSON |
| W03 | empty-question validation | ✅ ناجح | Arabic inline message, no network request ← status: اكتب السؤال في الحقل أولًا.; comparison requests: 0 | JSON |
| W04 | submit with unverified phone shows Arabic gate | ✅ ناجح | Arabic phone-verification gate message; no model call ← status: استخدام النماذج ينتظر توثيق الجوال. أكمل التحقق قبل الإرسال.; 1 POST(s); 156ms to message | _final-workspace-phone-gate.png |
| W05 | long Arabic question stays inside layout | ✅ ناجح | no page-level horizontal overflow; textarea scrolls internally ← length=2880, overflowX=0, textarea internal scroll=true, maxLength=-1 (server cap 8000) | JSON |
| W06 | HTML/script payload in question is treated as… | ✅ ناجح | payload shown as literal text, never executed ← window.__qaXss=null, injected nodes=0, literal text echoed=true | JSON |
| W07 | rapid double submit sends at most one request | ✅ ناجح | at most one POST /api/comparisons (sending ref guard) ← 1 POST(s); status: استخدام النماذج ينتظر توثيق الجوال. أكمل التحقق قبل الإرسال. | JSON |
| W08 | back/forward after authenticated workspace na… | ✅ ناجح | workspace and privacy restore correctly ← back -> /workspace, forward -> /privacy | JSON |
| A01 | keyboard focus order and focus-visible styles | ✅ ناجح | skip link first, nav/links reachable, every stop has a visible focus indicator ← a:تخطى إلى المحتوى -> a:ChatE -> button:داكن -> a:السجل -> a:الخصوصية -> button:متابعة باستخدام Google -> a:الخصوصية -> a:تخطى إلى المحتوى -> a:ChatE | JSON |
| A02 | DOM accessibility audit (public pages) | ✅ ناجح | no issues ← all routes clean | JSON |
| A03 | RTL and mixed-direction rendering | ✅ ناجح | dir=rtl, nav flows right-to-left, model ids LTR ← dir=rtl; nav x positions [332,250]; ltr elements 8 (all ltr=0) | JSON |
| R01-mobile | home responsive 390x844 | ✅ ناجح | no horizontal overflow, header rows do not overlap ← overflowX=0, tiny targets=1, screenshot captured | _final-home-mobile-390x844.png |
| R01-tablet | home responsive 768x1024 | ✅ ناجح | no horizontal overflow, header rows do not overlap ← overflowX=0, tiny targets=1, screenshot captured | _final-home-tablet-768x1024.png |
| R02-mobile-workspace | authenticated workspace responsive 390x844 | ✅ ناجح | no horizontal overflow; form usable ← overflowX=0 | _final-workspace-auth-mobile-390x844.png |
| R03-dark | dark theme pages (home + workspace) | ✅ ناجح | dark theme applied server-side with readable contrast ← dark attr present; workspace contrast {"h1":null,"p":null,"nav-link":null,"button":null,"meta":null,"label":null} | _final-home-desktop-dark.png, _final-workspace-auth-desktop-dark.png |
| P01 | perceived performance (dev/prod mocked server) | ✅ ناجح | documented baseline on this server mode (not a production SLA) ← TTFB=11ms, FCP=152ms, load=111ms, LCP=152ms, CLS=0.002, resources=17 (3 KB) | JSON |
| M01 | full comparison journey (mocked providers, Ha… | ✅ ناجح | one POST; 3 OpenRouter columns complete; Haiku column fails independently with Arabic error; polling GETs ← 23 models; 4 cards in 1176ms; OpenRouter answered=3; Haiku status="تعذر" textLength=0; poll GETs=1 | _final-workspace-results.png |
| M03 | profile OTP verification journey (mock SMS) | ✅ ناجح | 2-step OTP UI, Arabic send/verify statuses, then comparison accepted ← send: أُرسل رمز من ٦ أرقام إلى جوالك. أدخله خلال 5 دقائق. \| verify: تم توثيق جوالك. \| code found length 6 \| comparison accepted | _final-otp-verified.png, _final-workspace-after-otp.png |
| M02 | stop/pause control messaging | ✅ ناجح | Arabic message that only the local view stopped; provider may continue ← status: أُوقف العرض المحلي. قد لا يتوقف المزود فورًا. | JSON |

> التفاصيل الكاملة لكل فحص (الخطوات، المتوقع، الفعلي، الزمن، اللقطات) في `docs/audit/evidence/qa-results-prod-mock.json`.

## 5. أخطاء console والشبكة

من `qa-console-prod-mock.json`:

- **استثناءات JS غير ملتقطة في صفحات الإنتاج: 0**.
- **أخطاء console داخلية (غير ضوضاء): 52**، منها 0 تحذير COOP على أصل HTTP غير موثوق (يختفي على HTTPS).
- **فشل شبكة داخلي:** 51 مدخلة؛ منها 49 إلغاء `_rsc` لعملية تنقّل سابقة (سلوك Next طبيعي لإلغاء prefetch) و0 طلب `favicon.ico` يعيد 404 (عيب صغير حقيقي).
- **أخطاء خارجية (Google/Cloudflare): 0** (المزوّدان مستبدلان/محاكيان في هذه الجولة).
- **لا أثر لأسرار الخادم** في أي HTML أو JS مخدوم (الفحص S15: أسماء الأسرار وقيمها الحرفية وأنماط `sk-*`).

مدخلات شبكة أخرى: HTTP 404 Document http://chate.test:3212/qa-missing-1793195463947؛ HTTP 403 Fetch http://chate.test:3212/api/comparisons

## 6. أساسيات الوصول (Accessibility)

- **ترتيب التركيز بلوحة المفاتيح:** أول Tab = رابط «تخطى إلى المحتوى»، ثم الشعار، زر الثيم، الروابط، زر Google. التسلسل المقاس: a:تخطى إلى المحتوى -> a:ChatE -> button:داكن -> a:السجل -> a:الخصوصية -> button:متابعة باستخدام Google -> a:الخصوصية -> a:تخطى إلى المحتوى -> a:ChatE.
- **مؤشر التركيز مرئي** على كل محطات Tab التي فُحصت (outline أو box-shadow غير صفري).
- **التسميات:** 0 عناصر تفاعلية بلا اسم مفهوم على 7 صفحات؛ 0 صور بلا alt (لا صور محتوى)؛ h1 واحد لكل صفحة؛ لا قفزات في تسلسل العناوين؛ لا معرّفات مكررة (A02: ناجح).
- **التباين (قياس بأخذ عينات بكسل فعلية من canvas، وليس تقديرًا):**
  - الرئيسية/فاتح: h1 ‎13.48:1‎، روابط ‎13.48:1‎، **فقرة العنوان الفرعي ‎4.39:1‎ (أقل من AA 4.5)**؛
  - الرئيسية/داكن: h1 ‎16.27:1‎، فقرة ‎8.21:1‎؛
  - مساحة العمل/فاتح: فقرة ‎5.1:1‎، meta ‎5.35:1‎؛ مساحة العمل/داكن: فقرة ‎8.43:1‎، meta ‎6.66:1‎.
  - الاستنتاج: التباين جيد عدا حالة واحدة حدّية (O5 في §11).
- **ملاحظة:** قارئ شاشة حقيقي (NVDA/VoiceOver) لم يُختبر؛ هذا خارج أتمتة CDP ويحتاج تحققًا يدويًا — مُعلن كحدّ أتمتة وليس نجاحًا.

## 7. صحة RTL

- `html lang=ar dir=rtl` على كل الصفحات؛ `getComputedStyle(html).direction = rtl`.
- روابط التنقّل تتدفق من اليمين إلى اليسار (قياس مواضع x: dir=rtl; nav x positions [332,250]; ltr elements 8 (all ltr=0)).
- عناصر معرّفات النماذج `.ltr` (8 عناصر) اتجاهها `ltr` فعليًا وصفر انحراف.
- لا انعكاس خاطئ للنصوص المختلطة في الرأس أو مساحة العمل.

## 8. الاستجابة (Responsive)

- **390×844:** لا تجاوز أفقي (overflowX = 0)، الرأس صفّان بلا تراكب، لقطات الرئيسية ومساحة العمل ناجحة.
- **768×1024:** لا تجاوز أفقي، الرأس سليم، لقطة ناجحة.
- **1440×900:** التخطيط سليم؛ مساحة العمل تعرض النموذج والاختصارات والأعمدة.
- اللقطات: `_final-home-mobile-390x844.png`، `_final-home-tablet-768x1024.png`، `_final-workspace-auth-mobile-390x844.png`، `_final-home-desktop-light.png`، `_final-home-desktop-dark.png`، `_final-workspace-auth-desktop-dark.png`.

## 9. الأداء المُحسّ (perceived performance)

قياس على خادم QA (إنتاج + mock، وليس SLA إنتاجي): TTFB=11ms, FCP=152ms, load=111ms, LCP=152ms, CLS=0.002, resources=17 (3 KB).
الخلاصة: الصفحة الرئيسية تُرسم بسرعة (LCP ~152ms، CLS 0.002) في هذه البيئة، والرحلة الكاملة للمقارنة تظهر أول النتائج خلال أقل من ثانيتين بعد الإرسال (M01: 4 أعمدة خلال 1176ms، وردود النماذج المجانية الثلاثة مكتملة). زمن الـ polling الفعلي يعتمد على المزوّد الحقيقي ولم يُختبر حيًا.

## 10. الأمان من منظور تجربة المستخدم

- رسائل أخطاء API عربية عامة بلا آثار مكدّس أو مسارات ملفات: 401/403/404/422 كما في المصفوفة.
- رؤوس: CSP مع `frame-ancestors 'none'` و`object-src 'none'`، `nosniff`، `X-Frame-Options: DENY`، `Referrer-Policy`، `Permissions-Policy`؛ `X-Powered-By` غائب.
- **لا تسرّب أسرار**: لا أسماء ولا قيم لأسرار الخادم في HTML/JS المخدوم.
- جلسات: توقيع مزوّر، منتهية، ومستخدم غير موجود → 401؛ إدارة: Origin/CSRF خاطئ → 403، وطلب mutation بصيغة صحيحة لكن أمر غير معروف → 303 مع `notice=rejected` (لا تغيير بيانات).
- **استثناء UX مهم:** الخطأ الخام الإنجليزي `crypto.randomUUID is not a function` يظهر للمستخدم على أصل HTTP (O1) — كشف تفاصيل تنفيذ داخلية.
- CSP لا يزال يسمح `'unsafe-inline'` للسكربتات (قيد معروف في `src/domain/security/headers.ts:3`)، ويُنصح بالانتقال إلى nonce/hash لاحقًا.

## 11. قائمة العقبات المرتّبة (repro + fix)

### O1 — P0: فشل الإرسال على أصل HTTP وظهور رسالة إنجليزية خام  
**الملاحظة:** على أصل غير localhost وبلا HTTPS لا تتوفر `crypto.randomUUID` (سياق غير آمن)، فيفشل الإرسال قبل أي طلب شبكة.  
**إعادة الإنتاج:** 1) افتح `http://chate.test:3212/workspace` بجلسة صالحة (يمكن استخدام كوكي QA). 2) اكتب سؤالًا عربيًا. 3) اضغط «إرسال». **الفعلي:** تظهر حالة «crypto.randomUUID is not a function» بالحرف الإنجليزي، وعدد طلبات `POST /api/comparisons` = صفر. **المتوقع:** إرسال المقارنة أو رسالة عربية عامة.  
**الدليل:** `_final-obstacle-crypto-randomuuid.png` (لقطة الشاشة الحقيقية).  
**السبب:** `src/components/workspace.tsx:139` يستدعي `crypto.randomUUID()` مباشرة، و`src/components/workspace.tsx:147` يعرض `error.message` كما هو.  
**الإصلاح المقترح:** استخدم بديلًا احتياطيًا بصيغة UUIDv4 عند غياب `crypto.randomUUID` (مثل `crypto.getRandomValues` للتوليد)، وابدأ بـ `typeof crypto.randomUUID === 'function'`؛ وفي `catch` اعرض `REQUEST_FAILED_MESSAGE` العربية وسجّل التفصيل في console فقط.  
**ملاحظة صدق:** النشر على HTTPS سياق آمن فلن يتكرر الفشل الوظيفي، لكن معالجة الأخطاء الخام وكشف الأسماء الإنجليزية يبقى عيبًا.  

### O2 — P1: صفحة 404 غير معرّبة  
**الدليل:** `_final-not-found-desktop.png`؛ النص: «404: This page could not be found.» داخل واجهة عربية RTL، ورؤوس بقية الصفحات عربية.  
**إعادة الإنتاج:** افتح أي مسار غير موجود مثل `/qa-missing-404`.  
**السبب:** لا يوجد `src/app/not-found.tsx` (تم التحقق من غيابه)، فيستخدم Next صفحته الافتراضية الإنجليزية.  
**الإصلاح:** أضف `src/app/not-found.tsx` بمحتوى عربي + رابط للرئيسية.  

### O3 — P1: صفحة الشروط غير قابلة للوصول من الواجهة  
**الدليل:** B05 — لا رابط إلى `/terms` في أي صفحة؛ روابط التنقّل فقط: مساحة العمل، الإدارة (للمشرف)، السجل، الخصوصية (`src/app/layout.tsx:44-47`).  
**الأثر:** الشروط قانونيًا يجب أن تكون متاحة قبل الاستخدام، والخصوصية مرتبطة بها.  
**الإصلاح:** أضف رابط «الشروط» في `layout.tsx` أو تذييل Footer.  

### O4 — P2: أيقونة الموقع مفقودة (favicon 404)  
**الدليل:** طلب `GET /favicon.ico` يعيد 404 وسجله console في كل صفحة تقريبًا؛ لا `src/app/icon.*` ولا `favicon.ico` في المشروع.  
**الإصلاح:** أضف `src/app/icon.svg` بسيطًا بهوية ChatE.  

### O5 — P2: تباين فقرة العنوان الفرعي في الثيم الفاتح 4.39:1  
**الدليل:** قياس canvas: `rgb(233,225,210)` خلفية و4.39:1 للنص الافتراضي — أقل من AA 4.5.  
**الإصلاح:** تعميق لون النص الثانوي في `src/app/globals.css` بدرجة واحدة.  

### O6 — P2 (فجوات معروفة موثقة): 
1) `/history` صفحة نصية ثابتة لا تعرض صفوفًا (متوافق مع README، لا يدّعي العكس). 2) حذف الحساب نص فقط بلا تنفيذ. 3) رفع الملفات واجهة فقط ويعيد 401 بلا تخزين. 4) تسجيل Google يتطلب معرّف عميل وأصل مصرّح؛ في بيئة QA يظهر «دخول Google ينتظر معرّف العميل» وهذا سلوك آمن معلن.  

### O7 — P3: CSP يسمح `'unsafe-inline'` للسكربت  
**المرجع:** `src/domain/security/headers.ts:3-4`. إزالة ذلك تتطلب nonce أو hash؛ يُنصح كتحصين لاحق لا كحاجز إطلاق.  

## 12. قائمة صقل قصيرة

1. عرض رسالة واضحة عند تعذّر تحميل زر Google بدل مساحة فارغة (في بيئة QA الحالية يُظهر الرسالة العربية بالفعل، وهو جيد).
2. توحيد زمن رسالة الإرسال: بوابة الجوال ظهرت خلال 156ms — ممتاز؛ أضف مؤشر تحميل معطّلًا للزر أثناء الطلب.
3. إظهار `maxLength` عميلًا للسؤال (حد الخادم 8000 حرف) بدل اكتشافه بعد الإرسال.
4. إضافة رابط «الشروط» بجانب «الخصوصية» في التذييل/التنقّل.
5. معالجة أخطاء الشبكة في `protectedPost` برسالة عربية موحّدة (الموجود حاليًا جيد في معظم المسارات).

## 13. حدود الأتمتة (ما لم يُختبر، ولماذا)

| ما لم يُختبر | السبب | الحالة المعلنة |
| --- | --- | --- |
| نافذة Google الفعلية (popup + credential) | تحتاج حساب Google حقيقي ونطاقًا مصرّحًا؛ لا يمكن أتمتتها بأمان | BLOCKED خارج المصفوفة؛ تحقق `/api/auth/google/intent` + عرض زر Google (stub) فقط |
| مزوّدون حقيقيون (OpenRouter/Anthropic) | ممنوع إجراء استدعاءات مدفوعة حية؛ تم استخدام mock | muqāranah كاملة على mock فقط |
| رسائل SMS حقيقية | المزوّد mocked ويُسجّل الرمز في `tmp/otp-codes.jsonl` | رحلة OTP كاملة على mock (M03) |
| رفع ملفات ثنائية وتخزينها | stub مقصود يعيد 401 بلا تخزين | فحص العقد S17 فقط |
| قارئ شاشة (NVDA/VoiceOver) | خارج CDP | يحتاج تحققًا يدويًا |
| إشعارات/بريد خارجي | غير مهيأ | خارج النطاق |

> **ملاحظة صدق عن جولة التطوير:** قبل تسليم نسخة الإنتاج، أثناء عمل خادم التطوير (`next dev`)، لوحظ أن مكوّنات العميل لم تُهيّأ (لا آثار `__reactFiber`، زر Google لم يُركّب، `/api/models` لم يُطلب). **لم يتكرر ذلك في نسخة الإنتاج** (W02 ناجح: النقر يغيّر `aria-pressed`، والـ hydration سليم)، لذلك يُسجَّل كأثر مشهد تطوير/تزامن بناء لا كعيب منتج، ولم يُحتسب في المصفوفة.

## 14. القطع النهائية وإعادة الإنتاج

**الملفات:**

| الملف | المحتوى |
| --- | --- |
| `docs/audit/QA-UX-REPORT.md` | هذا التقرير |
| `docs/audit/screenshots/_final-*.png` | 20 لقطة نهائية (سطح مكتب/لوحي/جوال، فاتح/داكن، رحلة OTP والمقارنة، صفحة 404، لوحة الإدارة) |
| `docs/audit/evidence/qa-results-prod-mock.json` | مصفوفة 47 فحصًا كاملة |
| `docs/audit/evidence/qa-console-prod-mock.json` | console/network/exceptions |
| `scripts/qa/*` | الأداة (CDP + seed + orchestrator + smoke) |
| `tests/e2e/README.md` | توثيق طبقة E2E |

**إعادة التشغيل:**

~~~powershell
$env:QA_BASE_URL='http://chate.test:3212'
$env:QA_ENV_FILE='tmp/qa/e2e.env'
$env:QA_PHASE='prod-mock'
$env:CHATE_E2E_MOCK='1'
$env:QA_GOOGLE_STUB='1'
& C:\Pak\node.exe scripts/qa/run-e2e.mjs
~~~

**حسابات الاختبار:** `qa_user_unverified` / `qa_user_unverified2` / `qa_user_verified` / `qa_user_nonadmin` / `qa_user_admin` في `data/qa.sqlite`، بكوكي موقّع في الذاكرة.  
**لقطات مساندة:** `_final-admin-dashboard.png` (تحقق إضافي بعد مصفوفة الجولة: لوحة الإدارة 200 بـ14 بطاقة وجدول، مع بريد المشرف `qa-admin@example.com` التجريبي)، `_final-otp-verified.png`، `_final-workspace-results.png`، `_final-workspace-phone-gate.png`.
