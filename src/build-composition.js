import {
  EXPLAINER_DECK_CONFIG,
  PAINT_EXPLAINER_CHUNK_CONFIG,
} from './schemas.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const escapeAttr = escapeHtml;

const safeCssColor = (value, fallback) => {
  const color = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^[a-zA-Z]+$/.test(color)) {
    return color;
  }
  return fallback;
};

const sumDurations = (segments) =>
  segments.reduce((total, segment) => total + Number(segment.durationSec || 0), 0);

const TRACKS = {
  media: 1,
  labels: 1000,
  audio: 2000,
  logo: 2001,
  captions: 3000,
};

const normalizeWord = (word, index) => {
  const text = String(word?.text ?? word?.word ?? '').trim();
  const rawStart = Number(word?.startSec ?? word?.start ?? word?.start_ms ?? 0);
  const rawEnd = Number(word?.endSec ?? word?.end ?? word?.end_ms ?? rawStart);
  const startSec = Number.isFinite(rawStart) && rawStart > 1000 ? rawStart / 1000 : rawStart;
  const endSec = Number.isFinite(rawEnd) && rawEnd > 1000 ? rawEnd / 1000 : rawEnd;

  if (!text) {
    return null;
  }

  return {
    id: `${index}-${text}`,
    text,
    startSec: Math.max(0, startSec || 0),
    endSec: Math.max(startSec || 0, endSec || startSec || 0),
  };
};

const buildHead = ({width, height, background = '#f3f0e8'}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: ${background};
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      }
      #root {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: ${background};
      }
