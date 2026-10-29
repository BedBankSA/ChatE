# نموذج التكلفة — ChatE
# Cost model: infra, provider math, unit economics

**التاريخ / Date:** 2026-10-28 · **العملة:** USD · **تنبيه:** أسعار السوق أدناه **افتراضات مرجعية** (لا عروض أسعار موقّعة ولا فواتير). أرقام المزود وقواعد الحصص مأخوذة من ملفات المستودع وتُعدّ **مقروءة** لا مُتحقَّقًا منها بفاتورة.

---

## English executive summary

Cheapest safe production profile: **one 2 vCPU / 2 GB / 40 GB Ubuntu VPS (~$7-15/mo) + free Cloudflare + free Let's Encrypt + free uptime monitor + ~$1.25/mo domain ≈ $9-17/mo**, with a one-time **$10 OpenRouter credit** purchase if the beta needs >50 free-model requests/day (free tier is 20 rpm / 50 rpd before credits, 1000 rpd after). Provider cost is **$0 for the free OpenRouter models** (they are rate-limited, not billed) and **≈$0.00024-$0.0028 per Haiku call** at current prompt sizes ($0.10/$0.50 per MTok under 100k tokens). Because quota accounts are split per provider, the current defaults (`USER_QUOTA_UNITS=200`, `SHARED_QUOTA_UNITS=2000`) bound the *platform* at **666 default 4-model comparisons** (2000/3 OpenRouter units) and **2000 Haiku calls**, i.e. typical Haiku spend **≈$0.16-$5.60 total** until quotas are reset — but with **no cash spend cap**, the theoretical worst case (every Haiku output at the 128k-token cap) is **≈$128** per 2000-call pool. Unit economics at 1k comparisons/month ≈ **$10.25 infra + $0.24-$2.80 Haiku = ≈$10.5-$13 per 1k comparisons**; at 10k/month the infra share collapses and Haiku dominates at **$0.00024-$0.0028/comparison**. Paid public launch additionally needs billing, which does not exist.

---

## 1. الأرقام المقيسة في هذا المستودع / Measured facts

| Metric | Value | Source |
| --- | --- | --- |
| SQLite schema size (empty DB) | 417,792 B (102 pages × 4096) | `PRAGMA page_count` on `data/chate.sqlite`, 2026-10-28 |
| Tables | 36 | `sqlite_master` query |
| `node_modules` size | 558 MB | measured in workspace |
| Default comparison | 4 runs: Gemma 31B + Flint + Gemma 26B (free) + Haiku | `src/domain/workspace-start.ts:5-10` |
| Quota defaults | user 200، shared 2000 units | `.env.example:39-40`؛ `src/server/db/quota.ts:41-48` |
| Provider split | openrouter: `shared`/`user:<id>`؛ anthropic: `shared:anthropic`/`user:<id>:anthropic` | `src/server/comparisons/store.ts:336-339` |
| Haiku rates (≤100k prompt tokens) | input $0.10/MTok، output $0.50/MTok؛ cache read $0.01، cache write 5m $0.125 | `docs/haiku-5-5-addendum.md:97-103`، `src/domain/models/haiku.ts:48-64` |
| Haiku rates (>100k tokens) | input $0.50، output $2.50، cache read $0.05، cache write $0.625/1.0 | same |
| Haiku max output ceiling in code | `max_tokens = min(128000, 1,000,000 - inputTokens)` | `src/domain/models/haiku.ts:24-26` |
| Free-model platform limits | <$10 credits: 20 rpm / **50 rpd**؛ ≥$10: 20 rpm / **1000 rpd** | `docs/openrouter-model-registry.md:45-51` |
| Retry policy | 429: max 2 retries with Retry-After | `src/domain/models/dispatch.ts:108-132`؛ `src/domain/quota/reserve.ts:37` |
| Hard timeout per provider call | 120 s (hardcoded, env ignored) | `src/domain/models/dispatch.ts:9` |

