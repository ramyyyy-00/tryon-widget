// Live virtual try-on widget (MVP).
//
// A brand adds ONE line to its website:
//   <script type="module" src="https://YOUR-SERVER/widget/tryon-widget.js"
//           data-brand="demo" data-lang="ar"></script>
// and marks each product with:
//   <div data-tryon-image="/images/hoodie.png" data-tryon-name="Grey hoodie"> ... </div>
// The widget adds a "Try on" button to every marked product.

const SCRIPT_URL = new URL(import.meta.url);
const API_BASE = SCRIPT_URL.origin;

// Reads settings from the <script> tag (data-brand, data-lang, data-model, data-seconds).
const tag = [...document.querySelectorAll("script[type=module]")].find((s) => s.src && s.src.includes("tryon-widget"));
const CONFIG = {
  brandId: tag?.dataset.brand || "demo",
  lang: tag?.dataset.lang || "en",
  // Model name taken from Decart's try-on docs. If Decart renames it, change it here.
  model: tag?.dataset.model || "lucy-vton-latest",
  sessionSeconds: Number(tag?.dataset.seconds || 60),
  selector: tag?.dataset.selector || "[data-tryon-image]",
};

const TEXT = {
  en: {
    button: "Try on",
    title: "Virtual try-on",
    consent:
      "To show the item on you, your camera video is sent to our AI provider for processing. We do not save your video. Allow camera?",
    start: "Start camera",
    cancel: "Cancel",
    close: "Close",
    connecting: "Connecting...",
    stepBack: "Step back so your upper body is visible.",
    timeLeft: "seconds left",
    ended: "Session ended.",
    errorCamera: "Camera access was denied or is not available.",
    errorGeneric: "Could not start the try-on. Please try again later.",
  },
  ar: {
    button: "جرّب المنتج",
    title: "تجربة افتراضية",
    consent:
      "لعرض القطعة عليك، سيتم إرسال فيديو الكاميرا إلى مزوّد الذكاء الاصطناعي لمعالجته. نحن لا نحفظ الفيديو. هل تسمح بفتح الكاميرا؟",
    start: "افتح الكاميرا",
    cancel: "إلغاء",
    close: "إغلاق",
    connecting: "جارٍ الاتصال...",
    stepBack: "ابتعد قليلًا حتى يظهر الجزء العلوي من جسمك.",
    timeLeft: "ثانية متبقية",
    ended: "انتهت الجلسة.",
    errorCamera: "تم رفض الوصول للكاميرا أو أنها غير متاحة.",
    errorGeneric: "تعذّر بدء التجربة. حاول مرة أخرى لاحقًا.",
  },
};
const T = TEXT[CONFIG.lang] || TEXT.en;
const DIR = CONFIG.lang === "ar" ? "rtl" : "ltr";

// ---------- styles ----------
const style = document.createElement("style");
style.textContent = `
.tryon-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;margin-top:8px;border:2px solid #111;background:#111;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;border-radius:6px}
.tryon-btn:hover{background:#fff;color:#111}
.tryon-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px}
.tryon-modal{background:#fff;color:#111;width:min(520px,100%);max-height:100%;overflow:auto;border-radius:12px;padding:20px;font:16px/1.5 system-ui,sans-serif}
.tryon-modal h2{margin:0 0 12px;font-size:20px}
.tryon-row{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.tryon-row button{min-height:44px;padding:10px 18px;border-radius:6px;border:2px solid #111;font:600 14px system-ui,sans-serif;cursor:pointer;background:#fff;color:#111}
.tryon-row button.primary{background:#111;color:#fff}
.tryon-video{width:100%;aspect-ratio:3/4;background:#000;border-radius:8px;object-fit:cover}
.tryon-status{margin:8px 0 0;font-size:14px;color:#444}
.tryon-error{color:#b00020}
`;
document.head.appendChild(style);

// ---------- helpers ----------
let sdkPromise = null;
function loadSdk() {
  // Loaded from a CDN only when someone actually clicks "Try on".
  // For production, pin an exact version (e.g. @decartai/sdk@x.y.z) or bundle it yourself.
  sdkPromise ??= import("https://esm.sh/@decartai/sdk");
  return sdkPromise;
}

