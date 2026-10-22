// WebLLM のモデル実行用 wasm を public/wasm/ にダウンロードする
//
// addons.mozilla.org のポリシーでは、拡張機能の外部から実行コードを取得できないため、
// wasm を拡張機能に同梱する。wasm は WebLLM のバージョンと対になっているので、
// インストール済みの @mlc-ai/web-llm の設定から URL を読み取って取得する。
//
//   node scripts/fetch-wasm.mjs            # 未取得なら取得
//   node scripts/fetch-wasm.mjs --force    # 取得し直す
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public/wasm");
// 同梱するモデル。src/shared/settings.ts の DEFAULT_MODEL_ID と合わせる
const MODEL_IDS = ["Qwen3-0.6B-q4f16_1-MLC"];
const force = process.argv.includes("--force");

await mkdir(OUT_DIR, { recursive: true });
for (const modelId of MODEL_IDS) {
  const record = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
  if (!record?.model_lib) throw new Error(`WebLLM の設定に ${modelId} がありません`);
  const file = record.model_lib.split("/").pop();
  const dest = path.join(OUT_DIR, file);
  const exists = await access(dest).then(() => true, () => false);
  if (exists && !force) {
    console.log(`既にあります: public/wasm/${file}`);
    continue;
  }
  console.log(`取得中: ${record.model_lib}`);
  const res = await fetch(record.model_lib);
  if (!res.ok) throw new Error(`ダウンロード失敗: ${res.status} ${record.model_lib}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`保存しました: public/wasm/${file} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}
