const minimumSize = 12;

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

export function balancedMetricRows(tileCount: number, maxColumns: number): number[] {
  const rows = Math.ceil(tileCount / maxColumns);
  const perRow = Math.floor(tileCount / rows);
  const extra = tileCount % rows;
  return Array.from({ length: rows }, (_, index) => perRow + Number(index < extra));
}

function fitMetricStrip(strip: HTMLElement) {
  const stripStyle = getComputedStyle(strip);
  const usableWidth = strip.getBoundingClientRect().width - parseFloat(stripStyle.borderLeftWidth) - parseFloat(stripStyle.borderRightWidth);
  if (!(usableWidth > 0)) return;
  strip.style.removeProperty("--metric-value-size");
  const tiles = [...strip.querySelectorAll<HTMLElement>("[data-metric-block]")];
  const measures = tiles.flatMap(tile => {
    const style = getComputedStyle(tile);
    const inner = getComputedStyle(tile.querySelector(":scope > div")!);
    const mark = tile.querySelector<HTMLElement>(":scope > [data-record-mark]");
    const marker = mark && getComputedStyle(mark);
    const markerWidth = marker && marker.position !== "absolute"
      ? mark.getBoundingClientRect().width + parseFloat(marker.marginLeft) + parseFloat(marker.marginRight) + parseFloat(style.columnGap)
      : 0;
    const insets = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(inner.paddingRight) + markerWidth;
    const tokens = [...tile.querySelectorAll<HTMLElement>("[data-metric-number], [data-metric-word]")];
    return tokens.map((token, i) => ({ token, insets, word: token.textContent!, preceding: tokens[i - 1]?.textContent, probe: document.createElement("span") }));
  });
  if (!measures.length) return;
  // Measure real DOM text, including font fallback and the browser's glyph rounding.
  for (const { token, word, probe } of measures) {
    probe.className = "absolute invisible w-max whitespace-nowrap";
    probe.textContent = word;
    token.append(probe);
  }
  const fits = ({ probe, insets }: typeof measures[number]) => probe.getBoundingClientRect().width <= usableWidth - insets;
  if (!measures.every(fits)) {
    // Use the largest shared whole-pixel size that fits an unbroken token in one column.
    let low = minimumSize;
    let high = Math.floor(parseFloat(getComputedStyle(measures[0].token).fontSize));
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      strip.style.setProperty("--metric-value-size", `${size}px`);
      if (measures.every(fits)) low = size;
      else high = size - 1;
    }
    strip.style.setProperty("--metric-value-size", `${low}px`);
  }
  for (const { preceding, word, probe } of measures) {
    if (preceding) probe.textContent = `${preceding} ${word}`;
  }
  const track = Math.max(...measures.map(({ insets, probe }) => insets + probe.getBoundingClientRect().width));
  strip.style.setProperty("--metric-fit", `${Math.ceil(track)}px`);
  for (const { probe } of measures) probe.remove();

  // Let the existing CSS floor and the measured value widths set the upper bound.
  strip.style.removeProperty("grid-template-columns");
  for (const tile of tiles) tile.style.removeProperty("grid-column");
  const maxColumns = Math.min(tiles.length, getComputedStyle(strip).gridTemplateColumns.split(" ").filter(track => parseFloat(track) > 0).length);
  if (maxColumns < 2) return;
  const rows = balancedMetricRows(tiles.length, maxColumns);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === maxColumns && first === last) return;

  // Unequal row sizes differ by one, so their product is their least common multiple.
  const tracks = first === last ? first : first * last;
  strip.style.gridTemplateColumns = `repeat(${tracks}, minmax(0, 1fr))`;
  let index = 0;
  for (const cells of rows) {
    for (let cell = 0; cell < cells; cell++) tiles[index++].style.gridColumn = `span ${tracks / cells}`;
  }
}