## 2. خيارات البنية التحتية / Infra options (assumptions)

| Option | Spec | Est. cost/mo | Suitable? |
| --- | --- | --- | --- |
| **A. 1 vCPU / 1 GB** | e.g. DO/Vultr/Linode basic $5-6؛ swap 2 GB | **$5-6** | تشغيل فقط. `next build` قد يفشل أو يبطؤ؛ build محلي/CI ثم نقل |
| **B. 2 vCPU / 2 GB (موصى به)** | Hetzner CPX11 ≈ €4.35 (~$4.7), DO/Vultr 1vCPU/2GB $12، Contabo ~$7 | **$5-12** | ✅ أرخص آمن: build + web + worker + WAL بمرتاح |
| C. 2 vCPU / 4 GB | Hetzner CX22 ≈ €3.8-4.5 | $5-8 | مساحة أكبر للبناء والنسخ |
| Managed PaaS (Vercel Pro + Neon Postgres) | يتطلب تغيير التخزين من SQLite إلى Postgres + فصل العامل | $20-45 | ❌ ليس متوافقًا مع الكود الحالي بلا عمل تطويري كبير |
| Render/Railway/Fly + قرص دائم | عملية واحدة + volume | $7-25 | ممكن تقنيًا لكن نفس قيود SQLite؛ لا ميزة تشغيلية تُذكر |
| Oracle Cloud Free Tier | Ampere 4 OCPU/24GB مجاني | $0 | مخاطرة شروط/استمرارية؛ لا تعتمد عليه للإنتاج المدفوع |

مكوّنات إضافية (مرجعية): النطاق `.com` ≈ $10-15/سنة (~$1.25/شهر)؛ TLS من Let's Encrypt/Caddy = **$0**؛ Cloudflare Free = **$0** (Pro $20/شهر اختياري)؛ UptimeRobot Free (5 دقائق) = $0 أو BetterStack $10-25/شهر؛ تخزين نسخ خارجي (Backblaze B2 $6/TB/شهر — قاعدة بحجم MB = ~$0)؛ بريد دعم (Zoho Mail مجاني/Google Workspace $6-7/مستخدم/شهر)؛ SMS OTP: جملة ~$0.04-0.08/رسالة (السعودية قد تكون أعلى — **تحقق من عرض المزود**).

## 3. حسابات المزود / Provider cost math

### 3.1 النماذج المجانية (OpenRouter)
- السعر لكل الرموز = 0 (`docs/openrouter-model-registry.md:27`: `pricing.prompt=0`، `completion=0`) → **تكلفة نقدية $0**.
- القيد هو **حدود المعدل على مستوى حساب OpenRouter**: 20 طلب/دقيقة، و50 طلبًا/يوم قبل شراء $10 أرصدة، و**1000 طلب/يوم** بعدها.
- مقارنة افتراضية = 3 طلبات مجانية + 1 Haiku:
  - بلا أرصدة: `50 / 3 = 16` مقارنة/يوم كحد أقصى (وأقل بسبب 20 rpm).
  - مع $10 أرصدة لمرة واحدة: `1000 / 3 = 333` مقارنة/يوم؛ والسقف العملي 20 rpm ≈ 6 مقارنات/دقيقة.
- `openrouter/free` ليس بديلًا صامتًا، والمسار المدفوع مرفوض في الكود (`src/domain/models/dispatch.ts:53-55`)، فلا تكلفة مدفوعة غير متوقعة من OpenRouter.

### 3.2 Claude Haiku 5.5
المعادلة (من `haikuCostUsd`): `cost = input/1e6 × 0.10 + output/1e6 × 0.50` (الشريحة ≤100k رمز موجّه؛ فوقها ×5).

