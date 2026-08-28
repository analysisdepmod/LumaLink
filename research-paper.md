# A Fully Client-Side Screen-to-Camera Data Transfer System with Optically-Coupled Soft-Decision Decoding

**Author(s):** [Author Name(s)]
**Affiliation:** [Affiliation]
**Correspondence:** [email]
**Preprint — draft for submission. Version 1.0.**

---

## Abstract

Screen-to-camera communication (SCC) transmits data by displaying a time-varying visual code on one device's screen and decoding it with another device's camera. It is attractive for air-gapped, one-way, infrastructure-free transfer, but its throughput and reliability are limited by optical blur, rolling shutter, ambient light, display/camera gamma, colour cross-talk, and hand motion. We present **GridData**, a fully client-side (in-browser, WebAssembly-accelerated) SCC system, and — within it — a set of receiver-side mechanisms whose particular formulation, *to the best of our knowledge and pending a formal prior-art search*, has not previously been reported in the SCC setting:

1. **Optically-coupled soft decoding**: a per-cell *optical reliability* derived from intra-cell luminance variance (a proxy for local focus/blur) and channel saturation, used as a multiplicative weight on the per-bit log-likelihood ratios (LLRs) that feed an LDPC belief-propagation decoder — coupling an image-domain confidence measure directly into the channel decoder.
2. **Feedback-free temporal soft-combining**: chase-combining of LLRs across repeated camera captures of the *same displayed frame*, where frame identity is decided by *sign correlation of the soft-demod output* — requiring no frame counter and no back-channel.
3. **Blind per-frame 3×3 colour-MIMO equalisation** estimated from embedded single-channel calibration anchors, integrated with (1)–(2).
4. **Automatic configuration detection**: the receiver recovers the sender's encoding, grid size, and code rate by a CRC-validated candidate search, removing manual configuration.

We evaluate these mechanisms with a physically-motivated screen-to-camera channel simulator and a single-device real-world feasibility study. In simulation, optical-reliability weighting recovers frames a hard-decision baseline drops entirely under a localised glare patch (0% → 63% frame-recovery at a 15% glare fraction); temporal soft-combining raises frame recovery from 40% to 100% within four looks at high noise; and blind colour-MIMO extends the usable colour cross-talk range. A WebAssembly LDPC decoder produces bit-identical output to the reference implementation at ~1.67× the speed. On a hand-held smartphone we improve *end-to-end* throughput from 0.4 KB/s to 4.4 KB/s (~11×) through a sequence of systems optimisations. Finally, we report two honest, empirically-grounded findings that we believe are useful to the community: (i) commodity hand-held smartphones cannot reliably resolve ≥4 per-channel intensity levels under blur, making binary-per-channel modulation the practical ceiling; and (ii) end-to-end throughput is bounded by the *receiver's pixel-processing rate*, which renders grid-density increases and rolling-shutter temporal multiplexing close to throughput-neutral for a full-matrix link — clarifying two common misconceptions.

**Keywords:** screen-to-camera communication, visual light communication, LDPC, soft-decision decoding, belief propagation, colour MIMO, WebAssembly, air-gapped data transfer.

---

## 1. Introduction

Transferring data between two nearby devices without shared infrastructure — no common network, no pairing, no cable — is a recurring practical need, particularly across security or platform boundaries (air-gapped machines, cross-vendor devices, guest environments). Static 2D barcodes (e.g., QR codes) solve the *small-payload, one-shot* case. For larger payloads, **screen-to-camera communication (SCC)** streams a sequence of visual codes on a display and decodes them with a camera, forming a one-way optical link.

SCC is a well-studied area. Systems such as COBRA, PixNet, LightSync, Strata, ChromaCode, RainBar, HiLight, InFrame/InFrame++, RollingLight, and deep-learning approaches (e.g., DeepLight) have explored colour modulation, rolling-shutter exploitation, flicker-free embedding, and neural demodulation (see Section 2). Despite this, robust high-rate SCC on *commodity hand-held smartphones running entirely in a web browser* remains difficult: the optical channel is severely band-limited by blur and motion, and heavy signal processing competes with a single-threaded UI.

