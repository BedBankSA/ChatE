# نتائج الاختبار

التاريخ: 2026-10-27. لم يُنشر الموقع. لم يُستدعَ Haiku حيًا. لم يُرسل إكمال محادثة إلى OpenRouter.

## اختبارات محلية

الأمر:

```powershell
node .\node_modules\vitest\vitest.mjs run tests/product.test.ts
```

النتيجة: **نجاح**. 13 اختبارًا نجحت، 0 فشلت. الملف `tests/product.test.ts`.

غطت الاختبارات: رفض المجهول، جمهور Google الخاطئ، الاسم والبريد من المطالبة المتحققة، الجوال قبل OTP، رفض الإدارة، Turnstile الناقص والمعاد والإجراء والنطاق وlocalhost في الإنتاج، السؤال نفسه لنموذجين وفشل أحدهما، منع الاستبدال والمسار المدفوع، حظر التضمين 1B وفصل الفهارس، لقطات Gemma وFlint وInkling وHaiku، الصفحات الفاشلة وzip-slip، ملف الارتباط، وغياب أسماء الأسرار من مصدر الواجهة.

## البناء

بعد نقل `node_modules` إلى `C:\Users\dr_em\AppData\Local\ChatE-node_modules` وإنشاء junction، أُعيد البناء مرة واحدة. لم يكن هناك ملف `.next\lock`.

الأمر:

```powershell
C:\Users\dr_em\OneDrive\Desktop\ChatE\.tools\node-dist\node-v24.22.1-win-x64\node.exe .\node_modules\next\dist\bin\next build
```

النتيجة: **فشل**. رمز الخروج `1`.

أول خطأ:

```text
Error: Cannot find module 'next/dist/compiled/commander'
Require stack:
- C:\Users\dr_em\AppData\Local\ChatE-node_modules\next\dist\bin\next
```

Node حلّ مسار Next عبر المسار الحقيقي خارج مجلد اسمه `node_modules`. الملف `dist\compiled\commander\index.js` موجود على القرص، لكن التحميل توقف قبل التجميع. لم يُشغَّل بناء ثانٍ.

## ما لم يُشغَّل

- Docker غير مثبت. `npm run db:migrate` لم يُنفذ. لا يُدّعى أن Postgres يعمل.
- Playwright لم يُشغَّل.
- لا استدعاء حي لـ Anthropic.
- طلب قراءة OpenRouter في هذا التنفيذ كان `GET /api/v1/models` مرة واحدة. نقاط embeddings والقرار والكلام موثقة في `docs/openrouter-model-registry.md` من قراءة سابقة باليوم نفسه، ولم تُعد هنا.

`npm install` تعثر أولًا بشهادة TLS ثم بأقفال OneDrive على `node_modules`. التشغيل أعلاه تم بعد اكتمال الشجرة بما يكفي لـ Vitest وNext.

## تخزين SQLite

القسم السابق يصف التشغيل قبل اعتماد ملف SQLite. بعده لم يعد التشغيل يطلب Docker أو Postgres.

`npm run db:migrate` أنشأ `data/chate.sqlite` وطبق `001_init.sql`. تشغيل ثانٍ طبع `no pending migrations`.

الأمر:

```powershell
C:\Pak\node.exe .\node_modules\vitest\vitest.mjs run tests/product.test.ts tests/sqlite-store.test.ts
```

النتيجة: **نجاح**. 22 اختبارًا نجحت، 0 فشلت. 14 في `tests/product.test.ts` و8 في `tests/sqlite-store.test.ts`.

`tsc --noEmit` نجح. لم يُستدعَ مزود مدفوع. لم يُنشر الموقع.
