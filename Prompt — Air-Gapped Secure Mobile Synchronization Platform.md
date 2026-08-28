# Air-Gapped Secure Mobile Synchronization Platform

## دورك

أنت مهندس برمجيات وأمن معلومات Senior، متخصص في:

- ASP.NET Core + C#
- React + TypeScript
- Secure offline systems
- Distributed synchronization
- Cryptographic engineering باستخدام primitives قياسية
- Air-gapped environments
- Local-first applications
- Secure file/data transfer
- Protocol design
- Computer Vision و visual data encoding
- Threat modeling
- Testing و benchmarking

أريد منك تصميم وبناء مشروع Production-grade اسمه:

**GridData — Air-Gapped Secure Mobile Synchronization Platform**

---

## 1. الفكرة الأساسية

لدينا بيئة داخلية معزولة عن الإنترنت، تحتوي على عدة أنظمة وخوادم وقواعد بيانات حساسة. أجهزة الموبايل لا يسمح لها بالاتصال مباشرة بالشبكة الداخلية.

الهدف: إنشاء قناة مزامنة آمنة ومشفرة بين النظام الداخلي والأجهزة المحمولة بدون فتح اتصال شبكي مباشر.

```text
AIR-GAPPED INTERNAL NETWORK
        |
        +-- ASP.NET Core Server
        +-- Multiple Internal Systems / Databases
        +-- Internal Web Application (React)
                |
                | Secure Sync Package
                |
                v
        VISUAL DATA TRANSFER (Primary)
                |
                +-- Visual Matrix (1-bit B/W + Hadamard WHT)
                +-- QR Code (fallback)
                +-- USB (fallback)
                |
                v
          MOBILE DEVICE (PWA)
                |
                +-- Camera (reads visual frames)
                +-- Local Database (IndexedDB)
                +-- Mobile Web Application
```

---

## 2. بيئة التشغيل والقيود

النظام يجب أن يعمل بدون:

- Internet
- Cloud
- Public API
- External authentication service
- Direct mobile-to-server network connection

النظام يعمل في بيئة **Air-Gapped / Offline / Disconnected** بالكامل.

---

## 3. التقنيات المطلوبة

### Backend — ASP.NET Core + C#

- ASP.NET Core (.NET 8+)
- C#
- Entity Framework Core عند الحاجة
- SQLite أو PostgreSQL حسب الحاجة
- Dependency Injection
- Background Services عند الحاجة
- Minimal APIs أو Controllers حسب التصميم

### Frontend — React + TypeScript

- React
- TypeScript
- Vite
- Web APIs (Camera, Canvas, Web Workers, IndexedDB, Web Crypto API)

### لا تضف

- Flutter, Python, Node backend, أو أي framework آخر إلا بسبب تقني واضح ومبرر

---

## 4. الجهاز المحمول

### المرحلة الحالية

- **PWA** (Progressive Web App) يعمل من المتصفح
- يستخدم الكاميرا لقراءة البيانات من الشاشة
- IndexedDB كقاعدة بيانات محلية
- يعمل offline بالكامل بعد التحميل الأول

### المرحلة المستقبلية

- تطبيق ويب محلي يشتغل offline بشكل كامل
- تطبيق موبايل native بجانب الويب
- عدة تطبيقات موبايل مختلفة، كل واحد يتزامن مع نظام معين

---

## 5. النقل البصري — الأولوية الأولى

### المبدأ الأساسي

الأولوية القصوى هي **سرعة وأداء النقل البصري**. لا نستخدم QR codes تقليدية كحل أساسي — نصمم نظام مخصص للسرعة والدقة.

### القرار التقني: 1-bit Hadamard (WHT) + Visual Matrix

بعد تحليل المقايضات بين عدد الألوان/المستويات ودقة الكاميرا، القرار النهائي:

**1-bit (أبيض/أسود فقط) + Walsh-Hadamard Transform**

#### لماذا 1-bit وليس 4-bit أو ألوان؟

| | 1-bit B/W + WHT | 4-bit (16 level) |
|---|---|---|
| Camera accuracy | ~99% | ~40% |
| Grid size possible | 64x64 (4096 cells) | 32x32 (1024 cells) |
| FPS possible | 20+ | 8-10 |
| Effective throughput | **~75 Kbps** | ~8 Kbps |
| 1 MB transfer time | **~1.8 min** | ~17 min |
| Calibration needed | No | Yes |
| Screen dependency | Low | High |

**المبدأ:** bits/cell قليلة + cells كثيرة + FPS عالي > bits/cell كثيرة + cells قليلة + FPS بطيء

#### كيف يعمل النظام

المصفوفة البصرية (Visual Matrix) هي الشكل الفيزيائي الذي يظهر على الشاشة.
Hadamard/WHT هي الطبقة الرياضية التي توزع البيانات داخل المربعات.