This paper makes both a **systems** contribution — a fully client-side, WebAssembly-accelerated, auto-configuring SCC pipeline — and a set of **algorithmic** contributions centred on *coupling image-domain (optical) confidence into the channel decoder*. Our central thesis is that the reliability information the camera implicitly provides (how sharp, how saturated, how self-consistent each cell read is) should not be discarded by a hard threshold but propagated as soft information into an iterative decoder and across time.

We are careful throughout to separate **algorithmic potential** (measured in a controlled simulator) from **real-world performance** (measured on one hand-held phone), and to state novelty claims as "to our knowledge" pending the formal prior-art search discussed in Section 13. We regard the honest characterisation of the system's *physical ceiling* (Section 12) as a first-class contribution: negative and limiting results are scientifically valuable and, in our reading, under-reported for browser-based hand-held SCC.

**Contributions.**
- **C1.** An *optically-coupled soft-decision* decoder that weights per-bit LLRs by a per-cell optical reliability derived from intra-cell luminance variance and saturation (Section 5).
- **C2.** A *feedback-free temporal soft-combining* scheme that accumulates LLRs across captures of the same displayed frame, using soft-demod sign correlation for frame identity (Section 6).
- **C3.** A *blind per-frame 3×3 colour-MIMO* equaliser from embedded single-channel anchors, integrated with C1–C2 (Section 7).
- **C4.** A *CRC-validated automatic configuration detection* that removes manual sender/receiver matching (Section 8).
- **C5.** A *fully client-side, WebAssembly-accelerated* implementation, and the systems path that took a real hand-held link from 0.4 to 4.4 KB/s (Sections 9, 11).
- **C6.** Two honest empirical findings on the *physical ceiling* of hand-held browser SCC (Section 12).

---

## 2. Related Work and Positioning

We position our work against the SCC literature and are explicit about what is *established prior art* (and therefore **not** claimed as novel here).

**Screen-to-camera / visual light links.** COBRA, PixNet, LightSync, and Strata established 2D visual streaming, synchronisation, and rateless transport. **We do not claim novelty for SCC itself, for using a display as a transmitter, or for rateless/fountain transport** — Strata and related work use rateless codes.

**Colour and multi-level modulation.** ChromaCode and related systems use colour and perceptually-aware modulation; multi-level intensity per channel is a known idea. **We do not claim novelty for colour modulation, multi-level cells, or Gray-coded constellations.**

**Rolling shutter.** RollingLight and others exploit the rolling-shutter effect for low-rate links. We explicitly *analyse and, for full-matrix links, argue against* rolling-shutter temporal multiplexing as a net-throughput lever (Section 12) — a clarification, not a new modulation.

**Flicker-free embedding.** HiLight and InFrame/InFrame++ embed data imperceptibly into displayed content. Our setting is a *dedicated* code display (not embedding), so this is orthogonal; we address flicker only via codeword whitening (a standard scrambling technique) to equalise per-frame brightness.

**Error-control coding.** LDPC codes, belief-propagation (sum-product) decoding, soft-decision decoding, interleaving, and HARQ chase-combining are classical and decades old. **We claim none of these primitives as novel.** Our contribution is *what* we feed into them (optical reliability) and *how* we combine across time *without a back-channel or frame identifier* (Sections 5–6).

**Registration.** Homography-based rectification and finder patterns are standard (cf. QR). We use a black-frame finder with an asymmetric orientation marker; we do not claim the finder concept as novel.

**Neural SCC.** DeepLight and related approaches learn demodulators. Our approach is model-based and interpretable; it is complementary.

**Where we believe we differ (to be verified).** We are not aware of prior SCC work that (a) derives a *per-cell optical reliability from intra-cell pixel variance* and uses it as an explicit LLR weight into an LDPC decoder, or (b) performs *feedback-free temporal LLR combining with content-correlation frame identity*. Section 13 details the prior-art verification we consider mandatory before asserting priority.

---

## 3. System Overview

GridData is a one-way link with a **sender** (any device with a screen and a web browser) and a **receiver** (any device with a camera and a web browser). Both run entirely client-side; there is no server in the data path.

**Sender pipeline.** `bytes → DEFLATE → K fixed-size chunks → systematic fountain coding → frame assembly [type | seed | length | payload | CRC-32] → LDPC codeword → codeword whitening → byte interleaving → mapping to a coloured cell grid → animated display`.