async function fetchToken() {
  const res = await fetch(`${API_BASE}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brandId: CONFIG.brandId }),
  });
  if (!res.ok) throw new Error("token request failed: " + res.status);
  const t = await res.json();
  // The token JSON shape comes from Decart's SDK. If connecting fails, log `t`
  // and adjust this line to match the field that holds the client key.
  return t.apiKey ?? t.token ?? t.key ?? t;
}

function defaultPrompt(name) {
  return (
    `Substitute the current top with ${name || "the garment shown in the reference image"}, ` +
    "matching its exact color, pattern, material and fit, worn naturally on the person."
  );
}

// ---------- modal flow ----------
function openTryOn({ imageUrl, name, prompt }) {
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "tryon-overlay";
  overlay.innerHTML = `
    <div class="tryon-modal" role="dialog" aria-modal="true" aria-labelledby="tryon-title" dir="${DIR}">
      <h2 id="tryon-title">${T.title}${name ? " — " + escapeHtml(name) : ""}</h2>
      <div id="tryon-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector("#tryon-body");

  let rtClient = null;
  let stream = null;
  let timer = null;

  const cleanup = () => {
    clearInterval(timer);
    try { rtClient?.disconnect(); } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    previouslyFocused?.focus?.();
  };
  const onKey = (e) => { if (e.key === "Escape") cleanup(); };
  document.addEventListener("keydown", onKey);

  // Step 1: consent
  body.innerHTML = `
    <p>${T.consent}</p>
    <div class="tryon-row">
      <button class="primary" id="tryon-start">${T.start}</button>
      <button id="tryon-cancel">${T.cancel}</button>
    </div>`;
  body.querySelector("#tryon-cancel").onclick = cleanup;
  const startBtn = body.querySelector("#tryon-start");
  startBtn.focus();

  startBtn.onclick = async () => {
    body.innerHTML = `
      <video class="tryon-video" id="tryon-out" autoplay playsinline muted></video>
      <p class="tryon-status" id="tryon-status" aria-live="polite">${T.connecting}</p>
      <div class="tryon-row"><button id="tryon-close">${T.close}</button></div>`;
    body.querySelector("#tryon-close").onclick = cleanup;
    const video = body.querySelector("#tryon-out");
    const status = body.querySelector("#tryon-status");
    const fail = (msg) => { status.textContent = msg; status.classList.add("tryon-error"); };

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } catch {
        return fail(T.errorCamera);
      }

      const { createDecartClient, models } = await loadSdk();
      const client = createDecartClient({ apiKeyProvider: fetchToken });
      rtClient = await client.realtime.connect(stream, {
        model: models.realtime(CONFIG.model),
        onRemoteStream: (remote) => { video.srcObject = remote; },
      });

      const garment = await (await fetch(imageUrl)).blob();
      await rtClient.set({ prompt: prompt || defaultPrompt(name), image: garment, enhance: false });

      let left = CONFIG.sessionSeconds;
      status.textContent = `${T.stepBack} (${left} ${T.timeLeft})`;
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          try { rtClient.disconnect(); } catch {}
          stream?.getTracks().forEach((t) => t.stop());
          status.textContent = T.ended;
        } else {
          status.textContent = `${T.stepBack} (${left} ${T.timeLeft})`;
        }
      }, 1000);
    } catch (err) {
      console.error("[tryon]", err);
      fail(T.errorGeneric);
    }
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- attach buttons ----------
function attachButtons() {
  document.querySelectorAll(CONFIG.selector).forEach((el) => {
    if (el.querySelector(".tryon-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tryon-btn";
    btn.textContent = T.button;
    btn.addEventListener("click", () =>
      openTryOn({
        imageUrl: el.dataset.tryonImage,
        name: el.dataset.tryonName,
        prompt: el.dataset.tryonPrompt,
      })
    );
    el.appendChild(btn);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attachButtons);
else attachButtons();
