# سياسة ملزمة: MAX_QUALITY_FREE

**checkedAt:** 2026-10-27

هذا البرومت الثاني، مضاف إلى مواصفة منتج ChatE الأصلية. البرومت الأول يبقى ملزمًا، وملحق `docs/haiku-5-5-addendum.md` يبقى ملزمًا. الفهرس في `docs/binding-specs.md`.

اسم ملف الإعداد المركزي: `MAX_QUALITY_FREE`.

الأولوية لجودة الإجابة ودقتها واكتمالها. الواجهة تبقى سريعة. زيادة زمن استجابة النموذج بسبب جهد أعلى مقبولة، وتُعرض منفصلة عن زمن الواجهة كما في البرومت الأول.

هذه السياسة لا تبني الموقع، ولا تغيّر سجل `docs/openrouter-model-registry.md`، ولا تضع قيمة سر في الوثيقة.

## 1. نطاق السياسة

`MAX_QUALITY_FREE` يضبط طلبات نقاط OpenRouter المجانية المعتمدة في البرومت الأول. كل نموذج يأخذ الإعداد الذي تدعمه نقطته المجانية بعد قراءتها.

الإعداد مركزي في الخادم، ونتيجته سجل لكل معرّف: ما يُرسل، وما تم التحقق من دعمه، وما بقي بلا مصدر. لا يُرسل جسم واحد مثل `effort: "max"` إلى كل النماذج.

Haiku خارج هذا الحساب. قسم 8 يثبّت ذلك.

## 2. القراءة قبل اختيار الإعداد

قبل تثبيت إعداد نموذج، تُقرأ بيانات نقطته من OpenRouter، وتشمل:

- `supported_parameters`
- `reasoning.supported_efforts`
- `reasoning.supports_max_tokens`
- `reasoning.mandatory`
- `reasoning.default_enabled`
- حدود السياق والإكمال
- تسعير نقطة الخدمة

مرجع شكل الاستدلال: [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). مرجع قائمة النقاط: [List all endpoints for a model](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).

قراءة 2026-10-27 استخدمت مسارين للقراءة فقط:

- `GET https://openrouter.ai/api/v1/models`
- `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`

لم يُرسل أي إكمال محادثة، ولا أي `POST` إلى مسار توليد. إن تعذرت قراءة الكتالوج أو النقطة عند طلب لاحق، لا يُخمَّن `effort: "max"`. يُعلَّم مستوى الجهد: «مستوى الجهد غير قابل للتحقق»، ويبقى الطلب على المعرّف المجاني المختار أو تُعرض حالة التعذر. لا نقل إلى مسار مدفوع.

القراءة تُعاد قبل الاعتماد على جدول هذه الوثيقة في التنفيذ، لأن الدعم قد يتغير. الجدول في قسم 9 لقطة هذا التاريخ. عبارة «ما دام مدعومًا» تعني أن القيمة تُرسل فقط طالما أعادت قراءة لاحقة أنها ما زالت ضمن `supported_efforts`.

حقول كائن `reasoning` كما تصفها صفحة Reasoning Tokens المقروءة:

- `supported_efforts` قائمة مرتبة تنازليًا، أعلاها أولًا. إذا كانت `null` فكل قيم جهد البوابة مقبولة. إذا غاب الحقل فالنموذج لا يعرض اختيار جهد.
- `supports_max_tokens` إذا كان `true` فالنموذج يقبل `reasoning.max_tokens`. إذا غاب الحقل فميزانية الرموز غير مدعومة.
- `mandatory` إذا كان `true` فلا يُرسل إيقاف الاستدلال ولا `effort: "none"`.
- `default_enabled` حالة التشغيل عندما لا يضبط العميل `reasoning.enabled`.
- `enabled: true` في الدليل نفسه يفعّل التفكير، والدليل يصفه بسلوك بوابة عند مستوى `medium`. هذا وصف عام للبوابة، وهو غير حقل `supported_efforts` الخاص بالنموذج.

ترتيب الجهد المعروف في الدليل، من الأعلى إلى الأدنى: `max`، `xhigh`، `high`، `medium`، `low`، `minimal`، `none`. قيمة غير موجودة في هذا الترتيب لا يُخترع لها رتبة أعلى.

## 3. القواعد الست

