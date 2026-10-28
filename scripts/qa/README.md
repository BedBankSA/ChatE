# أداة QA — Chrome DevTools Protocol بلا اعتماديات

هذه الأداة تختبر ChatE من المتصفح مباشرة عبر protocol Chrome DevTools. لا Playwright ولا Puppeteer ولا أي حزمة npm: Node.js 24 يوفّر `WebSocket` و`fetch` كمتغيّرات عالمية، وChrome النظامي هو المتصفح.

## المتطلبات

- Node.js 24 على `C:\Pak\node.exe` (على هذه الآلة قد لا يكون `node` على PATH).
- Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe` (أو `QA_CHROME_PATH`).
- خادم ChatE يعمل مسبقًا. الأداة لا تشغّله ولا تعيد تشغيله ولا تمسّ `.next`.

## الملفات

| الملف | الوظيفة |
| --- | --- |
| `lib/cdp.mjs` | مشغّل Chrome، عميل CDP، جامع أخطاء console/network، صفحة مساعدة (تنقّل، نقر، كتابة، لقطات). |
| `seed.mjs` | يُدخل مستخدمي اختبار `qa_*` في قاعدة SQLite ويوقّع كوكي `chate_session` بـ HMAC-SHA256 من `SESSION_SECRET` وقت التشغيل (لا تُطبع القيم أبدًا). |
| `run-e2e.mjs` | المُنسّق: فحوص API/رؤوس ثابتة + رحلة متصفح كاملة + مصفوفة نتائج + لقطات. |
| `smoke.mjs` | فحص دخاني سريع: يفتح الصفحة الرئيسية ويطبع العنوان والأخطاء. |

## التشغيل

```powershell
# فحص ثابت فقط (API، الرؤوس، 404، إعادة توجيه، فحص الأسرار)
$env:QA_BASE_URL='http://chate.test:3212'
$env:QA_ENV_FILE='tmp/qa/e2e.env'
$env:QA_PHASE='prod-mock'
$env:CHATE_E2E_MOCK='1'
& C:\Pak\node.exe scripts/qa/run-e2e.mjs --static-only

# الجولة الكاملة (متصفح + لقطات)
$env:QA_CDP_PORT='9231'
& C:\Pak\node.exe scripts/qa/run-e2e.mjs

# الفحص الدخاني
& C:\Pak\node.exe scripts/qa/smoke.mjs http://127.0.0.1:3212
```

المخرجات:

- `docs/audit/screenshots/_final-*.png`
- `docs/audit/evidence/qa-results-<phase>.json` (مصفوفة كاملة + العدّادات)
- `docs/audit/evidence/qa-console-<phase>.json` (console/network/exceptions)

## متغيّرات البيئة

| المتغيّر | الافتراضي | الوصف |
| --- | --- | --- |
| `QA_BASE_URL` | `http://chate.test:3212` | أصل المتصفح. إن كان المضيف غير loopback يُضاف `--host-resolver-rules` تلقائيًا. |
| `QA_NODE_BASE` | وكيل محلي تلقائي | أصل طلبات Node؛ الضروري لأن `fetch` في Node لا يحلّ `chate.test` ولا يسمح بتجاوز `Host`. |
| `QA_PROXY_PORT` | `3213` | منفذ الوكيل المحلي الذي يعيد كتابة `Host` إلى مضيف المنتج. |
| `QA_ENV_FILE` | — | ملف dotenv إضافي (أسرار QA) يُقرأ وقت التشغيل فقط. |
| `QA_PHASE` | `prod-mock` عند `CHATE_E2E_MOCK=1` | اسم المرحلة في أسماء ملفات الإثبات. |
| `QA_TURNSTILE_STUB` | `1` | حقن `window.turnstile` وهمي قبل سكربتات التطبيق، يعيد رمزًا بصيغة `qa.<action>.<host>.<ms>` (يتطابق مع mock الخادم). |
| `QA_GOOGLE_STUB` | `0` | حقن زر Google مرئي بديل عند تعذّر origin الرسمي. |
| `QA_HOST_RESOLVER_RULES` | تلقائي | مثل `MAP chate.test 127.0.0.1`. |
| `QA_ONLY` | — | قائمة IDs مفصولة بفواصل لتشغيل جزء من المصفوفة. |
| `QA_STATIC_ONLY` | `0` | تخطّي مرحلة المتصفح. |
| `QA_CDP_PORT` | `9222` | منفذ CDP؛ غيّره إذا بقي Chrome قديم يعمل. |

## الأمان

- لا تُطبع `SESSION_SECRET` ولا أي قيمة سر، ولا تُكتب في الإثباتات. فحص S15 يبحث عن أسماء الأسرار وقيمها الحرفية في HTML/JS المخدوم ويسجّل أسماء الملفات فقط.
- المستخدمون المزروعون بمعرّفات `qa_*` فقط؛ إعادة التشغيل تُحدّثهم ولا تحذف بيانات أخرى، وتُفرّغ تحديات OTP الخاصة بهم فقط.
- ملف الجلسات المؤقت يُكتب في `tmp/qa/sessions.json` (مستبعد من Git).