**Receiver pipeline.** `camera frame → GPU crop/resize (createImageBitmap) → worker: pixel readback (OffscreenCanvas) → grid registration (homography) → per-cell sampling with optical-reliability estimate → soft colour demodulation with blind 3×3 MIMO un-mix → de-interleave → temporal soft-combining → LDPC belief propagation → CRC → fountain peeling → INFLATE → file/text`.

A short static payload is packed into a single self-contained frame (a QR-like still); larger payloads animate. The receiver requires **no manual configuration** (Section 8).

---

## 4. Visual Modulation and Encoding

**Cell grid.** The payload is displayed as a `G×G` grid of cells inside a white quiet zone and a black finder frame; an **asymmetric white orientation marker** in one frame corner resolves rotation ambiguity. Grids `G ∈ {16, 32, 64}` are exposed to the user; the receiver supports larger grids internally.

**Modulation modes.**
- **bw** — 1 bit/cell (black/white).
- **color8** — 3 bits/cell, one binary level per RGB channel (8 saturated colours).
- **color16/32/64** — multi-level per channel (2 bits ⇒ 4 levels on one, two, or three channels), i.e., 4/5/6 bits/cell.

**Gamma-aware level placement.** Multi-level bytes are placed so that the *observed* (post-display-gamma, ambient-compensated) levels are evenly spaced, maximising inter-level distance at the camera. Concretely, for level `ℓ ∈ {0..L−1}` we target an evenly-spaced observed value and invert an EOTF model with exponent `γ` and ambient fraction `a`; this yielded display bytes `{0, 112, 185, 255}` for `L=4` at `γ=2.2, a=0.03`.

**Calibration anchors.** Multi-level modes reserve a small set of leading cells that display *known* single-channel levels. The receiver reads these to learn the rendered→captured mapping per channel (Section 7). color8/bw use no anchors (a simple adaptive threshold suffices).

**Gray coding.** Adjacent physical levels map to data words differing by one bit, so the dominant "read level ℓ as ℓ±1" error costs one bit.

**Codeword whitening (anti-flicker).** A manifest frame carries a short, zero-padded payload, so its codeword is mostly zeros and would render markedly darker than data frames, producing a periodic on-screen flicker. We XOR every codeword with a fixed pseudo-random mask (derived from the codeword length, so both ends agree) before mapping to cells; the receiver undoes the mask at the LLR level by sign flips. This equalises per-frame brightness. *We note codeword scrambling is a standard technique; the contribution here is only its use to suppress the manifest-induced flicker.*

**Transport.** A systematic fountain code maps seeds `1..K` to the raw source chunks (so a clean channel reconstructs in ~K frames with zero overhead) and seeds `>K` to Robust-Soliton repair combinations. Byte interleaving spreads any contiguous on-screen error burst across the whole LDPC Tanner graph.

---

## 5. Contribution C1 — Optically-Coupled Soft-Decision Decoding

**Motivation.** A hard threshold discards *how confident* each cell read was. A sharp, well-focused cell reads nearly uniform inside its sampling window; a blurred cell, or one straddling a neighbour because registration drifted, reads with high internal variance; a glare-saturated cell has lost level information. This confidence is exactly what an iterative soft decoder can exploit.

**Per-cell optical reliability.** During homography-based sampling, for each cell we compute the mean channel values *and* the intra-cell luminance variance `σ²_L` over the sampling window, plus a clipped-pixel fraction. We define the optical reliability

```
rel = 1 / (1 + σ²_L / s²) · (1 − 0.5 · clipFraction),   rel ∈ (0, 1]
```

where `s` normalises against a nominal one-level colour step. A crisp cell yields `rel ≈ 1`; a smeared or saturated cell yields `rel → 0`.

**LLR weighting.** The soft demodulator produces per-bit LLRs (max-log approximation from distances to the calibrated levels). Each cell's LLR magnitudes are *multiplied by its reliability* `rel` before entering LDPC belief propagation. Belief propagation therefore trusts sharp cells and discounts smeared/saturated ones, without any change to the code structure.