1. إذا أعلن النموذج مستويات جهد في `supported_efforts`، يُختار أعلى مستوى ظاهر في القائمة. `none` إيقاف، ولا يُختار كإعداد جودة.
2. إذا دعم ميزانية استدلال رقمية عبر `reasoning.max_tokens`، تُستخدم أعلى ميزانية موثقة في المصدر المقروء لهذا النموذج، مع إبقاء مساحة للجواب الظاهر. رقم غير موجود في المصدر لا يُخترع.
3. إذا كان التحكم المتاح هو تشغيل التفكير فقط، يُرسل `reasoning.enabled: true`.
4. إذا كان `reasoning.mandatory` صحيحًا، يبقى الاستدلال. لا `reasoning.enabled: false` ولا `effort: "none"`.
5. إذا لم توجد ضوابط استدلال، تُستخدم إعدادات النموذج المناسبة لوظيفته. لا يُخترع خيار باسم max effort.
6. لا يُجمع `reasoning.effort` مع `reasoning.max_tokens` إلا إذا وثّق تكامل ذلك النموذج الجمع بينهما. مثال صفحة Reasoning Tokens يقول إن الحقلين بديلان لا يُرسلان معًا. جملة لاحقة في الصفحة نفسها تقول «بدلًا من، أو إلى جانب». جملة «إلى جانب» عامة، وحمولات النقاط المقروءة في هذا التاريخ لا توثّق جمع الحقلين لأي نموذج في السجل. لذلك لا يُجمعان هنا.

`reasoning.exclude: true` لا يُستخدم لتخفيف الحمولة. الدليل يقول إن الإخفاء يبقي الرموز محسوبة داخل الميزانية.

وجود اسم `reasoning_effort` داخل `supported_parameters` لا يبرر إرسال القيمة مرتين. الطلب يستخدم كائن `reasoning` الموحّد.

## 4. تعليمات المالك لنماذج بعينها

هذه التعليمات تقيّد القواعد الست. لا تُضاف مستويات لم تُعلن.

### `google/gemma-4-31b-it:free`

`reasoning.enabled = true`. لا يُفترض `effort = max` أو `xhigh` بلا توثيق لهذا النموذج. القراءة في قسم 9 لم تُظهر `supported_efforts`، لذلك لا يُرسل `effort`.

### `google/gemma-4-26b-a4b-it:free`

`reasoning.enabled = true`. لا يُطفأ التفكير لأنه كان الاختصار السريع. اختصار الواجهة الذي كان اسمه «سريع» يُعاد تسميته إلى «خفيف»، أو يُعرض اسم النموذج. الواجهة لا تعد بسرعة ثابتة. القراءة لم تُظهر `supported_efforts`، لذلك لا يُرسل `effort`.

### `recursive/flint-v1.0:free`

يبقى الاستدلال الإلزامي. أعلى تحكم تم التحقق من دعمه هو `mandatory: true`. لا تُضاف مستويات غير معلنة.

### `thinkingmachines/inkling:free` و`thinkingmachines/inkling-small:free`

`reasoning.effort = "max"` ما دامت هذه القيمة ضمن `supported_efforts`. في قراءة هذا التاريخ هي أعلى قيمة ظاهرة. التفعيل يبقى مربوطًا بشروط استخدام كل نقطة كما في البرومت الأول. نص تلك الشروط لم يُستخرج في هذه القراءة، فلا يُدّعى أنه فُحص هنا.

## 5. ميزانية الإكمال

لكل طلب إكمال على نقطة محادثة مجانية:

- سقف الإكمال هو أعلى قيمة صالحة بعد حد المزود وما يبقى من السياق.
- يُطرح المدخل والأدوات والوسائط قبل تثبيت السقف.
- السقف لا يتجاوز `max_completion_tokens` الظاهر للنقطة، ولا ما يبقى من `context_length`.
- إذا ظهر `max_prompt_tokens` كرقم، لا يتجاوز المدخل ذلك الرقم.
- الاستدلال والجواب الظاهر قد يشتركان في ميزانية الإكمال. لا تُعطى الميزانية كلها للاستدلال.
- لا يُفرض سقف منخفض واحد على كل النماذج.
- السقف العالي لا يجبر جوابًا طويلًا. الطول يتبع السؤال.
- دليل Reasoning Tokens يصف `effort: "max"` بأنه يخصص نحو 95% من `max_tokens` للاستدلال، و`high` نحو 80%، و`medium` نحو 50%. هذه نسب الدليل العام، لا قياسًا خاصًا أُجري على نقاط ChatE. لذلك يبقى سقف الإكمال عند أعلى حد صالح للنقطة، حتى تبقى بقية الجواب الظاهر أكبر ما تسمح به النقطة. لا يُخفَّض الجهد بسبب هذه النسبة.
- إذا أظهر `finish_reason` أو `usage` أن حد الرموز اُستهلك، تُعلَّم الإجابة ناقصة. جواب ظاهر فارغ استُهلكت ميزانيته في الاستدلال ليس نجاحًا.
- لا إعادات بلا حد. إعادة محاولة النقل المحدودة في البرومت الأول تبقى لمعالجة الأعطال و`429`. تكرار السؤال عدة مرات تحت عنوان ذكاء أعلى ميزة مستقلة وصريحة، ولا تُشغَّل تلقائيًا.