```text
[Raw Data Bits]
      |
      v
[Walsh-Hadamard Transform (Inverse)]
      |
      v
[1-bit Cell Values: +1 = White, -1 = Black]
      |
      v
[Display on Screen as B/W Grid]
      |
      v  (Camera reads — may have noise/errors)
[Read Cell Values (noisy)]
      |
      v
[Walsh-Hadamard Transform (Forward)]
      |
      v
[Recovered Data Bits — noise averaged out]
```

**لماذا WHT يصلّح الأخطاء:**
- بدل ما كل خلية تحمل bit مستقل (خلية غلط = bit ضايع)، WHT يوزّع كل bit على **كل الخلايا** كنمط رياضي
- المستقبل يعمل correlation (dot product) مع كل نمط — الإشارة الصحيحة تتراكم، والـ noise يتلاشى
- Processing gain = √N (لـ 64x64 grid: √4096 = 64x noise reduction)
- حتى لو 20%+ من الخلايا انقرأت غلط، البيانات تُسترجع كاملة

#### هيكل الفريم الواحد

```text
+------------------------------------------+
| SYNC (0xGD) | FRAME ID | SIZE | CRC-32   |  <- Header (معروف مسبقاً)
+------------------------------------------+
|                                          |
|    ■ □ ■ ■ □ □ ■ □ ■ □ ■ □ ■ □ ...      |
|    □ ■ □ □ ■ ■ □ ■ □ ■ □ ■ □ ■ ...      |
|    ■ ■ □ ■ □ ■ ■ □ □ ■ □ ■ □ □ ...      |
|    ...                                   |
|    64 x 64 = 4096 cells                  |
|    1-bit each (B/W)                      |
|    WHT-encoded data                      |
|                                          |
+------------------------------------------+
|         FEC (Fountain Codes)             |  <- Packet-level error correction
+------------------------------------------+
```

#### المواصفات المستهدفة

- **Grid**: 64 x 64 cells (4096 cells per frame)
- **Encoding**: 1-bit per cell (أبيض/أسود)
- **Transform**: Walsh-Hadamard Transform (2D)
- **FPS**: 20 frames per second (target)
- **Raw throughput**: ~81,920 bps
- **Effective throughput**: ~75 Kbps (بعد WHT recovery)
- **Error tolerance**: 20%+ of cells can be misread
- **1 MB transfer time**: ~1.8 minutes

#### المطلوب تصميمه