**Why this is (to our knowledge) new.** Soft-decision decoding and reliability-weighted LLRs are classical; the specific step of deriving the reliability from **intra-cell image variance and saturation** — an *optical/focus* proxy computed at sampling time — and injecting it as the LLR prior of an **SCC** LDPC decoder is what we have not found in the SCC literature. This is a cross-layer coupling between the imaging front-end and the channel decoder.

---

## 6. Contribution C2 — Feedback-Free Temporal Soft-Combining

**Motivation.** A single hand-held capture of a dense colour frame is frequently below the decoding threshold. The sender, however, holds each displayed frame for several camera exposures, so the camera observes the *same codeword* multiple times, each an independent noise draw. Summing per-bit LLRs across looks (chase combining) raises the effective SNR roughly linearly in the number of looks.

**The problem: identity without a back-channel or frame counter.** Classical HARQ chase-combining knows which retransmission is which. Here there is no back-channel and (by design) no per-frame identifier readable before decoding. The receiver must decide "is this capture the *same displayed frame* I am accumulating?" *before* it has decoded either.

**Our solution: content-correlation identity.** We correlate the *sign pattern* of the soft-demod LLRs: two captures of the same frame agree on the vast majority of bit signs (over confident bits only), whereas two different frames agree on ~half. When the incoming capture's sign-agreement fraction with the running accumulator exceeds a threshold (0.80 in our implementation, over bits both are confident about), we add its LLRs; otherwise the displayed frame has advanced, so we finalise the old accumulator and start a new one. Accumulated magnitudes are clamped to bound long static holds.

**Interaction with the fountain layer.** Recovered chunks are peeled by the fountain decoder; C2 squeezes marginal frames out of the optical channel before they reach it. Together they form a two-stage soft/erasure decoder.

**Why this is (to our knowledge) new.** Temporal averaging/combining exists broadly; the specific *feedback-free, identifier-free* combining that establishes frame identity by **soft-demod sign correlation** in an SCC link is what we have not found reported.

---

## 7. Contribution C3 — Blind Per-Frame 3×3 Colour-MIMO Equalisation

**Motivation.** The display→camera colour path mixes channels (an R pattern leaks into the captured G/B) and applies per-channel gain and gamma. A per-channel scalar calibration cannot undo the *cross-channel* leakage, which is exactly what corrupts dense multi-level colour.