إذا كانت قيمة `max_completion_tokens` هي `0`، أو كانت مخرجات النقطة ليست نص محادثة، فلا يُعامل الصفر كسقف جودة لمحادثة ولا يُرسل كميزانية استدلال.

## 6. إعدادات الجودة الأخرى

تُستخدم إعدادات المعاينة الموصى بها في `default_parameters` عندما تكون القيمة غير `null` ويكون اسم المعامل داخل `supported_parameters` للنقطة.

رفع `temperature` أو `top_p` إلى أقصى مدى ليس رفعًا للذكاء. قيمة `null` أو كائن `default_parameters` فارغ يعني أن المصدر لم يعطِ رقمًا: لا يُخترع رقم.

لا تُخفَّض دقة الصورة، ولا تُقص الأدلة، من أجل السرعة، إلا عند حد تقني معلن. في القراءة لم يظهر معامل دقة صورة داخل `supported_parameters` للنماذج المفحوصة، فلا يُخترع معامل ثم يُخفَّض.

تبقى التعليمات واضحة، والأدلة ذات الصلة، ومعلومات المصدر كما في البرومت الأول. لا يُحشى السياق بمحتوى غير متعلق لأن النافذة كبيرة.

## 7. التضمين وإعادة الترتيب والمصنفات والصوت

هذه الفئات تأخذ إعداد جودة يناسب وظيفتها في البرومت الأول.

- لا تُرسل إليها معاملات استدلال غير موجودة في `supported_parameters`.
- `nvidia/nemotron-3.5-embed-1b:free` يبقى التضمين الافتراضي عند سماح شروط نقطته.
- `nvidia/nemotron-3.5-embed-8b:free` يبقى بديل مقارنة للاسترجاع. هذه السياسة لا تستبدله بـ 1B ولا تستبدل 1B به.
- Mammoth وElephant وSpan-01 Lite وContent Safety تبقى على عقودها. إن لم تنطبق المهمة، تُعرض «غير مناسب لهذا الطلب» كما في البرومت الأول.
- Fish يبقى تحويل نص مختار إلى صوت، لا نموذجًا يجيب عن السؤال.
- المعرفات القديمة المستبعدة تبقى خارجة: `nvidia/nemotron-3-embed-1b:free` و`nvidia/llama-nemotron-embed-vl-1b-v2:free` و`nvidia/llama-nemotron-rerank-vl-1b-v2:free`.

## 8. Claude Haiku 5.5 يبقى على `medium`

قرار المالك، مطابق لـ `docs/haiku-5-5-addendum.md`:

- Haiku 5.5، المعرّف `claude-haiku-5-5` عبر Anthropic مباشرة، جزء من النماذج التي يستطيع المنتج تشغيلها، إلى جانب نماذج OpenRouter المجانية.
- هو مدفوع، وتُحاسب تكلفته منفصلة عن حصص الطبقة المجانية.
- هو ليس بديلًا صامتًا، ولا مسار ترقية مدفوع، عندما يكون النموذج المجاني بطيئًا أو غائبًا أو جوابه منخفض الجهد.
- عندما يختار المستخدم Haiku، يبقى التفكير Adaptive ويبقى الجهد `medium` في `output_config.effort`. أعلى جهد في `MAX_QUALITY_FREE` يخص نقاط OpenRouter المجانية، ولا يُستخدم لرفع فاتورة Haiku.
- لا تُرسل `temperature` ولا `top_p` ولا `top_k` إلى Haiku. الملحق ينص على أن الواجهة ترفضها.
- لا يُفعَّل نموذج Anthropic آخر.