| سيناريو المقارنة | input tokens | output tokens | تكلفة Haiku/استدعاء | تكلفة/1000 مقارنة (Haiku فقط) |
| --- | ---: | ---: | ---: | ---: |
| خفيف (سؤال قصير، بلا ملفات) | 400 | 400 | **$0.00024** | **$0.24** |
| متوسط (سؤال + أدلة نصية) | 2,000 | 1,000 | **$0.00070** | **$0.70** |
| ثقيل (ملفات/سياق كبير) | 8,000 | 4,000 | **$0.0028** | **$2.80** |
| فوق عتبة 100k إدخال | 120,000 | 8,000 | **$0.08** | **$80** |
| سقف الكود النظري (output=128k) | ~1,000 | 128,000 | **$0.064** | **$64** |

ملاحظات:
- `thinking: adaptive` + `effort: medium` يستهلكان من `max_tokens` (`docs/haiku-5-5-addendum.md:68`)؛ لذلك المخرجات الكبيرة ممكنة نظريًا حتى السقف.
- لا يوجد قاطع إنفاق/سقف دولار في الكود؛ الحصة تعدّ **استدعاء واحد = وحدة واحدة** بغض النظر عن الرموز. هذا أهم خطر مالي (انظر `BUSINESS`/B9 في LAUNCH-READINESS).

### 3.3 سقف الإنفاق في الإعداد الحالي (مهم)
- مجمّع Anthropic: `SHARED_QUOTA_UNITS=2000` وحدة → **2000 استدعاء Haiku** كحد أقصى قبل نفاد الحصة.
- مجمّع OpenRouter: 2000 وحدة؛ كل نموذج مجاني = وحدة → `2000/3 = 666` مقارنة افتراضية قبل نفاد حصة OpenRouter.
- لذلك: التكلفة النموذجية في دورة حصص كاملة = `666 × $0.00024…$0.0028` ≈ **$0.16-$5.60** (المقارنات الافتراضية)، أو حتى 2000 استدعاء Haiku إن اختار المستخدمون Haiku وحده.
- السقف النظري (كل استدعاء Haiku يصل 128k مخرجات): `2000 × $0.064 = **$128**` قبل نفاد الحصة. بعد إعادة الضبط/رفع الحصة يتكرر.
- **لا يوجد buy-in مدفوع من المستخدم** → أي فاتورة Haiku يتحملها المالك. القرار المطلوب: تعطيل Haiku أو سقف إنفاق/تنبيه + مراقبة `usage_events.cost_usd`.
- **تحديث 2026-10-28:** شجرة العمل غيّرت التفعيل إلى بوابة بيئية: `HAIKU_LIVE_CALLS=1` فقط يسمح بالاستدعاء الحي، والافتراضي/القالب `0`. الأرقام أعلاه تبقى صحيحة عند التفعيل؛ ومع `0` تصبح تكلفة Haiku **$0** ويبقى خطر التوثيق/القرار قائمًا.

## 4. اقتصاد الوحدة / Unit economics

بافتراض VPS بـ $9/شهر (2 vCPU/2GB) + نطاق $1.25/شهر + مراقبة $0 = **$10.25/شهر ثابت**:

| Compares/month | Infra $/1k | Haiku $/1k (خفيف-ثقيل) | Total $/1k | Cost/comparison |
| ---: | ---: | ---: | ---: | ---: |
| 100 | $102.50 | $0.24-$2.80 | **$102.7-$105.3** | $0.103-$0.105 |
| 1,000 | $10.25 | $0.24-$2.80 | **$10.5-$13.1** | $0.0105-$0.013 |
| 10,000 | $1.03 | $0.24-$2.80 | **$1.27-$3.83** | $0.0013-$0.0038 |
| 100,000 | $0.10 | $0.24-$2.80 | **$0.34-$2.90** | $0.0003-$0.0029 |

(التكلفة أعلاه لا تشمل SMS؛ كل رسالة تحقق ~$0.04-0.08 لمرة واحدة لكل مستخدم جديد في البيتا = 20 مستخدمًا ≈ $1-1.6.)

