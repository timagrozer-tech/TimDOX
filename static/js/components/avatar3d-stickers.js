// 3D-стикеры: из 3D-аватара получается набор «<Имя> · 3D» — по стикеру на каждую эмоцию.
// Рисуется в браузере (невидимая сцена), на сервер уходят готовые PNG; набор сразу появляется в смайликах чата.
import { api } from "../api.js";
import { h } from "../dom.js";
import { toast, toastError } from "../ui.js";
import { mount3D } from "./avatar3d.js";

let running = null;

export async function buildAvatarStickers(spec, { quiet = false } = {}) {
  if (running) return running;
  running = (async () => {
    const holder = h("div", { "aria-hidden": "true", style: { position: "fixed", left: "-10000px", top: "0", width: "512px", height: "512px", pointerEvents: "none" } });
    document.body.append(holder);
    let view = null;
    try {
      view = await mount3D(holder, spec, { interactive: false, snapshotable: true });
      if (!view) return null;
      const shots = await view.stickers(512);
      const fd = new FormData();
      for (const [em, blob] of shots) { fd.append("file", blob, `${em}.png`); fd.append("emotion", em); }
      const pack = await api.form("/api/avatar3d-stickers", fd, "PUT");
      if (!quiet) toast("Готовы 3D-стикеры с вашим персонажем — они в смайликах чата 😎", { icon: "sparkle", duration: 4500 });
      return pack;
    } catch (e) {
      if (!quiet) toastError(e);
      return null;
    } finally {
      view?.destroy();
      holder.remove();
      running = null;
    }
  })();
  return running;
}