`;

const buildExplainerDeck = (props) => {
  const fps = EXPLAINER_DECK_CONFIG.fps;
  const width = EXPLAINER_DECK_CONFIG.width;
  const height = EXPLAINER_DECK_CONFIG.height;
  const slides = props.slides;
  const slideDurations = slides.map((slide) => (slide.durationInFrames ?? EXPLAINER_DECK_CONFIG.defaultSlideDuration) / fps);
  const transitionDurations = slides.map((slide, index) => {
    if (index >= slides.length - 1 || !slide.transition) {
      return 0;
    }
    return (slide.transition.durationInFrames ?? EXPLAINER_DECK_CONFIG.defaultTransitionDuration) / fps;
  });
  const starts = [];
  let cursor = 0;

  for (let index = 0; index < slides.length; index += 1) {
    starts.push(cursor);
    cursor += slideDurations[index] - transitionDurations[index];
  }

  const duration = Math.max(cursor, EXPLAINER_DECK_CONFIG.defaultSlideDuration / fps);
  const slideHtml = slides.map((slide, index) => {
    const background = safeCssColor(slide.background, index % 2 === 0 ? '#f3f0e8' : '#f5f5f5');
    const accent = safeCssColor(slide.accent, '#f4c542');

    return `      <section class="clip slide" id="slide-${index + 1}" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="${index + 1}" style="background: ${background}; --accent: ${accent}">
        <div class="frame">
          <h1 class="title">${escapeHtml(slide.title)}</h1>
          <div class="body">
            <div class="seal"></div>
            <p class="subtitle">${escapeHtml(slide.subtitle)}</p>
          </div>
          <div class="badge-wrap"><div class="badge">HyperFrames + Coolify Starter</div></div>
        </div>
      </section>`;
  }).join('\n\n');

  const transitionJs = slides.map((slide, index) => {
    if (index >= slides.length - 1 || !slide.transition) {
      return '';
    }

    const next = `#slide-${index + 2}`;
    const current = `#slide-${index + 1}`;
    const at = starts[index + 1];
    const transitionDuration = transitionDurations[index];

    if (slide.transition.type === 'fade') {
      return `      tl.fromTo("${next}", { opacity: 0, x: 0 }, { opacity: 1, duration: ${transitionDuration.toFixed(3)}, ease: "none" }, ${at.toFixed(3)});
      tl.to("${current}", { opacity: 0, duration: ${transitionDuration.toFixed(3)}, ease: "none" }, ${at.toFixed(3)});`;
    }

    const direction = slide.transition.direction ?? 'from-right';
    const axis = direction === 'from-top' || direction === 'from-bottom' ? 'y' : 'x';
    const amount = direction === 'from-left' || direction === 'from-top' ? -1 : 1;
    const distance = axis === 'x' ? width * amount : height * amount;

    return `      tl.fromTo("${next}", { ${axis}: ${distance}, opacity: 1 }, { ${axis}: 0, duration: ${transitionDuration.toFixed(3)}, ease: "none" }, ${at.toFixed(3)});
      tl.to("${current}", { ${axis}: ${-distance * 0.1}, duration: ${transitionDuration.toFixed(3)}, ease: "none" }, ${at.toFixed(3)});`;
  }).filter(Boolean).join('\n');

  return `${buildHead({width, height})}
      .slide {
        position: absolute;
        inset: 0;
        padding: 80px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #111111;
        will-change: transform, opacity;
      }
      .frame {
        width: 100%;
        height: 100%;
        padding: 48px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        background: #f8f8f3;
        border: 8px solid #111111;
        border-radius: 30px;
      }
      .title {
        font-size: 78px;
        line-height: 0.98;
        font-weight: 900;
        text-align: center;
        text-transform: uppercase;
        color: #111111;
      }
      .body {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 40px;
      }
      .seal {
        position: relative;
        width: 280px;
        height: 280px;
        flex: 0 0 auto;
        border-radius: 50%;
        border: 10px solid #111111;
        background: #ffffff;
      }
      .seal::before {
        content: "";
        position: absolute;
        inset: -28px;
        border-radius: 50%;
        border: 18px solid var(--accent);
        opacity: 0.3;
      }
      .seal::after {
        content: "";
        position: absolute;
        inset: 82px;
        border-radius: 50%;
        background: var(--accent);
        border: 8px solid #111111;
      }
      .subtitle {
        max-width: 900px;
        padding: 32px 40px;
        border: 8px solid #111111;
        border-radius: 24px;
        background: #ffffff;
        font-size: 48px;
        line-height: 1.2;
        text-align: center;
      }
      .badge-wrap { display: flex; justify-content: center; }
      .badge {
        padding: 12px 28px;
        border: 6px solid #111111;
        border-radius: 999px;
        background: var(--accent);
        color: #111111;
        font-size: 32px;
        line-height: 1.1;
        font-weight: 700;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration.toFixed(3)}" data-width="${width}" data-height="${height}">
${slideHtml}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const slides = ${JSON.stringify(slides.map((_, index) => `#slide-${index + 1}`))};
      const starts = ${JSON.stringify(starts.map((value) => Number(value.toFixed(3))))};
      gsap.set(slides, { opacity: 0, x: ${width} });
      gsap.set("#slide-1", { opacity: 1, x: 0, y: 0 });
      slides.forEach((selector, index) => {
        const start = starts[index];
        tl.from(selector + " .title", { y: 48, opacity: 0, duration: 0.8, ease: "power3.out" }, start);
        tl.from(selector + " .body", { y: 24, opacity: 0, duration: 0.92, ease: "power3.out" }, start + 0.2);
        tl.from(selector + " .badge", { scale: 0.92, opacity: 0, duration: 0.66, ease: "back.out(1.6)" }, start + 0.4);
      });
${transitionJs}
      tl.to("#slide-${slides.length}", { opacity: 1, duration: 0.001 }, ${(duration - 0.001).toFixed(3)});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
};