**Method.** From the black anchor(s) we estimate the per-channel offset (ambient/black level); from each channel's single-channel maximum-level anchor we obtain a column of the 3×3 mixing matrix `A` (the captured response when only that channel is driven). We invert `A` (guarding against near-singularity) and apply `Â⁻¹` to un-mix every data cell's `(R,G,B)` before per-channel level classification and LLR computation. Estimation is *blind* (no calibration image beyond the in-frame anchors) and *per-frame* (re-estimated each frame from that frame's anchors), so it tracks slow changes in lighting and white balance.

**Why this is (to our knowledge) new in this exact form.** Colour cross-talk correction is known in principle; the specific *blind, per-frame, full-3×3 inversion from embedded single-channel anchors, feeding the optically-weighted soft decoder of C1*, is the formulation we have not found in SCC prior art. (We flag this as the contribution most likely to have partial precedent and therefore most in need of prior-art verification.)

---

## 8. Contribution C4 — Automatic Configuration Detection

Prior receivers typically require the user to match the sender's encoding and grid. We remove this. Registration (locating the grid quad and computing the homography) is **grid-independent**, so per capture the receiver locates the grid once, then samples it at a rotating window of candidate `(encoding, grid, rate)` specifications and attempts a *fast* decode (hard decision + CRC-32) only. Because CRC-32 makes a false match astronomically unlikely (~2⁻³²), the first candidate whose frame passes CRC *is* the sender's configuration; the receiver locks it and decodes normally thereafter. The code rate is carried in the manifest and included in the search, giving adaptive-rate support "for free." Crucially, the search never runs full belief propagation (only the fast path), which we found essential to avoid stalling the worker.

---

## 9. Contribution C5 — Fully Client-Side, WebAssembly-Accelerated Implementation

The entire system runs in a web browser with no server in the data path.

**Off-main-thread decoding.** Registration, soft demodulation, MIMO un-mixing, and LDPC belief propagation run in a Web Worker. The main thread performs only a GPU-side crop/resize via `createImageBitmap` and transfers the bitmap; the worker performs the pixel readback on an `OffscreenCanvas`. This removes a large per-frame `getImageData` allocation from the UI thread, which we found to be the dominant cause of throughput stalls (Section 11).

**WebAssembly LDPC.** The belief-propagation decoder is compiled to WebAssembly (via AssemblyScript, installable from a package registry — no system toolchain required) with a pointer-based, allocation-free interop (the Tanner graph is uploaded once per code as flat CSR arrays; each decode ships only the LLRs). A pluggable backend installs the WASM decoder when ready and falls back to an equivalent JavaScript implementation otherwise; the two produce bit-identical output.

**Robustness.** The worker wraps each request in a single try/catch guaranteeing exactly one reply (an uncaught exception would otherwise wedge the capture loop); the capture loop has a watchdog and error guard; both ends acquire a screen wake-lock so idle dimming cannot freeze the animation or the camera.

---

## 10. Evaluation Methodology

We evaluate at two levels, and we keep them strictly separate.

**(A) Controlled channel simulation.** We built a screen-to-camera channel model that renders a frame's cells, applies (i) a 3×3 colour cross-talk matrix with per-channel white-balance gain and offset, (ii) display gamma, (iii) additive Gaussian noise, and (iv) an optional localised glare/blur patch (a fraction of cells with strongly elevated noise). The receiver path under test is the *actual system code* (the same encoder, demodulator, MIMO, soft-combiner, and LDPC decoder), bundled and run in Node.js. This isolates *algorithmic* behaviour from device-specific optics and compute. All simulation figures below are from this harness; they represent **algorithmic potential under a modelled channel, not device throughput.**

**(B) Real-device feasibility study.** We ran the deployed browser build with a single hand-held smartphone camera reading a second screen, in an office lighting environment, hand-held (no tripod). We report the *end-to-end* effective throughput and the receiver's live diagnostics (scan rate, per-frame worker time, WASM status). This is a **feasibility case study, not a multi-device evaluation.**

We regard multi-device, controlled-condition evaluation with human-subject-free repeatability as required future work (Section 13).

---

## 11. Results

### 11.1 Optical-reliability weighting (C1)

Under a localised glare patch on `color32`, grid 32 (single capture, MIMO enabled in both arms), turning on reliability weighting recovered frames that the unweighted arm dropped entirely:

| Glare fraction | No reliability | With reliability |
|---|---|---|
| 15% | 0% | **63%** |
| 30% | 0% | **18%** |
| 45% | 0% | 0% |

The mechanism converts "which cells are trustworthy" into decoder priors, recovering frames that a uniform-confidence decoder cannot.

### 11.2 Temporal soft-combining (C2)

For `color32`, grid 32, frame recovery as a function of the number of combined looks:

| Noise σ | 1 look | 2 looks | 3 looks | 4 looks |
|---|---|---|---|---|
| 14 | 83% | 93% | 98% | **100%** |
| 18 | 50% | 90% | 93% | **98%** |
| 22 | 40% | 73% | 90% | **100%** |

Combining a small number of otherwise-failing captures closes the frame — feedback-free.

### 11.3 Blind colour-MIMO (C3)

For `color64`, grid 32, low noise, as colour cross-talk increases, the classic per-channel arm fails while the MIMO arm extends the usable range (e.g., at a cross-talk coefficient of 0.25, the classic arm recovered 0% while the MIMO arm recovered a non-zero fraction; both fail at extreme cross-talk). We report this as a *range extension*, not a fixed multiplier, as the exact figure is sensitive to the operating point.

### 11.4 Automatic configuration detection (C4)

Across tested true configurations — `color8/64/r0.6`, `color64/96/r0.6`, `color64/96/r0.75`, `color32/128/r0.75`, `color64/200/r0.6` — the CRC-validated search locked the *correct* `(encoding, grid, rate)` in every case, including the higher code rate, with no false locks. An end-to-end reproduction (render→locate→search) confirmed a full candidate sweep completes in ~1–2 s of wall-clock work, chunked across captures.

### 11.5 WebAssembly LDPC (C5)

Over 60 randomly-drawn noisy codewords at a representative code size (`n = 24{,}504` bits), the WASM decoder produced **bit-identical** output to the JavaScript reference in 60/60 cases, at **~1.67×** the speed on heavy decodes, and instantiates and runs correctly in the browser's WebAssembly engine.

### 11.6 Real-device end-to-end optimisation

Starting from a functional-but-slow hand-held link, a sequence of systems changes improved effective throughput by ~11×:

| Stage | Change | Effect |
|---|---|---|
| Baseline | Working link, `color8`, grid 64 | ~0.4 KB/s |
| Off-main-thread decode | Web Worker | removed UI stalls |
| WASM LDPC | belief propagation in WASM | faster per-frame decode |
| Match processing to device | 1080p capture, reduced processing canvas | scan rate 1–2 → ~5/s |
| `createImageBitmap` + `OffscreenCanvas` | pixel readback off the main thread | scan rate reaches 10–12/s |
| **End state** | `color8`, grid 64, ~10 fps | **~3–4.4 KB/s** |

Receiver diagnostics at the end state: WASM active; per-frame worker time ~90–160 ms (now including the pixel readback); scan rate 10–12/s with occasional dips from hand motion. **This is device throughput (≈30 kbps), and must not be conflated with the simulator's algorithmic figures.**

---

## 12. The Physical Ceiling: Honest Findings

We consider the following two findings a genuine contribution, because they correct intuitions we ourselves initially held.

### 12.1 Multi-level intensity is not reliably resolvable hand-held

We verified directly (both from the encoder output and from the rendered on-screen canvas) that multi-level modes are encoded and displayed *correctly*: `color64` shows four distinct, gamma-optimised levels per channel `{0, 112, 185, 255}`. Yet on the hand-held phone, `color16/32/64` did not decode, while `color8`/bw did. The cause is physical: after display and camera gamma, the interior levels lie close, and hand-held optical blur merges adjacent levels regardless of (already gamma-optimised) placement. **On commodity hand-held smartphones, binary-per-channel (2 levels) is the practical modulation ceiling; ≥4 levels require a sharper, steadier, better-lit capture (e.g., a tripod and strong even lighting), or a better camera.** This is a limit of the sensor+optics, not of the encoding.

### 12.2 Throughput is bounded by the receiver's pixel-processing rate

The channel capacity of a full-matrix SCC link is bounded by `(sensor pixels) × (bits/pixel from SNR) × (frame rate)`. Two consequences that we initially mis-estimated:

- **Denser grids are near-neutral.** A grid with `k×` more cells needs `~k×` more captured pixels per cell to stay above the blur cutoff; raising the processing resolution to supply them slows the (pixel-bound) receiver by `~k×`, so *net* throughput changes little. Grid density trades against per-cell reliability at roughly constant capacity.
- **Rolling-shutter temporal multiplexing is near-neutral for a full matrix.** Rolling shutter re-labels *which instant* each sensor row observes but adds no sensor pixels; for a co-designed one-way full-matrix link the transmitter can already fill the frames the camera fully captures, so slicing time into bands yields `N` sub-frames of `1/N` the rows — the same total. (Rolling shutter helps only *transmitter-constrained* links such as a single LED.)

The genuine throughput levers are therefore **(i) more sensor pixels** (camera resolution), **(ii) more bits/pixel** (higher-order modulation, which C1–C3 enable *when the optics permit*), **(iii) frame rate**, and **(iv) code rate closer to capacity** (our adaptive-rate support). We report this explicitly because both "just use a denser grid" and "exploit rolling shutter for a 10–30× speed-up" are, for this setting, misconceptions.

---

## 13. Limitations, Threats to Validity, and Prior-Art Verification

**Evaluation scope.** The device results are a *single-device* feasibility study under uncontrolled hand-held conditions. Publication in a strong venue requires multi-device evaluation (varied sensors, resolutions, frame rates), controlled distance/angle/lighting sweeps, and statistical reporting (repetitions, confidence intervals). The simulator, while driven by the *actual system code*, uses a simplified channel (Gaussian noise, a linear 3×3 mix, a single blur/glare model) and does not model motion blur, rolling shutter, moiré, or auto-exposure dynamics.

**Simulation ≠ device.** The simulator measures algorithmic behaviour; the ~Mbps-scale figures sometimes discussed for SCC are *not* our device throughput, which is ≈30 kbps. We have kept these strictly separate and urge readers to do the same.

**Novelty is a claim requiring verification.** All novelty statements in this paper are "to the best of our knowledge." Before asserting priority or filing for protection, a formal prior-art search is **mandatory**, covering at least: IEEE Xplore, ACM Digital Library, USENIX, and Google Scholar for SCC / visual-light-communication / camera-communication; and patent databases (USPTO, EPO/Espacenet, WIPO/PATENTSCOPE, Google Patents). Search terms should include *screen-to-camera*, *camera communication*, *colour barcode*, *reliability-weighted LLR*, *per-cell confidence decoding*, *chase combining screen camera*, and *colour MIMO barcode*. We consider C3 (colour-MIMO) the contribution most likely to have partial precedent, and C1 (optical-variance-weighted LLR) and C2 (feedback-free content-correlation combining) the most likely to be new; none should be claimed as first without the search.

**Reproducibility.** The system is deterministic given the code; we will release the source, the channel simulator, and the exact scripts producing every table above.

---

## 14. Is This an Achievement? An Honest Self-Assessment

We believe this work constitutes a legitimate contribution of the *systems + mechanisms* kind rather than a foundational breakthrough. Its strengths are: a working, fully-client-side, auto-configuring, WASM-accelerated SCC pipeline; two mechanisms (C1, C2) whose specific formulation we have not found in prior SCC work; and an honest characterisation of the hand-held physical ceiling. Its weaknesses are: single-device evaluation, a simplified simulator, and reliance on classical coding primitives. In our assessment, the work is appropriate for a systems/mobile workshop, a conference short paper, or an arXiv preprint immediately, and for a journal after the multi-device evaluation of Section 13. We explicitly do **not** claim to exceed the physical capacity of the optical channel; no algorithm can, and stating so plainly is part of the contribution.

---

## 15. Conclusion and Future Work

We presented GridData, a fully client-side screen-to-camera transfer system, and a set of receiver-side mechanisms that couple image-domain confidence into channel decoding: optical-reliability-weighted LDPC decoding, feedback-free temporal soft-combining with content-correlation frame identity, and blind per-frame colour-MIMO, integrated with automatic configuration detection and a WebAssembly decode path. In a controlled simulator the mechanisms recover frames that hard-decision and uniform-confidence baselines drop, and on a hand-held phone a sequence of systems optimisations improved end-to-end throughput ~11× to ~3–4 KB/s. We also reported, honestly, the physical ceiling of hand-held browser SCC: binary-per-channel modulation is the practical maximum, and throughput is pixel-processing-bound, making grid density and rolling-shutter multiplexing near-neutral.

**Future work.** (i) A rigorous multi-device, controlled evaluation. (ii) A normalised min-sum WASM decoder to raise decode rate. (iii) Interior alignment (a reference lattice) to test whether denser grids can be made reliable *without* raising processing cost. (iii) Motion-robust registration and rolling-shutter/torn-frame rejection. (iv) A learned demodulator as a complementary front-end. (v) The prior-art search of Section 13, as a precondition to any priority claim.

---

## References (representative; to be completed and verified during prior-art search)

1. COBRA: colour barcode streaming for smartphone systems.
2. PixNet: LCD-camera pairs as communication links.
3. LightSync: unsynchronised visual communication.
4. Strata: layered/rateless coding for screen-camera links.
5. ChromaCode: robust, high-throughput colour barcode streaming.
6. RainBar: robust colour-barcode design for screen-camera.
7. HiLight: real-time unobtrusive screen-to-camera communication.
8. InFrame / InFrame++: embedding visible/invisible data in video.
9. RollingLight: rolling-shutter-based visible light communication.
10. DeepLight (and related): deep-learning screen-to-camera codes.
11. QR Code / Data Matrix standards (finder patterns, error correction).
12. Gallager, R. G. Low-Density Parity-Check Codes.
13. Luby, M. LT Codes; Shokrollahi, A. Raptor Codes.
14. Chase, D. A class of algorithms for decoding block codes with channel measurement information (chase combining).

*(Full bibliographic details to be added and cross-checked against the mandatory prior-art search of Section 13.)*
