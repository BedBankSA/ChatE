# سجل نماذج OpenRouter المجانية

**checkedAt:** 2026-10-27

هذا السجل يثبّت معرفات الطبقة المجانية التي سمّاها المالك، كما ظهرت في وثائق OpenRouter الحالية وفي الفهرس الحي في هذا التاريخ. المعرفات اللاتينية تبقى كما هي. الإدراج في هذا الملف ليس تفعيلًا عامًا في المنتج، ولا يستبدل اختيار المستخدم بنموذج آخر.

لم يُرسل أي طلب chat completion، ولا embeddings، ولا rerank، ولا speech، ولا decisions. القراءة اقتصرت على وثائق OpenRouter وعلى `GET` لبيانات النماذج ونقاط النهاية.

## المصادر المقروءة

1. [Quickstart](https://openrouter.ai/docs/quickstart.md) — الاستدعاء النصي هو `POST https://openrouter.ai/api/v1/chat/completions`.
2. [List all models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md) — `GET https://openrouter.ai/api/v1/models`. القيمة الافتراضية لمعامل `output_modalities` هي `text`. القيمة `all` تشمل text وembeddings وrerank وspeech وdecisions وغيرها.
3. طلب القراءة `GET https://openrouter.ai/api/v1/models?output_modalities=all` أعاد HTTP 200. الجسم فيه `total_count=690` و`data` بطول 690 و`links.next` فارغ. المفتاح وُضع في ترويسة Authorization فقط، ولم تُسجَّل الترويسة.
4. [List all embeddings models](https://openrouter.ai/docs/api/api-reference/embeddings/list-all-embeddings-models.md) — `GET https://openrouter.ai/api/v1/embeddings/models` أعاد HTTP 200 و`total_count=38`.
5. [List all endpoints for a model](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md) — `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`. كل المعرفات أدناه أعادت HTTP 200.
6. [Free Variant](https://openrouter.ai/docs/guides/routing/model-variants/free.md) — اللاحقة `:free` مدخل مستقل في الفهرس. الوثيقة تقول إن الحدود أو الإتاحة قد تختلف عن النسخة المدفوعة، وإن وضع نموذج مدفوع في مصفوفة fallback بعد نموذج `:free` يُحاسب بسعر النموذج المدفوع.
7. [Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router.md) — `openrouter/free` موجّه، وحقل `model` في استجابة chat completions يسمّي النموذج الذي خُدمت به الاستجابة.
8. [Submit an embedding request](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request.md) — `POST /embeddings` على الخادم `https://openrouter.ai/api/v1`.
9. [Submit a rerank request](https://openrouter.ai/docs/api/api-reference/rerank/submit-a-rerank-request.md) — `POST /rerank` على الخادم نفسه.
10. [Text-to-Speech](https://openrouter.ai/docs/guides/overview/multimodal/tts.md) و[Create speech](https://openrouter.ai/docs/api/api-reference/tts/create-speech.md) — `POST https://openrouter.ai/api/v1/audio/speech` عندما تكون مخرجات النموذج `speech`.
11. [Jev tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial.md) يعرض `POST https://openrouter.ai/api/alpha/decisions`. مرجع OpenAPI يسمّي المسار `/api/alpha/decisions` ويضع خادم العملية على `https://openrouter.ai`، والوسم `alpha.decisions` وصفُه «Alpha feature endpoints for Decisions requests». الدليل يقول إن نماذج decisions الأخرى تأخذ الطلب نفسه.
12. [Limits](https://openrouter.ai/docs/api-reference/limits.md) — حدود طلبات متغيرات `:free` على مستوى المنصة.
13. صفحة كل نموذج على `https://openrouter.ai/{id}`. وصف الفهرس البرمجي مقصوص بنقاط `...` عند نحو 200 حرف. النص الكامل للوصف ولحقل `warning_message` ولـ `dataPolicy` مأخوذ من حمولة صفحة النموذج.

حقل اسمه `family` غير موجود في كائن النموذج. ما يُسجَّل تحت family هو `group` من صفحة النموذج و`architecture.tokenizer` من الفهرس، ومعهما منظمة مقطع المعرف. مخطط `EndpointStatus` في مرجع نقاط النهاية يعدّد `0` و`-1` و`-2` و`-3` و`-5` و`-10` بلا شرح نصي في الصفحة المقروءة. معنى هذه الأرقام يُترك كما هو.

السعر في الفهرس لكل المعرفات أدناه: `pricing.prompt=0` و`pricing.completion=0`. نقطة النهاية، حين وُجدت، أضافت `discount=0`.

## طريقة الاستدعاء حسب صنف المخرج

المخرج هو `architecture.output_modalities` من الفهرس، لا الدور الذي سُمّي به النموذج قبل الفحص.

| المخرج | الاستدعاء |
| --- | --- |
| `text` | `POST https://openrouter.ai/api/v1/chat/completions` |
| `embeddings` | `POST https://openrouter.ai/api/v1/embeddings` |
| `rerank` | `POST https://openrouter.ai/api/v1/rerank` |
| `decisions` | `POST https://openrouter.ai/api/alpha/decisions` |
| `speech` | `POST https://openrouter.ai/api/v1/audio/speech` |

`nvidia/nemotron-3.5-content-safety:free` مخرجه `text`، فاستدعاؤه chat completions. `respan/span-01-lite:free` مخرجه `decisions`، فاستدعاؤه واجهة Decisions. لم يُذكر في الوثائق المقروءة مسار تصنيف مستقل لهذين المعرفين.

## حدود المنصة لمتغيرات `:free`

صفحة [Limits](https://openrouter.ai/docs/api-reference/limits.md) تقول إن معرفًا ينتهي بـ `:free` يخضع لهذا الجدول، بحسب كل الاعتمادات المشتراة على الحساب:

| الاعتمادات المشتراة | طلب في الدقيقة | طلب في اليوم |
| --- | --- | --- |
| أقل من 10 | 20 | 50 |
| 10 على الأقل | 20 | 1000 |

الصفحة تقول أيضًا إن بعض الحسابات وبعض نقاط النهاية وطلبات BYOK معفاة من هذا البوابة، بلا تسمية النماذج في هذا السجل. جملة في الصفحة تعرض العنصر النائب `{FREE_MODEL_CREDITS_THRESHOLD - 1}` كما هو؛ لم يُستبدل برقم. صفحات النماذج تقول إن النقاط المجانية محدودة المعدل وتحيل إلى وثيقة الحدود. بعض الصفحات تعرض `limit_rpm=0` و`limit_rpd=0`. معنى الصفر غير مذكور في المصدر المقروء، ولا يُقرأ هنا على أنه إلغاء لجدول المنصة.

## تحذير NVIDIA المجاني المشترك

هذا النص ظهر في `warning_message` لصفحات النقاط المجانية من NVIDIA المذكورة تحته، مع اختلاف طفيف في علامات روابط Markdown. النص لا يحتوي جملة «Do not use for production». تلك الجملة ظهرت فقط في تحذير `nvidia/llama-nemotron-embed-vl-1b-v2:free` في قسم الاستبعاد.

> For the free endpoint, please do not upload any confidential information or personal data (such as voices or faces of people). Your use is logged for security purposes and to improve NVIDIA products and services. The logged session data for improvement purposes is not linked to your identity or any persistent identifier. For more information about NVIDIA's data processing practices, see Privacy Policy. By using this free endpoint, you consent to NVIDIA's collection, recording, and use of such information and the NVIDIA API Trial Terms of Service.

الروابط في الصفحة: [Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/) و[NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).

`dataPolicy` المرافقة لهذه النقاط، ما لم يُذكر اختلاف: `training=true`، `trainingOpenRouter=false`، `retainsPrompts=true`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=true`، و`termsOfServiceURL` هو ملف شروط التجربة أعلاه.

## قواعد السجل

- `google/gemma-4-31b-it:free` و`google/gemma-4-26b-a4b-it:free` حجمان مختلفان. ليسا نسخة قديمة وجديدة من النموذج نفسه. الوصف يفرق كثيفًا 30.7B عن MoE بمجموع 25.2B و3.8B نشطة.
- `thinkingmachines/inkling:free` و`thinkingmachines/inkling-small:free` حجمان مختلفان. الوصف يسمي Small العضو الأصغر: 12B نشطة من 276B، مقابل 41B نشطة من 975B.
- `baseten/mammoth-1:free` و`baseten/elephant-1:free` بديلان مختلفان. الوصف يسمي Mammoth الأخ الأكبر بـ 27B وElephant الأخ الأصغر بـ 9B.
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` يبقى. وجود Super VL لا يسقطه. مدخلات Nano Omni تشمل `audio`، ومدخلات Super VL لا تشملها.
- `nvidia/nemotron-3-ultra-550b-a55b:free` يبقى. الرقم 3 في الاسم لا يسقطه أمام أسماء 3.5.
- لا يُستبدل معرف بآخر لأن الاسم قريب. المعرف الغائب يبقى في السجل بحالة «غير متاح» ويُذكر ما لوحظ. في هذا الفحص لم يغب أي معرف من القائمة.
- الإدراج هنا ليس تفعيلًا عامًا. حدود حزام Inkling وحدود تجربة NVIDIA تُذكر لأن صفحة النموذج قالتها.
- Claude Haiku 5.5 خارج هذا السجل. مساره `docs/haiku-5-5-addendum.md`، والمزود Anthropic مباشرة، ولا يُدمج في الطبقة المجانية.

قاعدة الحالة في هذا الملف:

- **متاح:** المعرف في الفهرس، ونقطة `:free` موجودة، وسعرها 0، ورمز الحالة `0`، ولا يوجد تحذير أو وصف يقصر الاستخدام على التجربة أو على حزام وكيل أو على عرض تجريبي، ولا يقول الوصف إن الطلبات تُستخدم لتدريب النموذج. سياسة الاحتفاظ أو شروط المزود تبقى مكتوبة في `usagePolicy`.
- **مقيد بشروط المزود:** الصفحة أو الوصف يقيّد الاستخدام (تجربة API، حزام وكيل، عرض تجريبي، بلا ضمان إنتاج، أو استخدام الطلبات للتدريب).
- **تجريبي داخلي:** لم تُستخدم. وسم `alpha.decisions` يصف واجهة عامة في الدليل، لا تجربة داخلية مغلقة.
- **غير متاح:** المعرف غاب عن الفهرس، أو نقطة النهاية المجانية غابت. لم ينطبق ذلك على معرفات الاختيارات الـ 21.

## 1. إجابات ومحادثة وبرمجة

### 1. `google/gemma-4-31b-it:free`

- **displayName:** Google: Gemma 4 31B (free)
- **family:** حقل family غير موجود. `group=Gemma`. `architecture.tokenizer=Gemma`. منظمة المعرف: `google`.
- **taskType:** محادثة افتراضية. المخرج `text`.
- **inputModalities:** `image`, `text`, `video`
- **outputModalities:** `text`
- **contextLimits:** `context_length=262144`. `max_completion_tokens=32768`. `max_prompt_tokens=null`. الوصف يقول نافذة 256K، وهذا يطابق 262144.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** متاح
- **usagePolicy:** `warning_message` فارغ. `dataPolicy`: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=true`، `retentionDays=55`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=true`. الشروط `https://cloud.google.com/terms/` والخصوصية `https://cloud.google.com/terms/cloud-privacy-notice`. المزود في endpoints: Google AI Studio. `top_provider.is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=google/gemma-4-31b-it-20260402`. `hugging_face_id=google/gemma-4-31B-it`. الوصف: نموذج كثيف 30.7B متعدد الوسائط، نافذة 256K، تفكير قابل للضبط، استدعاء دوال، وأكثر من 140 لغة، وApache 2.0. الوصف يذكر نصًا وصورة. مصفوفة الفهرس تذكر `video` أيضًا. `default_parameters`: `temperature=1`، `top_k=64`، `top_p=0.95`.

### 2. `recursive/flint-v1.0:free`

- **displayName:** Recursive: Flint (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `recursive`.
- **taskType:** اختصار البرمجة. المخرج `text`.
- **inputModalities:** `text`
- **outputModalities:** `text`
- **contextLimits:** `context_length=262144`. `max_completion_tokens=235929`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** متاح
- **usagePolicy:** `warning_message=null`. `dataPolicy`: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=true`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=false`. `retentionDays` لم يظهر في الكائن المقروء. الشروط `https://recursive.com/legal/terms-of-use` والخصوصية `https://recursive.com/legal/privacy-policy`. المزود: Recursive. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=recursive/flint-v1.0-20261021`. `hugging_face_id=RecursiveSI/flint`. الوصف: MoE مفتوح، نحو 2.5B نشطة من 40B، مبني بنظام Eureka Machine لوكلاء البرمجة: فحص المستودعات وإصلاح الأعطال وتنفيذ الميزات وكتابة الاختبارات.

### 3. `google/gemma-4-26b-a4b-it:free`

- **displayName:** Google: Gemma 4 26B A4B  (free)
- **family:** حقل family غير موجود. `group=Gemma`. `architecture.tokenizer=Gemma`. منظمة المعرف: `google`. هذا حجم مختلف عن Gemma 4 31B، لا إصدار لاحق منه.
- **taskType:** اختصار سريع. المخرج `text`.
- **inputModalities:** `image`, `text`, `video`
- **outputModalities:** `text`
- **contextLimits:** `context_length=262144`. `max_completion_tokens=32768`. `max_prompt_tokens=null`. الوصف يقول نافذة 256K.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** متاح
- **usagePolicy:** `warning_message` فارغ. `dataPolicy` كـ Gemma 31B: `training=false`، `retainsPrompts=true`، `retentionDays=55`، `requiresUserIDs=true`، والشروط `https://cloud.google.com/terms/`. المزود: Google AI Studio. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=google/gemma-4-26b-a4b-it-20260403`. `hugging_face_id=google/gemma-4-26B-A4B-it`. الوصف: MoE، 25.2B مجموعًا و3.8B نشطة لكل رمز، مدخلات نص وصور وفيديو حتى 60 ثانية بمعدل إطار في الثانية، تفكير قابل للضبط، Apache 2.0. `default_parameters`: `temperature=1`، `top_k=64`، `top_p=0.95`.

### 4. `xingchen-agi/xing4.0-29b-a4b:free`

- **displayName:** XingChen: Xing4.0 29B A4B (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `xingchen-agi`.
- **taskType:** إجابة نصية. المخرج `text`.
- **inputModalities:** `text`
- **outputModalities:** `text`
- **contextLimits:** `context_length=262144`. `max_completion_tokens=235929`. `max_prompt_tokens=null`. الوصف يقول نافذة 256K أصلية.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** متاح
- **usagePolicy:** `warning_message=null`. المزود في endpoints وفي صفحة النموذج: Phala. `dataPolicy` على تلك النقطة: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=false`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=false`. `termsOfServiceURL=https://redpill.ai/terms` و`privacyPolicyURL=https://redpill.ai/privacy`. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=xingchen-agi/xing4.0-29b-a4b-20261015`. `hugging_face_id=XingChen-AGI/Xing4.0-29B-A4B`. الوصف: MoE من TeleAI، خليفة TeleChat، 29B مجموعًا و4B نشطة، تفكير يعمل افتراضيًا ويمكن إيقافه. `default_parameters`: `repetition_penalty=1.05`، `temperature=1`، `top_p=0.95`.

### 5. `nvidia/nemotron-3.5-super-vl:free`

- **displayName:** NVIDIA: Nemotron 3.5 Super VL (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`. الوصف لا يقول عبارة «Nemotron family».
- **taskType:** إجابة متعددة الوسائط. المخرج `text`. مدخلاته بلا `audio`.
- **inputModalities:** `text`, `image`, `video`
- **outputModalities:** `text`
- **contextLimits:** `context_length=1000000`. `max_completion_tokens=131072`. `max_prompt_tokens=868928`. الوصف يقول سياق 1M.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك أعلاه، مع الموافقة على NVIDIA API Trial Terms. `dataPolicy.training=true` و`retainsPrompts=true` و`requiresUserIDs=true`. المزود: Nvidia. `is_moderated=false`. رمز الحالة `0`. الصفحة تعرض `limit_rpm=0` و`limit_rpd=0` بلا شرح لمعناهما.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3.5-super-vl-20261015`. `hugging_face_id=nvidia/NVIDIA-Nemotron-3.5-Super-VL`. الوصف: 12B نشطة من 120B، نص وصور ومستندات ولقطات واجهة وفيديو إلى نص. التفكير يعمل افتراضيًا ويمكن إيقافه أو تحديد ميزانيته. مصفوفة الوسائط في الفهرس هي `text,image,video` ولا تذكر `file`.

### 6. `nvidia/nemotron-3.5-lightning:free`

- **displayName:** NVIDIA: Nemotron 3.5 Lightning (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** إجابة نصية. المخرج `text`.
- **inputModalities:** `text`
- **outputModalities:** `text`
- **contextLimits:** `context_length=1000000`. `max_completion_tokens=65536`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. المزود: Nvidia، الوسم `nvidia/nvfp4`. `is_moderated=false`. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3.5-lightning-20260807`. `hugging_face_id=nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`. الوصف: 3B نشطة من 30B، لأعمال وكيلة عالية الإنتاجية ومهام متخصصة.

### 7. `thinkingmachines/inkling:free`

- **displayName:** Thinking Machines: Inkling (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `thinkingmachines`. الوصف يتحدث عن Inkling Small بوصفه عضوًا أصغر في المجموعة نفسها؛ الحجمان مدخلان منفصلان.
- **taskType:** إجابة متعددة الوسائط. المخرج `text`.
- **inputModalities:** `text`, `image`, `audio`
- **outputModalities:** `text`
- **contextLimits:** `context_length=1048576`. `max_completion_tokens=262144`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** تحذير الصفحة: «The free Inkling endpoint is only available for use with agentic harnesses.» ويمنع رفع معلومات سرية أو بيانات شخصية، ويقول إن المطالبات والمخرجات تُسجَّل لتحسين نماذج Thinking Machines Lab بعد فصلها عن الحساب. الموافقة على [TML Free Research API Terms of Service](https://thinkingmachines.ai/legal/tml-free-research-api-tier-terms-of-service.pdf) و[Privacy Notice](https://thinkingmachines.ai/legal/tml-free-research-api-tier-privacy-notice.pdf). `dataPolicy`: `training=true`، `trainingOpenRouter=true`، `retainsPrompts=true`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=true`. المزود: Thinking Machines. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=thinkingmachines/inkling-20260715`. `hugging_face_id=thinkingmachines/Inkling`. الوصف: 41B نشطة من 975B، للاستدلال والبرمجة والأنظمة الوكيلة واسترجاع المعرفة. `is_moderated=false`.

### 8. `thinkingmachines/inkling-small:free`

- **displayName:** Thinking Machines: Inkling Small (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `thinkingmachines`. حجم مختلف عن Inkling، والوصف يسميه العضو الأصغر.
- **taskType:** إجابة متعددة الوسائط. المخرج `text`.
- **inputModalities:** `text`, `image`, `audio`
- **outputModalities:** `text`
- **contextLimits:** `context_length=1048576`. `max_completion_tokens=262144`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** تحذير الصفحة: «The free Inkling Small endpoint is only available for use with agentic harnesses.» بقية التحذير وشروط TML Free Research API و`dataPolicy` (`training=true`، `trainingOpenRouter=true`، `retainsPrompts=true`، `requiresUserIDs=true`) كالمدخل السابق، مع استبدال اسم النموذج. المزود: Thinking Machines. رمز الحالة `0`. `limit_rpm` لم يظهر في النافذة المقروءة لهذا المعرف.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=thinkingmachines/inkling-small-20260730`. `hugging_face_id=thinkingmachines/Inkling-Small`. الوصف: 12B نشطة من 276B.

### 9. `cohere/north-mini-code:free`

- **displayName:** Cohere: North Mini Code (free)
- **family:** حقل family غير موجود. `group=Cohere`. `architecture.tokenizer=Cohere`. منظمة المعرف: `cohere`. الوصف يقول إن هذا أول نموذج برمجة وكيل من Cohere وبداية عائلة North.
- **taskType:** إجابة برمجية. المخرج `text`.
- **inputModalities:** `text`
- **outputModalities:** `text`
- **contextLimits:** `context_length=256000`. `max_completion_tokens=64000`. `max_prompt_tokens=null`. الوصف يقول 256K سياقًا وحتى 64K مخرجًا.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** متاح
- **usagePolicy:** `warning_message=null`. جملة الوصف عن التعميم عبر أحزمة الوكلاء مثل OpenCode وSWE-Agent تصف التدريب، ولا تقول إن النقطة المجانية متاحة فقط داخل حزام. `dataPolicy`: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=true`، `retentionDays=30`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=false`. الشروط `https://cohere.com/terms-of-use` والخصوصية `https://cohere.com/privacy`. المزود: Cohere. `is_moderated=true`. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=cohere/north-mini-code-20260617`. `hugging_face_id=CohereLabs/North-Mini-Code-1.0`. الوصف: MoE، 30B مجموعًا و3B نشطة، Apache 2.0.

### 10. `nvidia/nemotron-3-ultra-550b-a55b:free`

- **displayName:** NVIDIA: Nemotron 3 Ultra (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`. الوصف يقول: «part of the NVIDIA Nemotron family of open models for agentic AI». الاسم يحمل 3، وهو مدخل مستقل عن أسماء 3.5.
- **taskType:** إجابة نصية. المخرج `text`.
- **inputModalities:** `text`
- **outputModalities:** `text`
- **contextLimits:** `context_length=1000000`. `max_completion_tokens=65536`. `max_prompt_tokens=null`. الوصف يقول حتى 1M.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. المزود: Nvidia. `is_moderated=false`. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3-ultra-550b-a55b-20260604`. `hugging_face_id=nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16`. الوصف: 55B نشطة من 550B. `default_parameters`: `temperature=1`، `top_p=0.95`.

### 11. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`

- **displayName:** NVIDIA: Nemotron 3 Nano Omni (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** إجابة متعددة الوسائط تشمل الصوت كمدخل. المخرج `text`، وهذا ليس مسار speech.
- **inputModalities:** `text`, `audio`, `image`, `video`
- **outputModalities:** `text`
- **contextLimits:** الفهرس ونقطة النهاية: `context_length=256000` و`max_completion_tokens=65536` و`max_prompt_tokens=null`. الوصف في الصفحة يقول «up to 300K context length» و«a 16,384 reasoning budget». الرقمان مذكوران كما وردا في مصدر كل منهما، ولم يُستبدل أحدهما بالآخر.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. المزود: Nvidia. `is_moderated=false`. رمز الحالة في endpoints هو `-5`. معنى `-5` غير مذكور في مخطط EndpointStatus المقروء. النقطة نفسها موجودة وسعرها 0. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-20260428`. `hugging_face_id=nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16`. الوصف: 30B-A3B، يقبل نصًا وصورة وفيديو وصوتًا ويخرج نصًا، والتفكير الممتد عبر `reasoning.enabled`. `default_parameters`: `temperature=0.6`، `top_p=0.95`.

### 12. `liquid/lfm-2.5-2.6b:free`

- **displayName:** LiquidAI: LFM2.5-2.6B (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `liquid`.
- **taskType:** إجابة نصية. المخرج `text`.
- **inputModalities:** `text`
- **outputModalities:** `text`
- **contextLimits:** `context_length=65536`. `max_completion_tokens=8192`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** `warning_message=null`. الوصف يقول: «Liquid advises against using it for agentic coding or knowledge-heavy tasks» و«Prompts and outputs may be retained and used to train Liquid models». `dataPolicy`: `training=true`، `trainingOpenRouter=false`، `retainsPrompts=true`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=true`. الشروط `https://www.liquid.ai/terms-conditions` والخصوصية `https://www.liquid.ai/privacy-policy`. المزود: Liquid. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=liquid/lfm-2.5-2.6b-20260811`. `hugging_face_id=LiquidAI/LFM2.5-2.6B`. `default_parameters`: `repetition_penalty=1.1`، `temperature=0.1`، `top_k=50`.

## 2. التضمين

شرط المالك للتضمين الافتراضي: `nvidia/nemotron-3.5-embed-1b:free` يكون الافتراضي إذا سمحت سياسة النقطة بالاستخدام الإنتاجي. الصفحة لا تقول إن الاستخدام الإنتاجي مسموح. التحذير يشترط شروط NVIDIA API Trial، و`dataPolicy.training=true`. لذلك لا يُسجَّل هذا المعرف هنا بوصفه افتراضي إنتاج. يبقى في السجل بهويته للمقارنة وللحالة المقيدة. لا يُستبدل بمعرف أقدم.

### 13. `nvidia/nemotron-3.5-embed-1b:free`

- **displayName:** NVIDIA: Nemotron 3.5 Embed 1B (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** تضمين. مرشح افتراضي معلّق على سياسة الإنتاج، والسياسة المقروءة لا تمنحه هذا الوضع.
- **inputModalities:** `text`, `image`
- **outputModalities:** `embeddings`
- **contextLimits:** `context_length=32768`. `max_completion_tokens=29491`. `max_prompt_tokens=null`. صفحة النموذج تقول حتى 32,768 رمزًا للمدخل.
- **endpointType:** `POST https://openrouter.ai/api/v1/embeddings`. ظهر هذا المسار أيضًا في صفحة النموذج لهذا المعرف. المعرف موجود كذلك في `GET /api/v1/embeddings/models`.
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true` و`retainsPrompts=true`. المزود: Nvidia، الوسم `nvidia/bf16`. `is_moderated=false`. رمز الحالة `0`. `hugging_face_id` فارغ.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3.5-embed-1b-20261021`. الوصف: استرجاع متعدد اللغات على النص وصور صفحات المستندات، والاستعلام نص، والمستند نص أو صورة أو كلاهما. المتجهات 2048 بُعدًا ويمكن قطعها، وتشارك فضاء النص مع Nemotron 3 Embed 1B.

### 14. `nvidia/nemotron-3.5-embed-8b:free`

- **displayName:** NVIDIA: Nemotron 3.5 Embed 8B (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** تضمين لمقارنة جودة الاسترجاع، لا بديل صامت عن 1B.
- **inputModalities:** `text`, `image`
- **outputModalities:** `embeddings`
- **contextLimits:** `context_length=32768`. `max_completion_tokens=29491`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/embeddings`. المعرف موجود في `GET /api/v1/embeddings/models`.
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. المزود: Nvidia، الوسم `nvidia/bf16`. رمز الحالة `-2`. معنى `-2` غير مذكور في مخطط EndpointStatus المقروء. النقطة موجودة وسعرها 0. `hugging_face_id` فارغ. `is_moderated=false`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3.5-embed-8b-20261021`. الوصف: كـ 1B، والمتجهات 4096 بُعدًا ويمكن قطعها، وتشارك فضاء النص مع Nemotron 3 Embed 8B.

### 15. `liquid/lfm-2.5-embedding-350m:free`

- **displayName:** LiquidAI: LFM2.5-Embedding-350M (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `liquid`.
- **taskType:** تضمين نصي.
- **inputModalities:** `text`
- **outputModalities:** `embeddings`
- **contextLimits:** `context_length=512`. `max_completion_tokens=460`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/embeddings`. المعرف موجود في `GET /api/v1/embeddings/models`.
- **availability:** مقيد بشروط المزود
- **usagePolicy:** `warning_message=null`. الوصف يقول: «Successful OpenRouter requests and embeddings may be retained and used to train Liquid models.» `dataPolicy`: `training=true`، `retainsPrompts=true`، `requiresUserIDs=true`، والشروط `https://www.liquid.ai/terms-conditions`. المزود: Liquid. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=liquid/lfm-2.5-embedding-350m-20260818`. `hugging_face_id=LiquidAI/LFM2.5-Embedding-350M`. الوصف: متجهات بألف وأربعة وعشرين بُعدًا للاسترجاع والبحث الدلالي.

## 3. إعادة الترتيب

### 16. `nvidia/nemotron-3.5-rerank-8b:free`

- **displayName:** NVIDIA: Nemotron 3.5 Rerank 8B (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** إعادة ترتيب. المخرج `rerank`.
- **inputModalities:** `text`, `image`
- **outputModalities:** `rerank`
- **contextLimits:** `context_length=32768`. `max_completion_tokens=29491`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/rerank`. هذا المعرف ليس في قائمة embeddings.
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. حقل `description` فارغ في الفهرس وفي صفحة النموذج. قدرة النموذج التفصيلية لم تُذكر في المصدر الرسمي المقروء خارج الاسم والوسائط والسياق والتحذير. المزود: Nvidia، الوسم `nvidia/bf16`. `hugging_face_id` فارغ. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3.5-rerank-8b-20261021`.

## 4. القرار

الاستدعاء الثلاثة التالية هو واجهة Decisions لأن المخرج `decisions`. الوسم في OpenAPI هو Alpha، والدليل يعرض الطلب بمفتاح OpenRouter بلا قائمة انتظار. هذا ليس وسم «تجريبي داخلي».

### 17. `baseten/mammoth-1:free`

- **displayName:** Baseten: Mammoth 1 (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `baseten`.
- **taskType:** قرار. بديل مختلف عن Elephant، والوصف يسميه الأخ الأكبر.
- **inputModalities:** `text`
- **outputModalities:** `decisions`
- **contextLimits:** `context_length=16384`. `max_completion_tokens=14745`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/alpha/decisions`
- **availability:** متاح
- **usagePolicy:** `warning_message=null`. `dataPolicy`: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=false`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=false`. الشروط `https://www.baseten.co/terms-and-conditions` والخصوصية `https://www.baseten.co/privacy-policy`. المزود: BaseTen. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=baseten/mammoth-1-20261021`. `hugging_face_id=baselabs/mammoth-1`. الوصف: نموذج قرار 27B من Base Labs مبني على Qwen3.5-27B، يعيد احتمالًا لكل خيار بلا توليد نص، ومتوافق مع TypeSafe System One.

### 18. `baseten/elephant-1:free`

- **displayName:** Baseten: Elephant 1 (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `baseten`.
- **taskType:** قرار. بديل مختلف عن Mammoth، والوصف يسميه الأخ الأصغر.
- **inputModalities:** `text`
- **outputModalities:** `decisions`
- **contextLimits:** `context_length=16384`. `max_completion_tokens=14745`. `max_prompt_tokens=null`.
- **endpointType:** `POST https://openrouter.ai/api/alpha/decisions`
- **availability:** متاح
- **usagePolicy:** `warning_message=null`. `dataPolicy` كـ Mammoth: `training=false`، `retainsPrompts=false`، `requiresUserIDs=false`، وشروط Baseten. المزود: BaseTen. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=baseten/elephant-1-20261021`. `hugging_face_id=baselabs/elephant-1`. الوصف: نموذج قرار 9B مبني على Qwen3.5-9B.

## 5. تقييم وتصنيف

### 19. `respan/span-01-lite:free`

- **displayName:** Respan: Span-01 Lite (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `respan`.
- **taskType:** تقييم سلوك. المخرج `decisions`، لذلك الاستدعاء ليس chat completions.
- **inputModalities:** `text`
- **outputModalities:** `decisions`
- **contextLimits:** `context_length=0`. `max_completion_tokens=0`. `max_prompt_tokens=null`. تفسير القيمة 0 لم يُذكر في المصدر الرسمي المقروء.
- **endpointType:** `POST https://openrouter.ai/api/alpha/decisions`
- **availability:** متاح
- **usagePolicy:** `warning_message=null`. `dataPolicy`: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=true`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=false`. `retentionDays` لم يظهر في الكائن المقروء. الشروط `https://respan.ai/legal/terms-of-use` والخصوصية `https://respan.ai/legal/privacy-policy`. المزود: Respan. `hugging_face_id` فارغ. `is_moderated=false`. رمز الحالة `0`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=respan/span-01-lite-20260925`. الوصف: طبقة أخف مجانية من Span-01، تعيد لكل سلوك يُعرَّف بلغة عادية احتمال وجوده في مقطع محادثة.

### 20. `nvidia/nemotron-3.5-content-safety:free`

- **displayName:** NVIDIA: Nemotron 3.5 Content Safety (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`. الوصف يقول إنه منضبط انطلاقًا من Gemma-3-4B، و«part of the NVIDIA Nemotron family». هذا لا يجعله Gemma 4 31B ولا Gemma 4 26B.
- **taskType:** تصنيف سلامة. المخرج `text`، لذلك الاستدعاء chat completions.
- **inputModalities:** `text`, `image`
- **outputModalities:** `text`
- **contextLimits:** `context_length=128000`. `max_completion_tokens=8192`. `max_prompt_tokens=null`. الوصف يقول حتى 128K و12 لغة.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** تحذير هذه الصفحة مختلف عن النص المشترك: «Please do not upload any confidential information. You may upload images, which we and our service providers will use for the sole purpose of providing you with this demo experience. Your use is logged for security purposes and anonymous session data may be used to improve NVIDIA products and services, including network performance metrics, AI-generated outputs, and audio transcriptions. The logged session data for improvement purposes is not linked to your identity or any persistent identifier. For more information about our data processing practices, see our Privacy Policy. By uploading the file, you consent to our collection, recording, and use of such information and the NVIDIA API Trial Terms of Service.» `dataPolicy.training=true` و`retainsPrompts=true` و`requiresUserIDs=true`، وملف الشروط هو ملف التجربة نفسه. المزود: Nvidia. `is_moderated=false`. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3.5-content-safety-20260604`. `hugging_face_id=nvidia/Nemotron-3.5-Content-Safety`. الوصف: حارس 4B، يصنّف المدخل والاستجابة إلى safe/unsafe مع تسميات وسلسلة تفكير اختيارية.

## 6. الكلام

### 21. `fish-audio/s2.1-pro-free:free`

- **displayName:** Fish Audio: S2.1 Pro Free (free)
- **family:** حقل family غير موجود. `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `fish-audio`.
- **taskType:** تحويل نص إلى كلام فقط. ليس نموذج إجابة.
- **inputModalities:** `text`
- **outputModalities:** `speech`
- **contextLimits:** `context_length=0`. `max_completion_tokens=0`. `max_prompt_tokens=null`. تفسير القيمة 0 لم يُذكر في المصدر الرسمي المقروء. `supported_voices=null`.
- **endpointType:** `POST https://openrouter.ai/api/v1/audio/speech`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** `warning_message=null`. الوصف يقول إن هذه النسخة بلا تكلفة مخصصة للاختبار والنماذج الأولية والاستخدام منخفض الحجم، وتقدم قدرات التوليف نفسها «without production latency or availability guarantees». `dataPolicy`: `training=false`، `trainingOpenRouter=false`، `retainsPrompts=false`، `canPublish=false`، `safetyRetention=false`، `requiresUserIDs=false`. الشروط `https://fish.audio/terms` والخصوصية `https://fish.audio/privacy`. المزود: Fish Audio. `hugging_face_id` فارغ. `is_moderated=false`. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=fish-audio/s2.1-pro-free-20260729`. دليل TTS يقول إن نماذج Fish Audio غير S1 تقبل إدخالًا متعدد المتحدثين، وإن تعليمات الأداء تُضاف بين أقواس مربعة. هذا المعرف هو S2.1 Pro Free. علم `supports_voice_cloning` لهذه النقطة لم يُستخرج في ملخص الفحص، لذلك لم يُذكر في المصدر الرسمي المقروء هنا كقيمة مؤكدة لهذا المعرف.

## الموجّه الاختياري

هذا الموجّه خارج المقارنة المضبوطة. لا يحل محل نموذج اختاره المستخدم.

### `openrouter/free`

- **displayName:** Free Models Router
- **family:** حقل family غير موجود. `group=Router`. `architecture.tokenizer=Router`. منظمة المعرف: `openrouter`.
- **taskType:** موجّه مجاني يختار نموذجًا مجانيًا عشوائيًا بعد تصفية القدرات التي يطلبها الطلب.
- **inputModalities:** `text`, `image`
- **outputModalities:** `text`
- **contextLimits:** `context_length=200000`. `top_provider.context_length` و`max_completion_tokens` فارغان في الفهرس. `max_prompt_tokens` غير منطبق لأن قائمة النقاط فارغة.
- **endpointType:** `POST https://openrouter.ai/api/v1/chat/completions` مع `"model": "openrouter/free"`. دليل الموجّه يقول إن حقل `model` في الاستجابة هو معرف النموذج الذي خُدمت به. هذا الفحص لم يرسل chat completion، لذلك لا يوجد معرف حي مُعاد من استجابة. المثال `upstage/solar-pro-3:free` في الدليل مثال وثائقي، وليس نتيجة هذا الحساب.
- **availability:** متاح كموجّه في الفهرس وفي الدليل. `GET` لنقاط النهاية أعاد HTTP 200 ومصفوفة `endpoints` فارغة (`count=0`). لا توجد نقطة مزود خاصة به. هذا ليس استبدالًا صامتًا لنموذج مختار.
- **usagePolicy:** وصف الصفحة: يختار من النماذج المجانية المتاحة ويصفّي حسب قدرات الطلب كفهم الصور واستدعاء الأدوات والمخرجات المهيكلة. `warning_message` فارغ. `dataPolicy` المقروء: `training=false`، `canPublish=false`، `requiresUserIDs=false`. بقية مفاتيح dataPolicy لم تظهر في الكائن المقروء. `canonical_slug=openrouter/free`. `hugging_face_id` فارغ. السعر `prompt=0` و`completion=0`.
- **checkedAt:** 2026-10-27

وثيقة المتغير المجاني تقول إن إدراج نموذج مدفوع في fallback بعد `:free` يُحاسب. الموجّه نفسه، حسب دليله، يرجع إلى نماذج مجانية فقط. اختيار المستخدم لمعرف بعينه يبقى ذلك المعرف.

## مستبعد من الاختيارات الجديدة

هذه المعرفات وُجدت في الفهرس وفي نقاط النهاية، وسعرها 0. لا تُعرض للاختيار. لا تحل محل Nemotron 3.5 Embed أو Rerank.

### `nvidia/nemotron-3-embed-1b:free`

- **displayName:** NVIDIA: Nemotron 3 Embed 1B (free)
- **family:** `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** تضمين نصي مستبعد من الاختيارات الجديدة.
- **inputModalities:** `text`
- **outputModalities:** `embeddings`
- **contextLimits:** `context_length=32768`. `max_completion_tokens=29491`.
- **endpointType:** `POST https://openrouter.ai/api/v1/embeddings`. موجود في قائمة embeddings.
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. المزود: Nvidia. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح. `hugging_face_id` فارغ.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/nemotron-3-embed-1b-20260716`. الوصف: تضمين نصي للاسترجاع عالي الإنتاجية.

### `nvidia/llama-nemotron-embed-vl-1b-v2:free`

- **displayName:** NVIDIA: Llama Nemotron Embed VL 1B V2 (free)
- **family:** `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** تضمين متعدد الوسائط مستبعد من الاختيارات الجديدة.
- **inputModalities:** `text`, `image`
- **outputModalities:** `embeddings`
- **contextLimits:** `context_length=131072`. `max_completion_tokens=117964`.
- **endpointType:** `POST https://openrouter.ai/api/v1/embeddings`. موجود في قائمة embeddings.
- **availability:** مقيد بشروط المزود
- **usagePolicy:** تحذير هذه الصفحة أصرح من النص المشترك: «Note: For the free endpoint, all prompts and output are logged to improve the provider's model and its product and services. Please do not upload any personal, confidential, or otherwise sensitive information. This is a trial use only. Do not use for production or business-critical systems.» `dataPolicy.training=true` وملف الشروط هو NVIDIA API Trial Terms. المزود: Nvidia. رمز الحالة `0`. `hugging_face_id=nvidia/llama-nemotron-embed-vl-1b-v2`.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/llama-nemotron-embed-vl-1b-v2-20260224`.

### `nvidia/llama-nemotron-rerank-vl-1b-v2:free`

- **displayName:** NVIDIA: Llama Nemotron Rerank VL 1B V2 (free)
- **family:** `group=Other`. `architecture.tokenizer=Other`. منظمة المعرف: `nvidia`.
- **taskType:** إعادة ترتيب مستبعدة من الاختيارات الجديدة.
- **inputModalities:** `text`, `image`
- **outputModalities:** `rerank`
- **contextLimits:** `context_length=10240`. `max_completion_tokens=9216`.
- **endpointType:** `POST https://openrouter.ai/api/v1/rerank`
- **availability:** مقيد بشروط المزود
- **usagePolicy:** التحذير مطابق للنص المشترك، مع شروط NVIDIA API Trial و`training=true`. المزود: Nvidia. رمز الحالة `0`. `limit_rpm=0` و`limit_rpd=0` بلا شرح. `hugging_face_id` فارغ.
- **checkedAt:** 2026-10-27
- **ما قُرئ أيضًا:** `canonical_slug=nvidia/llama-nemotron-rerank-vl-1b-v2`. الوصف: نموذج إعادة ترتيب متعدد الوسائط 1.7B.

## خارج هذا السجل

Claude Haiku 5.5 ليس عنصرًا في قائمة OpenRouter هذه. الملحق `docs/haiku-5-5-addendum.md` يبقيه على Anthropic مباشرة وبالمعرف `claude-haiku-5-5`. لا يُستدعى مكان نموذج مجاني متعذر، ولا يُدمج في هذا السجل.

## الأعداد في 2026-10-27

معرفات الاختيارات الـ 21 كلها ظهرت في الفهرس، ولكل منها نقطة نهاية واحدة بسعر 0.

| الحالة | العدد | المعرفات |
| --- | --- | --- |
| مُدرَج | 21 | كل اختيارات الأقسام 1–6 |
| نقطة مجانية بسعر 0 | 21 | نفسها |
| متاح | 8 | Gemma 31B، Flint، Gemma 26B A4B، Xing4.0، North Mini Code، Mammoth 1، Elephant 1، Span-01 Lite |
| مقيد بشروط المزود | 13 | Super VL، Lightning، Inkling، Inkling Small، Ultra، Nano Omni، LFM2.5-2.6B، Embed 1B، Embed 8B، LFM2.5-Embedding-350M، Rerank 8B، Content Safety، S2.1 Pro Free |
| تجريبي داخلي | 0 | لم يُستخدم هذا الوسم |
| غير متاح | 0 | لم يغب معرف ولم تغب نقطة اختيار |

`openrouter/free` مُدرَج كموجّه، ومصفوفة نقاطه فارغة. المستبعدات الثلاثة مُدرجة ولها نقاط بسعر 0، وكلها مقيدة بشروط NVIDIA، وهي خارج الاختيارات.

Embed 8B رمزه `-2`، وNano Omni رمزه `-5`. المعنيان غير مذكورين في المخطط المقروء، لذلك لم يُحسبا «غير متاح» ما دامت النقطة موجودة وسعرها 0، وبقيت الحالة «مقيد بشروط المزود» بسبب تحذير التجربة.