في وضع «مقارنة بأقصى إعدادات كل نموذج»، ظهور Haiku يبقى اختيارًا ظاهرًا، والجهد المعروض والمرسل له هو `medium`.

## 9. ما قرأته الواجهة في 2026-10-27

وقت قراءة الكتالوج والنقاط الأولى: `2026-10-27T15:08:37Z`.

`GET /api/v1/models` أعاد HTTP 200، وفيه 463 نموذجًا. طابق 14 معرّفًا من السجل المعتمد. الثمانية الغائبة عن هذه القائمة أُعيدت قراءة نقاطها في اليوم نفسه، وظهرت معمارياتها هناك. `openrouter/free` ظهر في القائمة وأعاد صفر نقاط.

كل المسارات كانت `GET`. لم يُستدعَ إكمال محادثة. تسعير النقاط التي أُرجعت كان `prompt: "0"` و`completion: "0"` و`discount: 0`. مفتاحا `image` و`request` لم يظهرا في كائن تسعير هذه النقاط. تسعير سجل النموذج، حيث وُجد، كان `prompt: "0"` و`completion: "0"` فقط.

`per_request_limits` نُسخت قيمته `null` لنماذج القائمة. ظهور المفتاح نفسه تأكد في `nvidia/nemotron-3-ultra-550b-a55b:free` و`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` و`cohere/north-mini-code:free` و`openrouter/free`.

معنى الأعداد `status` غير الصفر لم يُذكر في صفحة النقاط الرسمية المقروءة. الصفحة تعرض مثالًا بقيمة `0` بلا جدول لمعاني `-2` و`-5`. العدد يُسجَّل كما ظهر، ولا يُترجم إلى تسمية مخترعة، ولا يبرر نقل الطلب إلى معرّف بلا لاحقة `:free`.

بعض العائلات ظهر لها أيضًا معرّف بلا `:free` داخل قائمة النماذج. تسعير ذلك المعرّف لم يُطلب. لا يُستخدم. المعرفات التي ظهرت بهذه الصورة: `google/gemma-4-31b-it`، `google/gemma-4-26b-a4b-it`، `nvidia/nemotron-3.5-super-vl`، `nvidia/nemotron-3.5-lightning`، `thinkingmachines/inkling`، `thinkingmachines/inkling-small`، `nvidia/nemotron-3-ultra-550b-a55b`، `liquid/lfm-2.5-2.6b`، `nvidia/nemotron-3.5-content-safety`.

اسم النقطة أدناه هو حقل `name` كما أعاده مسار النقاط. طلب ChatE يبقى على معرّف السجل المجاني، لا على اسم مؤرخ داخل ذلك الحقل.

### مستويات الجهد التي تم التحقق منها

هذه الثلاثة فقط لها `supported_efforts` ظاهر، وأعلاه هو ما يُرسل:

| المعرّف | `supported_efforts` كما قُرئ | ما يُرسل | التحقق |
| --- | --- | --- | --- |
| `thinkingmachines/inkling:free` | `max`, `high`, `medium`, `low`, `minimal`, `none` | `reasoning.effort = "max"` | أعلى مستوى جهد مدعوم |
| `thinkingmachines/inkling-small:free` | `max`, `high`, `medium`, `low`, `minimal`, `none` | `reasoning.effort = "max"` | أعلى مستوى جهد مدعوم |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `high`, `medium`, `none` | `reasoning.effort = "high"` فقط | أعلى مستوى جهد مدعوم. `max` و`xhigh` لم يظهرا |

Ultra أيضًا: `supports_max_tokens: true` و`default_effort: "high"` و`default_enabled: true` و`mandatory: false`. لا يُرسل معه `reasoning.max_tokens`، لأن الجمع غير موثّق لتكامله. لا رقم لسقف الميزانية الرقمية في الكائن المقروء: «لم يُذكر في المصدر الرسمي المقروء».

Inkling وInkling Small: `default_effort: "high"` و`default_enabled: true` و`mandatory: false`. `supports_max_tokens` غائب، فميزانية الرموز غير مدعومة حسب الدليل. القيمة المرسلة تبقى `max` لا الافتراضي `high`، ما دام `max` ظاهرًا.

### تفكير بلا مستوى جهد معلن

`supported_efforts` غائب في هذه الصفوف. الدليل يقول إن غيابه يعني أن النموذج لا يعرض اختيار جهد. لا يُرسل `effort`. وصف الواجهة لهذه الصفوف: «التفكير مفعّل»، وليس «أعلى مستوى جهد مدعوم».

