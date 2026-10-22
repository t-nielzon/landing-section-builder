import { phoneContext, screenshotRange, scrollThrough } from "./browser.ts";

export type SourceNode =
  | { t: "text"; text: string; tag: string; s: string; y: number; x: number; w: number; h: number; data?: Record<string, string>; html?: string }
  | { t: "icon"; count: number; y: number; x: number; w: number; h: number; fill?: string }
  | { t: "img"; src: string; alt: string; y: number; x: number; w: number; h: number; fit?: string; offscreen?: boolean; bg?: boolean }
  | { t: "box"; y: number; x: number; w: number; h: number; bg?: string; border?: string; radius?: string; shadow?: string }
  | { t: "control"; kind: string; y: number; x: number; w: number; h: number; checked?: boolean };

export interface SourceSection {
  index: number;
  sourceId: string;
  type: string;
  top: number;
  height: number;
  background: string;
  animated: string[];
  nodes: SourceNode[];
}

export interface SourceExtract {
  url: string;
  viewport: { width: number; height: number };
  styles: Record<string, Record<string, string>>;
  sections: SourceSection[];
  screenshots: { section: number; part: number; png: Buffer }[];
}

// runs inside the page; kept self-contained because playwright serialises it
function collect(limit: number) {
  const styles: Record<string, Record<string, string>> = {};
  const styleIds = new Map<string, string>();
  const styleId = (cs: CSSStyleDeclaration) => {
    const s: Record<string, string> = {
      font: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
      size: cs.fontSize,
      weight: cs.fontWeight,
      color: cs.color,
      align: cs.textAlign,
      lh: cs.lineHeight,
    };
    if (cs.letterSpacing !== "normal") s.ls = cs.letterSpacing;
    if (cs.textTransform !== "none") s.tt = cs.textTransform;
    if (cs.fontStyle !== "normal") s.fs = cs.fontStyle;
    if (cs.textDecorationLine !== "none") s.td = cs.textDecorationLine;
    // gradient headings paint their colour through the background, not `color`
    if ((cs as any).webkitBackgroundClip === "text" || cs.backgroundClip === "text") s.gradient = cs.backgroundImage;
    const key = JSON.stringify(s);
    if (!styleIds.has(key)) {
      const id = `s${styleIds.size + 1}`;
      styleIds.set(key, id);
      styles[id] = s;
    }
    return styleIds.get(key)!;
  };
  const transparent = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const abs = (u: string) => {
    if (!u) return u;
    const url = new URL(u, location.href);
    // drop resize params so the store imports the original asset
    url.searchParams.delete("width");
    url.searchParams.delete("height");
    url.searchParams.delete("crop");
    return url.href;
  };

  const all = [...document.querySelectorAll<HTMLElement>('[id^="shopify-section-template"]')];
  const sections = all.filter((s) => s.getBoundingClientRect().height > 20).slice(0, limit);

  return {
    styles,
    sections: sections.map((section, index) => {
      const top = section.getBoundingClientRect().top + scrollY;
      const nodes: any[] = [];
      const animated = new Set<string>();
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.top + scrollY - top), x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const handled = new Set<Element>();
      // inline formatting matters for rich text settings, so keep bold/italic/colour runs as light html
      const inlineHtml = (el: Element, base: CSSStyleDeclaration): string =>
        [...el.childNodes]
          .map((n) => {
            if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").replace(/\s+/g, " ");
            if (!(n instanceof HTMLElement)) return "";
            if (n.tagName === "BR") return "<br>";
            const cs = getComputedStyle(n);
            let inner = inlineHtml(n, cs);
            if (Number(cs.fontWeight) >= 600 && Number(base.fontWeight) < 600) inner = `<strong>${inner}</strong>`;
            if (cs.fontStyle === "italic" && base.fontStyle !== "italic") inner = `<em>${inner}</em>`;
            if (cs.color !== base.color) inner = `<span style="color:${cs.color}">${inner}</span>`;
            if (n.tagName === "A") inner = `<a>${inner}</a>`;
            return inner;
          })
          .join("");
      const isInline = (n: Element) => /^inline/.test(getComputedStyle(n).display) && !(n instanceof HTMLImageElement) && !(n instanceof SVGElement);
      for (const el of section.querySelectorAll<HTMLElement>("*")) {
        if (handled.has(el) || (el.parentElement && handled.has(el.parentElement))) {
          handled.add(el);
          continue;
        }
        if (!el.checkVisibility({ opacityProperty: false, visibilityProperty: true })) continue;
        if (el instanceof SVGSVGElement) {
          const b = box(el);
          if (b.w > 2 && b.h > 2) {
            const prev = nodes[nodes.length - 1];
            const fill = getComputedStyle(el).fill;
            if (prev?.t === "icon" && prev.y === b.y && prev.w === b.w) prev.count++;
            else nodes.push({ t: "icon", count: 1, ...b, fill: fill !== "rgb(0, 0, 0)" ? fill : getComputedStyle(el).color });
          }
          handled.add(el);
          continue;
        }
        const b = box(el);
        if (b.w <= 2 || b.h <= 2) continue;
        const cs = getComputedStyle(el);
        if (cs.animationName !== "none" || /opacity|transform/.test(cs.transitionProperty)) {
          const cls = (el.className && typeof el.className === "string" ? el.className.split(/\s+/)[0] : el.tagName.toLowerCase()) || "";
          if (cls) animated.add(`${cls}: ${cs.animationName !== "none" ? `animation ${cs.animationName}` : `transition ${cs.transitionProperty}`}`);
        }
        if (el instanceof HTMLImageElement) {
          const src = abs(el.currentSrc || el.src);
          if (src && !src.startsWith("data:")) {
            nodes.push({ t: "img", src, alt: el.alt, ...b, fit: cs.objectFit !== "fill" ? cs.objectFit : undefined, offscreen: b.x >= innerWidth || b.x + b.w <= 0 || undefined });
          }
          continue;
        }
        const bgImage = cs.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
        if (bgImage) nodes.push({ t: "img", src: abs(bgImage[1]), alt: "", ...b, bg: true });
        if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
          nodes.push({ t: "control", kind: el.type, ...b, checked: el.checked });
        }
        const hasBorder = cs.borderTopWidth !== "0px" && cs.borderTopStyle !== "none";
        if ((!transparent(cs.backgroundColor) || hasBorder || cs.boxShadow !== "none") && b.w > 16 && b.h > 10) {
          nodes.push({
            t: "box",
            ...b,
            bg: transparent(cs.backgroundColor) ? undefined : cs.backgroundColor,
            border: hasBorder ? `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` : undefined,
            radius: cs.borderRadius !== "0px" ? cs.borderRadius : undefined,
            shadow: cs.boxShadow !== "none" ? cs.boxShadow : undefined,
          });
        }
        const children = [...el.children];
        const rich =
          !/^inline/.test(cs.display) &&
          children.length > 0 &&
          children.every(isInline) &&
          [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        if (rich) {
          const html = inlineHtml(el, cs).replace(/\s+/g, " ").trim();
          const plain = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          nodes.push({ t: "text", text: plain, html, tag: el.tagName.toLowerCase(), s: styleId(cs), ...b });
          for (const c of children) handled.add(c);
          continue;
        }
        const text = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) {
          const data: Record<string, string> = {};
          for (const a of el.attributes) if (a.name.startsWith("data-")) data[a.name] = a.value.slice(0, 60);
          nodes.push({ t: "text", text, tag: el.tagName.toLowerCase(), s: styleId(cs), ...b, data: Object.keys(data).length ? data : undefined });
        }
      }
      nodes.sort((a, b) => a.y - b.y || a.x - b.x);
      return {
        index: index + 1,
        sourceId: section.id,
        type: section.id.replace(/^.*__/, "").replace(/_[A-Za-z0-9]{6}$/, ""),
        top: Math.round(top),
        height: Math.round(section.getBoundingClientRect().height),
        background: getComputedStyle(section.firstElementChild ?? section).backgroundColor,
        animated: [...animated].slice(0, 12),
        nodes,
      };
    }),
  };
}