- **WHT Engine**: 2D Walsh-Hadamard Transform encoder/decoder (C# + TypeScript)
- **Frame Synchronization**: آلية تزامن بين الشاشة والكاميرا (sync markers)
- **Adaptive Grid**: تعديل حجم الـ grid تلقائياً حسب المسافة وقدرة الكاميرا
- **Fountain Codes**: LT codes على مستوى الحزم (packet-level error correction) — يوجد كود مرجعي في `D:\QR`
- **Frame Detection**: كيف الكاميرا تحدد حدود المصفوفة وتقرأ الخلايا
- **Benchmarking**: قياس الأداء الفعلي بظروف مختلفة (إضاءة، مسافة، زاوية، نوع شاشة)

### وسائل النقل البديلة (Fallback)

- **QR Code**: للبيانات الصغيرة أو كـ fallback
- **USB**: للملفات الكبيرة جداً

### مبدأ فصل البروتوكول عن النقل

```text
                SECURE SYNC PROTOCOL
                         |
          +--------------+--------------+
          |              |              |
    VISUAL MATRIX    QR CODE          USB
          |              |              |
          +--------------+--------------+
                         |
                   SYNC PACKAGE
```

**Sync Protocol != Transport**

نفس الـ encrypted package يجب أن يمكن نقله عبر أي وسيلة بدون إعادة تصميم.

---

## 6. حجم البيانات والأجهزة

- **حجم البيانات**: ميغابايتات، يتفاوت حسب الحالة
- **عدد الأجهزة**: أقل من 10 أجهزة
- **نوع البيانات**: بيانات نصية (جداول، سجلات) + ملفات مرفقة (صور، PDF، مستندات) — حسب الحالة
- **تكرار المزامنة**: حسب الحاجة، بدون جدول ثابت

---

## 7. الأنظمة والصلاحيات

- السيرفر يخدم **عدة أنظمة وقواعد بيانات** مختلفة
- كل جهاز موبايل يشوف البيانات **حسب التطبيق الخاص به فقط**
- مستقبلاً: عدة تطبيقات موبايل، كل واحد يتزامن مع نظامه
- كل جهاز له صلاحيات محددة (Least Privilege)

---

## 8. اتجاه المزامنة

### المرحلة الحالية

- **اتجاه واحد**: السيرفر ← الموبايل (read-only على الموبايل)

### المرحلة المستقبلية

- **اتجاهين**: السيرفر ↔ الموبايل (bidirectional)
- الموبايل يرسل تغييرات للسيرفر بنفس آلية النقل
- عند التعارض: **السيرفر يربح دائماً (Server Wins)**

---

## 9. المستخدمون

النظام يستخدمه نوعين من المستخدمين:

- **شخص تقني** (IT admin / مهندس)
- **موظف عادي** (بدون خلفية تقنية)

لذلك الواجهة يجب أن تكون **بسيطة وواضحة** — العملية لا تتطلب أكثر من خطوات قليلة.

**لغة الواجهة: عربي**

---

## 10. Incremental Sync

لا أريد إرسال قاعدة البيانات كاملة. النظام يجب أن ينشئ **Incremental Sync Package** يحتوي فقط على التغييرات:

```text
Last Server Version: 1000
Mobile Version: 950

Required Changes: 951, 952, 953, ... 1000
```

---

## 11. Sync Model

نموذج مزامنة robust يدعم:

- Full synchronization (أول مرة)
- Incremental synchronization (التحديثات)
- Partial synchronization (حسب الصلاحيات)
- Resume (استئناف نقل متوقف)
- Interrupted transfer recovery
- Duplicate package detection
- Replay protection
- Conflict detection (مستقبلاً)
- Versioning
- Device identity
- Server identity
- Acknowledgement
- Retry
- Recovery

---

## 12. Sync Package — Binary Protocol

صمم binary protocol واضح للـ Sync Package:

- لا تعتمد على JSON فقط كصيغة النقل النهائية
- يمكن استخدام JSON للـ metadata أو debugging
- صمم Binary Envelope مناسب للـ production
- ترتيب المعالجة:

```text
Raw Data -> Serialization -> Compression -> Encryption -> Transport Encoding
```

---

## 13. الأمان والتشفير

### قواعد صارمة

- **ممنوع** اختراع encryption algorithm من الصفر
- استخدم cryptographic primitives معروفة ومختبرة فقط
- **ممنوع** أي خوارزميات تشفير مخصصة

### المطلوب

- **Key Management**: تصميم من البداية
- **Device Identity**: كل جهاز يمتلك identity cryptographically verifiable
- **Replay Protection**: منع إعادة استخدام الحزم القديمة
- **Integrity**: كل package قابل للتحقق من authenticity, integrity, sender, receiver
- **Canonical Serialization**: deterministic لضمان التحقق
- **Local Data Encryption**: تشفير البيانات محلياً على الموبايل
- **Security Boundary**: الثقة تأتي من التشفير وليس الوسيط

---

## 14. Database Synchronization

- استخدم **ChangeLog** بدل الاعتماد على updated_at فقط
- استخدم **Tombstones** بدلاً من الحذف المباشر للـ delete synchronization
- صمم آلية كشف وحل تعارضات واضحة (Server Wins)
- دعم صلاحيات على مستوى البيانات (Selective Sync)

---

## 15. الذكاء الاصطناعي — متى وأين

### المرحلة الأولى: بدون AI

النظام الأساسي يعتمد على **WHT (Walsh-Hadamard Transform)** لتصحيح الأخطاء رياضياً — وهو أفضل من AI للمرحلة الأولى لأنه:
- Deterministic ومتوقع
- لا يحتاج تدريب أو بيانات
- مثبت رياضياً (processing gain = √N)
- يشتغل على أي جهاز بدون model

### المرحلة المتقدمة: AI يُضاف لاحقاً

بعد ما النظام يشتغل ويكون عندك بيانات حقيقية:

1. **Frame Detection بالكاميرا (Computer Vision)**
   - model صغير وسريع يحدد حدود المصفوفة ويقرأ الخلايا
   - يتعامل مع إضاءة سيئة، زاوية مايلة، شاشة بعيدة
   - يحسّن دقة القراءة فوق ما يوفره WHT

2. **Adaptive Error Correction**
   - يتعلم نمط الأخطاء حسب البيئة
   - يعدّل حجم الـ grid والـ FPS ديناميكياً

3. **Adaptive Bitrate**
   - يعدّل سرعة الفريمات حسب قدرة الكاميرا بالوقت الحقيقي

### لا يُستخدم AI في

- **التشفير** — خوارزميات قياسية فقط
- **البروتوكول** — يجب أن يكون deterministic ومتوقع
- **الضغط** — خوارزميات تقليدية (zstd, brotli) أفضل وأضمن
- **تصحيح الأخطاء الأساسي** — WHT يتكفل بهذا رياضياً

---

## 16. كود مرجعي موجود

يوجد مشروع سابق في `D:\QR` (QrDataBridge) يحتوي على كود مفيد يمكن الاستفادة منه:

- **FountainCodeService.cs** — Luby-Transform fountain codes encoder
- **fountainDecoder.ts** — Belief-propagation peeling decoder (TypeScript)
- **colorQr.ts** — Two-layer color QR (R/B channel encoding, 2x throughput)
- **grayQr.ts** — Four-level grayscale QR
- **CameraReader.tsx** — Multi-region camera scanner with jsQR
- **BinaryPackService.cs** — MessagePack serialization
- **CompressionService.cs** — Compression
- **Mulberry32** — Deterministic PRNG (matching C# and TypeScript)

**لا تنسخ المشروع** — ابدأ من الصفر بـ architecture صحيحة، واستفاد من هذا الكود كـ transport layer module.

---

## 17. واجهة التحكم

### React Web Application (على الكمبيوتر)

- لوحة تحكم لإدارة الأجهزة والمزامنة
- واجهة عرض الـ Visual Matrix للنقل البصري
- إدارة الأنظمة المتصلة
- Audit Log

### PWA (على الموبايل)

- واجهة استقبال بسيطة
- فتح الكاميرا وقراءة الفريمات
- عرض حالة التزامن والتقدم
- تصفح البيانات المتزامنة

### شاشة العرض

- الموبايل يقرأ من **شاشة كمبيوتر عادي** أو **شاشة عرض كبيرة (TV/monitor)**

---

## 18. ASP.NET Core API

تصميم API لإدارة:

- Sync sessions
- Device registration و management
- System/database registration
- Package generation
- Audit logs
- Visual transfer configuration

---

## 19. Audit Log

تسجيل كل العمليات:

- من أرسل، لمن، متى
- حجم البيانات
- نجاح أو فشل
- أي أخطاء أمنية

---

## 20. Versioning والتوافقية

- دعم versioning للبروتوكول
- Package State Machine (تعريف حالات الحزمة)
- Idempotency (منع التكرار في التطبيق)
- Crash Recovery (ضمان الاتساق بعد الانقطاع)

---

## 21. Parser Security

اعتبار كل input غير موثوق — سواء من الكاميرا أو من ملف USB أو من أي مصدر.

---

## 22. Threat Model

تحليل شامل للتهديدات يشمل:

- Man-in-the-middle عبر التصوير
- Package tampering
- Replay attacks
- Device impersonation
- Data leakage
- Physical access threats

---

## 23. Testing

- Unit Tests
- Integration Tests
- Security Tests
- Fuzz Testing (مدخلات عشوائية)
- Visual Transfer Benchmark (مقارنة الأداء بين وسائل النقل)
- Performance Benchmark

---

## 24. Code Quality

- Clean Architecture
- SOLID Principles
- هيكل مشروع واضح ومنظم

---

## 25. Research و Innovation

- ملف بحثي للأفكار الجديدة (خاصة Visual Matrix encoding)
- التحقق من prior art قبل ادعاء أي ابتكار
- توثيق كل قرار تصميمي ولماذا تم اختياره

---

## 26. استراتيجية التنفيذ

### المراحل

1. **Architecture + Protocol Design + Threat Model** — تصميم كامل أولاً
2. **Core Sync Engine** — البروتوكول والتشفير والمزامنة
3. **Visual Matrix Transport** — النقل البصري المخصص عالي السرعة
4. **Backend API** — ASP.NET Core
5. **Frontend Dashboard** — React (الكمبيوتر)
6. **Mobile PWA** — React (الموبايل)
7. **Integration + Testing + Benchmarking**
8. **AI Enhancement** — Computer Vision للكاميرا (مستقبلاً)

### قاعدة مهمة

**لا تنفيذ قبل التصميم الكامل.** قدّم Architecture + Threat Model + Protocol Design أولاً.

---

## 27. Output Format المطلوب

عند البدء بالتنفيذ، قدّم بالترتيب:

1. **System Architecture Document**
2. **Threat Model**
3. **Sync Protocol Specification**
4. **Visual Matrix Encoding Specification**
5. **API Design**
6. **Implementation**

---

## 28. قواعد صارمة

- لا custom cryptography
- لا اتصال بالإنترنت
- لا اعتماد على وسيط موثوق — الثقة من التشفير فقط
- لا JSON كـ transport format نهائي — binary protocol
- الواجهة عربية
- البداية من الصفر (لا نسخ من مشروع QR)
- الاستفادة من كود QR كـ module فقط
- ابدأ بدون AI
- تصميم أولاً ثم تنفيذ

---

## 29. الهدف النهائي

نظام مزامنة آمن، غير متصل، قابل للتوسع، وقابل للتدقيق:

```text
INTERNAL SERVER -> ENCRYPT -> WHT ENCODE -> B/W VISUAL MATRIX -> CAMERA -> WHT DECODE -> VERIFY -> DECRYPT -> APPLY -> ACK
```

مع أولوية قصوى لـ **سرعة وأداء النقل البصري**.