| المعرّف | كائن `reasoning` كما قُرئ | ما يُرسل |
| --- | --- | --- |
| `google/gemma-4-31b-it:free` | `mandatory: false`, `default_enabled: false` | `reasoning.enabled: true` بقرار المالك. الافتراضي في الكتالوج مطفأ. |
| `google/gemma-4-26b-a4b-it:free` | `mandatory: false`, `default_enabled: false` | `reasoning.enabled: true`. الاختصار في الواجهة: «خفيف» أو اسم النموذج. |
| `recursive/flint-v1.0:free` | `mandatory: true` | إبقاء الاستدلال الإلزامي. لا مستوى جهد مضاف. |
| `xingchen-agi/xing4.0-29b-a4b:free` | `mandatory: false`, `default_enabled: true` | `reasoning.enabled: true`. |
| `nvidia/nemotron-3.5-super-vl:free` | `mandatory: false` | `reasoning.enabled: true`. |
| `nvidia/nemotron-3.5-lightning:free` | `mandatory: false` | `reasoning.enabled: true`. |
| `cohere/north-mini-code:free` | `mandatory: false` | `reasoning.enabled: true`. |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | `mandatory: false`, `default_enabled: true`, `supports_max_tokens: true` | `reasoning.enabled: true`. رقم `reasoning.max_tokens`: «لم يُذكر في المصدر الرسمي المقروء»، فلا يُخترع. |
| `liquid/lfm-2.5-2.6b:free` | `mandatory: true` | إبقاء الاستدلال الإلزامي. لا مستوى جهد مضاف. |
| `nvidia/nemotron-3.5-content-safety:free` | `mandatory: false`, `default_enabled: true` | مصنّف. `reasoning.enabled: true` لأنه افتراضه، وبلا `effort`. |

`supports_max_tokens` غائب في صفوف هذا الجدول ما عدا Nano Omni وUltra في الجدول السابق. غيابه يعني، حسب الدليل المقروء، أن ميزانية الرموز غير مدعومة. لا تُرسل.

### بلا معامل استدلال

هذه الثمانية غابت عن `GET /api/v1/models`، لذلك لا كائن `reasoning` من سجل النماذج. حمولة النقطة بلا مفتاح `reasoning`، و`supported_parameters` مصفوفة فارغة بعدد صفر. مستوى جهد مسمى: «مستوى الجهد غير قابل للتحقق». الإجراء الملزم: لا يُرسل أي معامل `reasoning`.

| المعرّف | المعمارية المقروءة من النقطة | `context_length` | `max_completion_tokens` | المزوّد | `status` |
| --- | ---: | ---: | ---: | --- | ---: |
| `nvidia/nemotron-3.5-embed-1b:free` | `text+image->embeddings` | 32768 | 29491 | Nvidia | 0 |
| `nvidia/nemotron-3.5-embed-8b:free` | `text+image->embeddings` | 32768 | 29491 | Nvidia | -2 |
| `liquid/lfm-2.5-embedding-350m:free` | `text->embeddings` | 512 | 460 | Liquid | 0 |
| `nvidia/nemotron-3.5-rerank-8b:free` | `text+image->rerank` | 32768 | 29491 | Nvidia | 0 |
| `baseten/mammoth-1:free` | `text->decisions` | 16384 | 14745 | BaseTen | 0 |
| `baseten/elephant-1:free` | `text->decisions` | 16384 | 14745 | BaseTen | 0 |
| `respan/span-01-lite:free` | `text->decisions` | 0 | 0 | Respan | 0 |
| `fish-audio/s2.1-pro-free:free` | `text->speech` | 0 | 0 | Fish Audio | 0 |

أرقام الإكمال هنا سُجّلت كما ظهرت. لا تُحوَّل إلى `max_tokens` محادثة ولا إلى `reasoning`.

### `openrouter/free`

ظهر في قائمة النماذج. مفتاح `reasoning` غائب، وهذا يطابق قول الدليل إن الموجّه الديناميكي يحذف كائن `reasoning`. عدد النقاط الراجعة: 0. `context_length` في سجل النموذج: 200000. `top_provider.context_length` و`top_provider.max_completion_tokens`: `null`. التسعير في السجل: `prompt: "0"` و`completion: "0"`. المدخلات: `text`, `image`. المخرجات: `text`.

