import type { WorldState } from "../simulation/types";
import { SAVE_VERSION } from "../simulation/sim";

/**
 * Формат файла экспорта: JSON, где типизированные массивы закодированы base64, и всё сжато gzip
 * (если браузер умеет CompressionStream). Версия формата хранится в файле — старые сохранения можно мигрировать.
 */
const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Float32Array, Int16Array, Uint8Array, Int32Array, Float64Array, Uint16Array,
};

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toJSON(st: WorldState): string {
  return JSON.stringify({ format: "genesis", version: SAVE_VERSION, state: st }, (_k, v) => {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const t = v as unknown as { constructor: { name: string }; buffer: ArrayBuffer; byteOffset: number; byteLength: number };
      return { __t: t.constructor.name, d: b64(new Uint8Array(t.buffer, t.byteOffset, t.byteLength)) };
    }
    return v;
  });
}

export function fromJSON(text: string): WorldState {
  const obj = JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && typeof v.__t === "string" && typeof v.d === "string") {
      const C = TYPED[v.__t];
      if (!C) throw new Error("Неизвестный тип массива: " + v.__t);
      const bytes = unb64(v.d);
      return new C(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    }
    return v;
  });
  if (obj?.format !== "genesis" || !obj.state) throw new Error("Это не файл мира GENESIS");
  return migrate(obj.state as WorldState, obj.version ?? 1);
}

/** Миграции старых версий формата */
export function migrate(st: WorldState, version: number): WorldState {
  if (version > SAVE_VERSION) throw new Error("Файл создан более новой версией игры");
  // v1 — текущая. Здесь появятся шаги v1 → v2 и т. д.
  st.borders ??= {};
  st.version = SAVE_VERSION;
  return st;
}

export async function compress(text: string): Promise<Blob> {
  const blob = new Blob([text], { type: "application/json" });
  if (typeof CompressionStream === "undefined") return blob;
  return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}
export async function decompress(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b && typeof DecompressionStream !== "undefined") {
    return new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return file.text();
}
