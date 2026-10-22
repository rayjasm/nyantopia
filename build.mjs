// esbuild で拡張機能をビルドして dist/ に出力する(Firefox 版)
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import runtimeWasm from "./src/runtime-wasm.json" with { type: "json" };

const watch = process.argv.includes("--watch");
// 配布用ビルド。ソースマップを出さない(配布物を小さくし、審査員の再ビルドと差分が出にくくする)
const release = process.argv.includes("--release");
const outdir = "dist";

// モデル実行用の wasm を同梱する(未取得ならダウンロード)
execFileSync(process.execPath, ["scripts/fetch-wasm.mjs"], { stdio: "inherit" });

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("public", outdir, { recursive: true });
// ライセンス表記も配布物に含める
await cp("LICENSE", `${outdir}/LICENSE`);
await cp("THIRD_PARTY_NOTICES.md", `${outdir}/THIRD_PARTY_NOTICES.md`);
await cp("licenses", `${outdir}/licenses`, { recursive: true });

/**
 * WebLLM の lib/index.js には Emscripten の wasm(xgrammar、web-tokenizers)が data URI として埋め込まれていて、
 * そのままバンドルすると background.js が 5MB を超え、addons.mozilla.org の検証で「解析できない」エラーになる。
 * そこで読み込み時に wasm を dist/wasm/ に書き出し、実行時に background.ts が fetch して
 * globalThis[runtimeWasm.global] に入れたバイト列(Module.wasmBinary 相当)を使うように置き換える。
 * Emscripten の SINGLE_FILE ビルドには fetch で wasm を取る経路がないため、この形にしている
 */
/**
 * WebLLM(tvmjs)は WebGPU の maxStorageBuffersPerShaderStage を固定で 10 要求するが、
 * Firefox(wgpu)の上限は 9 なので「Cannot initialize runtime」で止まってしまう。
 * ブラウザの上限が 10 未満ならその値で要求するように書き換える(Qwen3-0.6B のカーネルは 9 で動くことを確認済み)
 */
function relaxStorageBufferLimit(src) {
  const target = "const requiredMaxStorageBuffersPerShaderStage = 10;";
  if (src.split(target).length !== 2) {
    throw new Error("WebLLM の maxStorageBuffersPerShaderStage の指定が見つかりません(WebLLM の更新で変わった可能性があります)。build.mjs を見直してください");
  }
  return src.replace(
    target,
    "const requiredMaxStorageBuffersPerShaderStage = Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage);",
  );
}

const extractInlineWasm = {
  name: "extract-inline-wasm",
  setup(build) {
    build.onLoad({ filter: /[\\/]@mlc-ai[\\/]web-llm[\\/]lib[\\/]index\.js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      await mkdir(`${outdir}/wasm`, { recursive: true });
      let i = 0;
      const writes = [];
      const contents = src.replace(
        /wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/g,
        (_match, b64) => {
          const name = runtimeWasm.files[i++];
          if (!name) return _match;
          writes.push(writeFile(`${outdir}/wasm/${name}`, Buffer.from(b64, "base64")));
          const key = JSON.stringify(name);
          return `wasmBinaryFile=${key};wasmBinary=(globalThis[${JSON.stringify(runtimeWasm.global)}]||{})[${key}]`;
        },
      );
      if (i !== runtimeWasm.files.length) {
        throw new Error(`WebLLM に埋め込まれた wasm の数が想定と違います(見つかった数: ${i}、想定: ${runtimeWasm.files.length})。src/runtime-wasm.json と build.mjs を見直してください`);
      }
      await Promise.all(writes);
      console.log(`WebLLM の wasm を切り出しました: ${runtimeWasm.files.join(", ")}`);
      return { contents: relaxStorageBufferLimit(contents), loader: "js" };
    });
  },
};

const common = {
  bundle: true,
  sourcemap: !release,
  target: "firefox142",
  logLevel: "info",
  plugins: [extractInlineWasm],
};

const contexts = await Promise.all([
  // content script は ESM が使えないので IIFE にする
  esbuild.context({
    ...common,
    entryPoints: ["src/content.ts"],
    outfile: `${outdir}/content.js`,
    format: "iife",
  }),
  esbuild.context({
    ...common,
    entryPoints: ["src/background.ts", "src/popup.ts"],
    outdir,
    format: "esm",
    splitting: false,
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching...");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