لا يُرسل إليه `effort` موحّد. هو خارج المقارنة المضبوطة كما في البرومت الأول. جهد النموذج الذي قد يختاره الموجّه، قبل أن تعيده الاستجابة: «مستوى الجهد غير قابل للتحقق».

### حدود السياق والإكمال لنماذج القائمة

`max_prompt_tokens` كان `null` إلا حيث ذُكر رقم. `is_moderated` من `top_provider`.

| المعرّف | السياق | أقصى إكمال | أقصى مدخل | `is_moderated` | النقطة كما في `name` | `status` | التكميم |
| --- | ---: | ---: | ---: | --- | --- | ---: | --- |
| `google/gemma-4-31b-it:free` | 262144 | 32768 | `null` | false | Google AI Studio \| `google/gemma-4-31b-it-20260402:free` | 0 | unknown |
| `google/gemma-4-26b-a4b-it:free` | 262144 | 32768 | `null` | false | Google AI Studio \| `google/gemma-4-26b-a4b-it-20260403:free` | 0 | unknown |
| `recursive/flint-v1.0:free` | 262144 | 235929 | `null` | false | Recursive \| `recursive/flint-v1.0-20261021:free` | 0 | bf16 |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262144 | 235929 | `null` | false | Phala \| `xingchen-agi/xing4.0-29b-a4b-20261015:free` | 0 | unknown |
| `nvidia/nemotron-3.5-super-vl:free` | 1000000 | 131072 | 868928 | false | Nvidia \| `nvidia/nemotron-3.5-super-vl-20261015:free` | 0 | unknown |
| `nvidia/nemotron-3.5-lightning:free` | 1000000 | 65536 | `null` | false | Nvidia \| `nvidia/nemotron-3.5-lightning-20260807:free` | 0 | nvfp4 |
| `thinkingmachines/inkling:free` | 1048576 | 262144 | `null` | false | Thinking Machines \| `thinkingmachines/inkling-20260715:free` | 0 | nvfp4 |
| `thinkingmachines/inkling-small:free` | 1048576 | 262144 | `null` | false | Thinking Machines \| `thinkingmachines/inkling-small-20260730:free` | 0 | nvfp4 |
| `cohere/north-mini-code:free` | 256000 | 64000 | `null` | true | Cohere \| `cohere/north-mini-code-20260617:free` | 0 | unknown |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1000000 | 65536 | `null` | false | Nvidia \| `nvidia/nemotron-3-ultra-550b-a55b-20260604:free` | 0 | unknown |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256000 | 65536 | `null` | false | Nvidia \| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-20260428:free` | -5 | unknown |
| `liquid/lfm-2.5-2.6b:free` | 65536 | 8192 | `null` | false | Liquid \| `liquid/lfm-2.5-2.6b-20260811:free` | 0 | fp8 |
| `nvidia/nemotron-3.5-content-safety:free` | 128000 | 8192 | `null` | false | Nvidia \| `nvidia/nemotron-3.5-content-safety-20260604:free` | 0 | unknown |

المعرّف المرسل يبقى معرّف السجل ذي اللاحقة `:free`، حتى عندما يعرض حقل `name` معرّفًا مؤرخًا. حيث كُتب `unknown` في عمود التكميم، فتلك قيمة الحقل الراجعة نفسها. حالة Nano الرقمية `-5`، وحالة Embed 8B الرقمية `-2`، بلا تسمية في صفحة النقاط الرسمية المقروءة.

المدخلات والمخرجات من سجل النماذج، حيث وُجد السجل:

| المعرّف | مدخلات | مخرجات |
| --- | --- | --- |
| `google/gemma-4-31b-it:free` | image, text, video | text |
| `google/gemma-4-26b-a4b-it:free` | image, text, video | text |
| `recursive/flint-v1.0:free` | text | text |
| `xingchen-agi/xing4.0-29b-a4b:free` | text | text |
| `nvidia/nemotron-3.5-super-vl:free` | text, image, video | text |
| `nvidia/nemotron-3.5-lightning:free` | text | text |
| `thinkingmachines/inkling:free` | text, image, audio | text |
| `thinkingmachines/inkling-small:free` | text, image, audio | text |
| `cohere/north-mini-code:free` | text | text |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | text | text |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | text, audio, image, video | text |
| `liquid/lfm-2.5-2.6b:free` | text | text |
| `nvidia/nemotron-3.5-content-safety:free` | text, image | text |
| `openrouter/free` | text, image | text |

### المعاينة التي ظهرت ولها دعم

تُرسل هذه الأرقام لأنها غير `null` واسمها داخل `supported_parameters`. `top_k: 64` ظاهر في `default_parameters` لـ Gemma 31B و26B، واسم `top_k` غائب عن `supported_parameters` لهما، فلا يُرسل.

| المعرّف | ما يُرسل من `default_parameters` |
| --- | --- |
| `google/gemma-4-31b-it:free` | `temperature: 1`, `top_p: 0.95` |
| `google/gemma-4-26b-a4b-it:free` | `temperature: 1`, `top_p: 0.95` |
| `xingchen-agi/xing4.0-29b-a4b:free` | `temperature: 1`, `top_p: 0.95`, `repetition_penalty: 1.05` |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | `temperature: 1`, `top_p: 0.95` |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | `temperature: 0.6`, `top_p: 0.95` |
| `liquid/lfm-2.5-2.6b:free` | `temperature: 0.1`, `top_k: 50`, `repetition_penalty: 1.1` |

Flint وSuper VL وLightning: `default_parameters` كائن فارغ. Inkling والنسخة الصغيرة وNorth وContent Safety: حقول المعاينة الموجودة قيمتها `null`. لا يُخترع لها رقم. `openrouter/free`: `temperature` و`top_p` و`frequency_penalty` قيمتها `null`.

## 10. شفافية المقارنة

اسم الوضع: «مقارنة بأقصى إعدادات كل نموذج».

- كل نموذج مختار يعمل بأعلى تحكم يدعمه جدول قسم 9، أو بما تعيده قراءة أحدث إذا اختلفت.
- السؤال نفسه، والأدلة المشتركة نفسها، كما في وضعي البرومت الأول.
- تُعرض الإعدادات المطلوبة، والمزوّد أو النقطة المستخدمة، وما أمكن التحقق منه فعلًا.
- «التفكير مفعّل» غير «أعلى مستوى جهد مدعوم». العبارة الثانية تُستخدم فقط للصفوف التي ظهر لها `supported_efforts` واخترنا أعلاها.
- نجاح HTTP لا يثبت أن المزود طبّق كل معامل.
- لا يُخفَّض الجهد بصمت بسبب الحمل أو الزمن. الطابور وحدود التزامن في البرومت الأول هما أداة الضغط.
- مهلة البث ومهلة التنفيذ تُضبطان حتى لا يجمّد الاستدلال الطويل الواجهة. المالك لم يحدد رقم المهلة في هذا البرومت، فتكون المهلة معلنة في التنفيذ ومنفصلة عن قرار الجهد.
- يوجد إيقاف. إيقاف العرض لا يضمن أن المزود توقف فورًا.

## 11. حدود الطبقة المجانية

- لا يُنقل الطلب إلى نموذج أو مزود مدفوع للحصول على جهد أعلى.
- لا يُفعَّل Pro ولا إضافة مدفوعة تلقائيًا.
- الحصص وسياسات المزود في البرومت الأول تبقى.
- لا يُكرر السؤال تلقائيًا عدة مرات بعنوان ذكاء أعلى.
- المعرّف بلا `:free` الذي ظهر في الكتالوج ليس مسارًا بديلًا.

## 12. معيار القبول

يُثبت من الإعدادات المرسلة ومن بيانات القدرة أن كل نموذج يستخدم أعلى تحكم مدعوم ومتاح مجانًا: بلا معاملات مخترعة، وبلا خفض صامت للجودة، وبلا نقل إلى خدمة مدفوعة.

إثبات هذه اللقطة:

- الجهد المسمى المتحقق منه هو `max` لـ Inkling وInkling Small، و`high` لـ Ultra. لا نموذج آخر في القراءة أعلن قائمة جهد أُرسل أعلاها.
- Gemma وFlint وبقية نماذج التفكير بلا قائمة جهد أُبقيت على التشغيل أو على الإلزام، بلا `effort` مخترع.
- نقاط التضمين وإعادة الترتيب والقرار والصوت كانت `supported_parameters` فارغة، فلم يُرسل لها استدلال.
- كل نقطة أُرجعت بسعر إدخال وإكمال `"0"`. لم يُستدعَ مسار إكمال، مدفوعًا أو مجانيًا.
- Haiku، إن اختاره المستخدم، يبقى `output_config.effort = "medium"`.