**مقارنة سيناريوهات التسعير (مستقبلية، إن قرر المالك الدفع):**
- إن كان سعر الاشتراك $5/شهر: هامش إجمالي عند 30 مستخدمًا = $150 − $10.25 − Haiku (~$0.5-2) ≈ **$137**/شهر؛ الحد الحقيقي هو عمليات التطوير لا التكلفة.
- إن أُتيح Haiku بلا سقف لكل مستخدم: مستخدم واحد يمكنه استهلاك 200 استدعاء × سقف 128k مخرجات ≈ **$12.8** في دورة حصص — أكبر من أي اشتراك واقعي. لذلك أي تسعير مدفوع يلزمه سقف كلفة لكل مستخدم/طلب.

## 5. أرخص ملف إنتاج آمن / Cheapest safe production profile

| Item | Choice | Cost/mo |
| --- | --- | --- |
| VPS | 2 vCPU / 2 GB / 40 GB SSD (Ubuntu 24.04) | $5-12 |
| TLS | Caddy + Let's Encrypt | $0 |
| DNS/CDN/WAF | Cloudflare Free | $0 |
| Domain | `.com` (أو `.sa` إن لزم محليًا) | ~$1.25 |
| Monitoring | UptimeRobot Free + cron checks | $0 |
| Offsite backup | rclone إلى مساحة موجودة / B2 (KB-MB) | $0-1 |
| SMS OTP | pay-as-you-go (20 مستخدم بيتا ≈ 20-40 رسالة) | $1-3 مرة واحدة |
| OpenRouter credits | $10 لمرة واحدة لفتح 1000 rpd (اختياري لكنه ضروري للبيتا العملية) | $10 one-time |
| Haiku | ضمن حصص 2000 وحدة | $0.2-6 |
| **Total** | | **≈ $9-17/شهر + $10 مرة واحدة** |

**لا تشغّل 1 vCPU/1 GB كبيئة بناء**: ابْنِ محليًا أو على CI (لا يوجد CI بعد) ثم انقل؛ أو استخدم swap 2 GB واقبل بطء البناء. التشغيل + worker + WAL على 1 GB ممكن لكن هامش الذاكرة ضيق (MemoryMax 768M لـweb).

## 6. متى نغادر SQLite / Growth triggers (assumptions)

| Trigger | Threshold | Action |
| --- | --- | --- |
| مقارنات يومية | > 300/يوم (≈1000 طلب OpenRouter) | رصيد OpenRouter أو توزيع حسابات؛ تبقى SQLite كافية |
| حجم DB | > 2 GB أو كتابة/ثانية عالية | مراجعة retention (غير منفّذ) ثم Postgres + طابور خارجي (عمل تطويري) |
| مستخدمون متزامنون | > 50 أو p95 > 10s | 2 vCPU أولًا، ثم فصل web/worker، ثم Postgres |
| نسخ احتياطي | نسخة > 1 GB أو نافذة نسخ > دقيقة | btrfs snapshot/ساعة توقف قصيرة/Postgres PITR |
| حاجة تعدد خوادم | أي حاجة أفقية | SQLite غير صالح — يلزم Postgres (تغيير معماري موثّق في `docs/architecture.md:9-11`) |

## 7. ما لم يُتحقق / Not verified

- الأسعار أعلاه تقديرات سوقية، لم تُطلب عروض أسعار رسمية من مزودي VPS/SMS/البريد.
- لم تُجرَّب فاتورة Haiku حقيقية؛ الرياضيات مبنية على أسعار الوثائق الرسمية المقروءة في `docs/haiku-5-5-addendum.md` (نفس المصدر الذي يستخدمه الكود).
- لا قياس استهلاك ذاكرة فعلي لـNext 16 على 1/2 GB (لا خادم)؛ التوصية 2 GB مبنية على حجم البناء والتشغيل المعتاد.
- لا تكلفة استشارة قانونية/محاسبية مُقدَّرة؛ تُضاف في ميزانية الإطلاق المدفوع.
