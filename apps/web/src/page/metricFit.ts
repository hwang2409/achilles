const minimumSize = "12px";

export function observeMetricFit(strip: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const fit = () => fitMetricStrip(strip);
  const observer = new ResizeObserver(fit);
  observer.observe(strip);
  document.fonts?.addEventListener("loadingdone", fit);
  document.fonts?.addEventListener("loadingerror", fit);
  fit();
  return () => {
    observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", fit);
    document.fonts?.removeEventListener("loadingerror", fit);
  };
}

function fitMetricStrip(strip: HTMLElement) {
  const stripStyle = getComputedStyle(strip);
  const usableWidth = strip.getBoundingClientRect().width - parseFloat(stripStyle.borderLeftWidth) - parseFloat(stripStyle.borderRightWidth);
  if (!(usableWidth > 0)) return;
  let track = 0;
  const measures = [...strip.querySelectorAll<HTMLElement>(".metric-block")].flatMap(tile => {
    const style = getComputedStyle(tile);
    const inner = getComputedStyle(tile.querySelector(":scope > div")!);
    const mark = tile.querySelector<HTMLElement>(":scope > .record-mark");
    const marker = mark && getComputedStyle(mark);
    const markerWidth = marker && marker.position !== "absolute"
      ? mark.getBoundingClientRect().width + parseFloat(marker.marginLeft) + parseFloat(marker.marginRight) + parseFloat(style.columnGap)
      : 0;
    const insets = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(inner.paddingRight) + markerWidth;
    const tokens = [...tile.querySelectorAll<HTMLElement>(".metric-value-number, .metric-word")];
    return tokens.map((token, i) => ({ token, insets, word: token.textContent!, preceding: tokens[i - 1]?.textContent, probe: document.createElement("span") }));
  });
  // Measure real DOM text, including font fallback and the browser's glyph rounding.
  for (const { token, word, preceding, probe } of measures) {
    probe.className = "metric-measure";
    probe.textContent = preceding ? `${preceding} ${word}` : word;
    token.append(probe);
  }
  for (const { insets, probe } of measures) track = Math.max(track, insets + probe.getBoundingClientRect().width);
  for (const { word, probe } of measures) probe.textContent = word;
  const oversized = measures.filter(({ probe, insets }) => probe.getBoundingClientRect().width > usableWidth - insets);
  for (const { probe } of oversized) probe.style.fontSize = minimumSize;
  const breakable = new Set(oversized.filter(({ token, probe, insets }) => token.classList.contains("metric-word") && probe.getBoundingClientRect().width > usableWidth - insets));
  strip.style.setProperty("--metric-fit", `${Math.ceil(track)}px`);
  const fitted = new Set(oversized);
  for (const measure of measures) {
    const { token, probe } = measure;
    probe.remove();
    if (fitted.has(measure)) token.style.setProperty("--metric-fitted-size", minimumSize);
    else token.style.removeProperty("--metric-fitted-size");
    token.toggleAttribute("data-metric-breakable", breakable.has(measure));
  }
}