const buildPaintExplainerChunk = (props) => {
  const fps = props.fps ?? PAINT_EXPLAINER_CHUNK_CONFIG.fps;
  const width = props.width ?? PAINT_EXPLAINER_CHUNK_CONFIG.width;
  const height = props.height ?? PAINT_EXPLAINER_CHUNK_CONFIG.height;
  const segments = props.segments;
  const duration = Math.max(1, sumDurations(segments));
  const words = (props.captions?.words ?? []).map(normalizeWord).filter(Boolean);
  let cursor = 0;

  const segmentHtml = segments.map((segment, index) => {
    const start = cursor;
    const segmentDuration = Number(segment.durationSec || 0);
    cursor += segmentDuration;
    const id = `segment-${index + 1}`;
    const title = segment.chapterTitle || segment.segmentType || '';
    const mediaClass = `clip segment-media ${segment.zoom ? 'zoomable' : ''}`;
    const asset = segment.assetType === 'video'
      ? `<video class="${mediaClass}" id="${id}-media" data-start="${start.toFixed(3)}" data-duration="${segmentDuration.toFixed(3)}" data-track-index="${TRACKS.media + index}" src="${escapeAttr(segment.src)}" muted playsinline></video>`
      : `<img class="${mediaClass}" id="${id}-media" data-start="${start.toFixed(3)}" data-duration="${segmentDuration.toFixed(3)}" data-track-index="${TRACKS.media + index}" src="${escapeAttr(segment.src)}" alt="" />`;

    return `      ${asset}
      ${title ? `<div class="clip chapter-label" id="${id}-label" data-start="${start.toFixed(3)}" data-duration="${segmentDuration.toFixed(3)}" data-track-index="${TRACKS.labels + index}">${escapeHtml(title)}</div>` : ''}`;
  }).join('\n\n');

  const audioHtml = props.audioUrl
    ? `      <audio id="voiceover" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="${TRACKS.audio}" src="${escapeAttr(props.audioUrl)}" data-volume="1"></audio>`
    : '';

  const logoHtml = props.logoUrl
    ? `      <img class="clip logo" id="logo" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="${TRACKS.logo}" src="${escapeAttr(props.logoUrl)}" alt="" />`
    : '';

  const captionsHtml = words.map((word, index) => {
    const wordDuration = Math.max(0.05, word.endSec - word.startSec);
    return `      <span class="clip caption-word" id="word-${index + 1}" data-start="${word.startSec.toFixed(3)}" data-duration="${wordDuration.toFixed(3)}" data-track-index="${TRACKS.captions + index}">${escapeHtml(word.text)}</span>`;
  }).join('\n');

  return `${buildHead({width, height, background: '#111111'})}
      .segment-media {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        overflow: hidden;
        background: #111111;
        will-change: opacity, transform;
      }
      .chapter-label {
        position: absolute;
        left: 28px;
        top: 24px;
        max-width: 58%;
        padding: 10px 16px;
        border: 3px solid #111111;
        background: #f8f8f3;
        color: #111111;
        font-size: 22px;
        line-height: 1.1;
        font-weight: 900;
        text-transform: uppercase;
      }
      .logo {
        position: absolute;
        top: 22px;
        right: 22px;
        width: 76px;
        height: 76px;
        object-fit: cover;
        border: 4px solid #111111;
        background: #f8f8f3;
        z-index: 20;
      }
      .caption-word {
        position: absolute;
        left: 50%;
        bottom: 42px;
        max-width: 86%;
        padding: 10px 18px;
        border: 4px solid #111111;
        border-radius: 8px;
        background: #f8f8f3;
        color: #111111;
        font-size: 40px;
        line-height: 1.08;
        font-weight: 900;
        text-align: center;
        text-transform: uppercase;
        z-index: 30;
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration.toFixed(3)}" data-width="${width}" data-height="${height}">
${segmentHtml}
${audioHtml}
${logoHtml}
${captionsHtml}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const segments = ${JSON.stringify(segments.map((segment, index) => ({
        selector: `#segment-${index + 1}-media`,
        start: segments.slice(0, index).reduce((total, current) => total + Number(current.durationSec || 0), 0),
        duration: Number(segment.durationSec || 0),
        transition: String(segment.transition || ''),
        zoom: String(segment.zoom || ''),
      })))};

      segments.forEach((segment) => {
        if (segment.zoom) {
          tl.fromTo(segment.selector, { scale: 1 }, { scale: 1.06, duration: segment.duration, ease: "none" }, segment.start);
        }
      });
      if (document.querySelector(".logo")) {
        tl.from(".logo", { scale: 0.88, opacity: 0, duration: 0.3, ease: "power2.out" }, 0.2);
      }
      if (document.querySelector(".caption-word")) {
        gsap.set(".caption-word", { xPercent: -50 });
        tl.fromTo(
          ".caption-word",
          { xPercent: -50, y: 14, opacity: 0 },
          { xPercent: -50, y: 0, opacity: 1, duration: 0.08, ease: "power2.out", stagger: 0 },
          0
        );
      }
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
};

export const buildCompositionHtml = ({compositionId, props}) => {
  if (compositionId === 'PaintExplainerChunk') {
    return buildPaintExplainerChunk(props);
  }

  return buildExplainerDeck(props);
};