export async function extractSource(url: string, sectionCount = 3): Promise<SourceExtract> {
  const origin = new URL(url).origin;
  // pin the storefront to usd so geo-based currency conversion doesn't leak local prices into the copy
  const context = await phoneContext([
    { name: "localization", value: "US", url: origin },
    { name: "cart_currency", value: "USD", url: origin },
  ]);
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await scrollThrough(page);
    // trigger reveal animations section by section so screenshots show the settled state
    const tops = await page.evaluate((limit) => {
      const all = [...document.querySelectorAll<HTMLElement>('[id^="shopify-section-template"]')];
      return all.filter((s) => s.getBoundingClientRect().height > 20).slice(0, limit).map((s) => s.getBoundingClientRect().top + scrollY);
    }, sectionCount);
    for (const top of tops) {
      await page.evaluate((y) => window.scrollTo(0, y), top);
      await page.waitForTimeout(1800);
    }
    const { styles, sections } = await page.evaluate(collect, sectionCount);
    const screenshots: SourceExtract["screenshots"] = [];
    for (const section of sections) {
      const shots = await screenshotRange(page, section.top, section.height);
      shots.forEach((png, i) => screenshots.push({ section: section.index, part: i + 1, png }));
    }
    return { url, viewport: page.viewportSize()!, styles, sections, screenshots };
  } finally {
    await context.close();
  }
}
