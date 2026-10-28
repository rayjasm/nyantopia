// モデル実行用の wasm を public/wasm/ に用意する
//
// addons.mozilla.org のポリシーでは、拡張機能の外部から実行コードを取得できないため、
// wasm を拡張機能に同梱する。wasm は nyantopia-model の scripts/compile_webgpu.sh で
// WebLLM と同じ版の TVM からコンパイルしたもので、モデルの重みと同じ Hugging Face のリポジトリの lib/ に置いてある。
//
//   node scripts/fetch-wasm.mjs            # 未取得なら取得
//   node scripts/fetch-wasm.mjs --force    # 取得し直す
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public/wasm");
// 同梱する wasm。src/shared/settings.ts の MODELS と合わせる
const LIBS = [
  {
    file: "nyantopia-llm-jp-3-150m-q4f16_1_cs1k-webgpu.wasm",
    url: "https://huggingface.co/jasmray/nyantopia-llm-jp-3-150m-q4f16_1-MLC/resolve/main/lib/nyantopia-llm-jp-3-150m-q4f16_1_cs1k-webgpu.wasm",
  },
];
const force = process.argv.includes("--force");

await mkdir(OUT_DIR, { recursive: true });
for (const { file, url } of LIBS) {
  const dest = path.join(OUT_DIR, file);
  const exists = await access(dest).then(() => true, () => false);
  if (exists && !force) {
    console.log(`既にあります: public/wasm/${file}`);
    continue;
  }
  console.log(`取得中: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ダウンロード失敗: ${res.status} ${url}\nnyantopia-model の artifacts/ から public/wasm/${file} にコピーしてください`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`保存しました: public/wasm/${file} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}
