/** Маленький помощник для DOM: h("div.class", {атрибуты}, ...дети). Без фреймворков. */
type Child = Node | string | number | null | undefined | false | Child[];
export function h<T extends HTMLElement = HTMLElement>(sel: string, attrs?: Record<string, unknown> | Child, ...kids: Child[]): T {
  const [tag, ...cls] = sel.split(".");
  const el = document.createElement(tag || "div") as unknown as T;
  if (cls.length) el.className = cls.join(" ");
  if (attrs && typeof attrs === "object" && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  } else if (attrs !== undefined) kids.unshift(attrs as Child);
  const add = (c: Child) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : String(c)); };
  kids.forEach(add);
  return el;
}
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
