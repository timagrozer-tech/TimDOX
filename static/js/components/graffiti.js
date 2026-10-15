// Граффити, как раньше во «ВКонтакте»: рисунок от руки на стене — своей или друга.
// Холст 600×300, палитра, толщина и прозрачность кисти, «Отменить» и «Очистить». Готовый рисунок — обычная PNG-картинка.
import { h, icon } from "../dom.js";
import { modal, toast } from "../ui.js";

const W = 600, H = 300;
const COLORS = ["#000000", "#5b7da3", "#d2372c", "#f28c1a", "#f5d020", "#3ca33c", "#25a3c4", "#7b3fb5", "#e75480", "#8b5a2b", "#7f8c8d", "#ffffff"];
const SIZES = [2, 5, 10, 20];

/** Открыть редактор; промис отдаёт File (PNG) или null, если закрыли */
export function drawGraffiti() {
  return new Promise((resolve) => {
    const canvas = h("canvas.gf-canvas", { width: W * 2, height: H * 2, "aria-label": "Холст для рисования" });
    const g = canvas.getContext("2d");
    g.scale(2, 2);
    g.lineCap = "round"; g.lineJoin = "round";
    const reset = () => { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height); g.restore(); };
    reset();
    let color = COLORS[0], size = SIZES[1], alpha = 1;
    const history = [];
    let drawing = false, last = null, dirty = false;

    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }; };
    const snapshot = () => { history.push(g.getImageData(0, 0, canvas.width, canvas.height)); if (history.length > 30) history.shift(); };
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      snapshot();
      drawing = true; dirty = true; last = pos(e);
      g.globalAlpha = alpha; g.strokeStyle = color; g.fillStyle = color; g.lineWidth = size;
      g.beginPath(); g.arc(last.x, last.y, size / 2, 0, Math.PI * 2); g.fill();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const pts = co.length ? co : [e];
      for (const ev of pts) {
        const p = pos(ev);
        g.beginPath(); g.moveTo(last.x, last.y);
        // плавная линия: середина между точками сглаживает «ступеньки» при быстром движении
        const mx = (last.x + p.x) / 2, my = (last.y + p.y) / 2;
        g.quadraticCurveTo(last.x, last.y, mx, my); g.lineTo(p.x, p.y); g.stroke();
        last = p;
      }
    });
    const stop = () => { drawing = false; g.globalAlpha = 1; };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);

    const swatches = h("div.gf-colors", COLORS.map((c) => h(`button.gf-color${c === color ? ".on" : ""}`, { type: "button", style: { background: c }, "aria-label": `Цвет ${c}`,
      onclick: (e) => { color = c; swatches.querySelectorAll(".gf-color").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); } })));
    const sizes = h("div.gf-sizes", SIZES.map((s) => h(`button.gf-size${s === size ? ".on" : ""}`, { type: "button", "aria-label": `Толщина ${s}`,
      onclick: (e) => { size = s; sizes.querySelectorAll(".gf-size").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); } },
      h("i", { style: { width: `${Math.max(3, s)}px`, height: `${Math.max(3, s)}px` } }))));
    const op = h("input.gf-alpha", { type: "range", min: 15, max: 100, value: 100, "aria-label": "Прозрачность кисти" });
    op.addEventListener("input", () => { alpha = op.value / 100; });

    let done = false;
    const save = h("button.btn.primary", { type: "button", onclick: () => {
      if (!dirty) { toast("Сначала нарисуйте что-нибудь", { icon: "edit" }); return; }
      canvas.toBlob((blob) => {
        if (!blob) { toast("Не получилось сохранить рисунок", { error: true }); return; }
        done = true;
        m.close();
        resolve(new File([blob], "graffiti.png", { type: "image/png" }));
      }, "image/png");
    } }, "Прикрепить");
    const m = modal({
      title: "Граффити",
      body: h("div.gf",
        h("div.gf-board", canvas),
        h("div.gf-tools",
          swatches,
          h("div.gf-row", sizes, h("label.gf-op", h("span", "Прозрачность"), op),
            h("div.spacer"),
            h("button.btn.ghost.sm", { type: "button", onclick: () => { const s = history.pop(); if (s) g.putImageData(s, 0, 0); } }, icon("back", "sm"), "Отменить"),
            h("button.btn.ghost.sm", { type: "button", onclick: () => { snapshot(); reset(); dirty = false; } }, icon("trash", "sm"), "Очистить")))),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Отмена"), save],
      wide: true,
      onClose: () => { if (!done) resolve(null); },
    });
    m.dialog?.classList?.add("gf-modal");
  });
}
