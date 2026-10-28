// 常駐のバックグラウンドページ。content / popup からのメッセージを受けて、ねこ語変換を行う
//
// Manifest V2 の常駐バックグラウンドページは通常のドキュメントなので WebGPU が使える。
// WebLLM をこのページで直接動かし、読み込んだモデルをブラウザを閉じるまで保持する

import * as webllm from "@mlc-ai/web-llm";
import {
  isTargeted, type BackgroundMessage, type ConvertResponse, type ErrorResponse, type ModelStatusResponse,
} from "./shared/messages";
import {
  addTailEmojis, buildLlmjpPrompt, convertByRule, isAllowedRewrite, isConvertible, MAX_TOKENS, postProcess, splitSentences,
} from "./shared/nyan";
import {
  LEGACY_MODELS, loadDevModelUrl, loadModelStatus, loadSettings, MODELS, onSettingsChanged, removeLegacyCounts, saveModelStatus,
  type ModelStatus,
} from "./shared/settings";
import runtimeWasm from "./runtime-wasm.json";

// ---------- モデルの管理 ----------

let engine: webllm.MLCEngine | null = null;
let loadedModelId = "";
let loading: Promise<void> | null = null;

async function setStatus(status: Partial<ModelStatus> & { state: ModelStatus["state"] }): Promise<void> {
  try {
    await saveModelStatus({ modelId: loadedModelId, progress: 0, text: "", ...status });
  } catch (err) {
    console.warn("[nyantopia] 状態の保存に失敗:", err);
  }
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/WebGPU|navigator\.gpu|requestAdapter|shader-f16/i.test(msg)) {
    return "WebGPU が使えません。最新の Firefox(macOS は Apple Silicon)で about:config の dom.webgpu.enabled を確認してください。";
  }
  if (/Cannot initialize runtime/i.test(msg)) {
    return `このブラウザの WebGPU では動かせません(${msg})`;
  }
  if (/out of memory|OOM|buffer size|exceeds/i.test(msg)) {
    return "GPU メモリが足りないようです。";
  }
  if (/fetch|network|Failed to load|404|403/i.test(msg)) {
    return "モデルのダウンロードに失敗しました。ネットワーク接続を確認してください。";
  }
  return msg;
}

/**
 * WebLLM に渡すモデルの設定。モデル実行用の wasm は拡張機能内のファイルを指す。
 * addons.mozilla.org のポリシーでも外部から実行コードを取得できないため、wasm は public/wasm/ に同梱している
 * (nyantopia-model の scripts/compile_webgpu.sh で作り、scripts/fetch-wasm.mjs が用意する)。
 * URL が http で始まらないと WebLLM はキャッシュを使わず直接 fetch する。設定の値は WebLLM 組み込みの Qwen3-0.6B にならう
 */
async function buildAppConfig(modelId: string): Promise<webllm.AppConfig> {
  const def = MODELS[modelId];
  if (!def) throw new Error(`モデルの設定に ${modelId} がありません`);
  const record: webllm.ModelRecord = {
    model: (await loadDevModelUrl()) ?? def.model,
    model_id: modelId,
    model_lib: browser.runtime.getURL(`wasm/${def.lib.file}`),
    vram_required_MB: def.lib.vramMB,
    low_resource_required: true,
    overrides: { context_window_size: 4096 },
  };
  return { ...webllm.prebuiltAppConfig, model_list: [record] };
}

/** 以前のバージョンが Hugging Face から取ってキャッシュした Qwen3 の重み(約 340MB)を消す。一度だけ行う */
async function removeLegacyModelCaches(): Promise<void> {
  const FLAG = "legacyModelCacheRemoved";
  const got = await browser.storage.local.get(FLAG);
  if (got[FLAG]) return;
  for (const m of LEGACY_MODELS) {
    try {
      const config = { ...webllm.prebuiltAppConfig, model_list: [{ model_id: m.model_id, model: m.model, model_lib: "" }] };
      await webllm.deleteModelAllInfoInCache(m.model_id, config);
    } catch (err) {
      // キャッシュがなければ失敗するが、消す必要もないので無視する
      console.debug("[nyantopia] 以前のモデルのキャッシュ削除:", m.model_id, err);
    }
  }
  await browser.storage.local.set({ [FLAG]: true });
}

let appConfig: webllm.AppConfig | null = null;

/**
 * WebLLM が JavaScript に埋め込んでいた wasm(トークナイザと文法エンジン)を読み込む。
 * build.mjs がバンドル時に dist/wasm/ へ切り出し、WebLLM 側は globalThis 上のバイト列を参照するよう書き換えてある
 */
let runtimeWasmLoaded: Promise<void> | null = null;
function ensureRuntimeWasm(): Promise<void> {
  runtimeWasmLoaded ??= (async () => {
    const table: Record<string, ArrayBuffer> = {};
    for (const name of runtimeWasm.files) {
      const res = await fetch(browser.runtime.getURL(`wasm/${name}`));
      if (!res.ok) throw new Error(`同梱の wasm を読み込めません: wasm/${name} (${res.status})`);
      table[name] = await res.arrayBuffer();
    }
    (globalThis as unknown as Record<string, unknown>)[runtimeWasm.global] = table;
  })().catch((err: unknown) => {
    runtimeWasmLoaded = null;
    throw err;
  });
  return runtimeWasmLoaded;
}

async function ensureModel(modelId: string): Promise<webllm.MLCEngine> {
  if (engine && loadedModelId === modelId) return engine;
  if (loading) {
    await loading;
    if (engine && loadedModelId === modelId) return engine;
  }
  loading = (async () => {
    loadedModelId = modelId;
    await setStatus({ state: "loading", modelId, text: "モデルを準備しています…" });
    try {
      const initProgressCallback = (p: webllm.InitProgressReport) => {
        void setStatus({ state: "loading", modelId, progress: p.progress ?? 0, text: p.text ?? "読み込み中…" });
      };
      await ensureRuntimeWasm();
      appConfig = await buildAppConfig(modelId);
      if (!engine) {
        engine = await webllm.CreateMLCEngine(modelId, { initProgressCallback, appConfig });
      } else {
        engine.setInitProgressCallback(initProgressCallback);
        engine.setAppConfig(appConfig);
        await engine.reload(modelId);
      }
      await setStatus({ state: "ready", modelId, progress: 1, text: "準備できました" });
    } catch (err) {
      console.error("[nyantopia] モデルの読み込みに失敗:", err);
      engine = null;
      loadedModelId = "";
      await setStatus({ state: "error", modelId, text: friendlyError(err) });
      throw err;
    }
  })().finally(() => {
    loading = null;
  });
  await loading;
  return engine!;
}

// ---------- LLM による変換 ----------

/**
 * 1 文をモデルに渡して、ねこ語の文を生成する。
 * 学習時と同じ 1 つの文字列を completions API に渡す(毎回 KV キャッシュを作り直すが、プロンプトが短いので prefill は軽い)
 */
async function generate(eng: webllm.MLCEngine, text: string, temperature: number, seed?: number): Promise<string> {
  const t0 = performance.now();
  const res = await eng.completions.create({
    prompt: buildLlmjpPrompt(text),
    temperature,
    top_p: 0.9,
    max_tokens: MAX_TOKENS,
    repetition_penalty: 1.1,
    seed,
    // 答えの後は </s> で止まる。止まらずに次の「### 指示:」を書き始めたときの保険
    stop: ["\n\n", "### 指示"],
  });
  lastStats = {
    prompt_tokens: res.usage?.prompt_tokens ?? -1,
    completion_tokens: res.usage?.completion_tokens ?? -1,
    prefill_tokens_per_s: res.usage?.extra?.prefill_tokens_per_s ?? -1,
    decode_tokens_per_s: res.usage?.extra?.decode_tokens_per_s ?? -1,
    ms: Math.round(performance.now() - t0),
  };
  const content = res.choices[0]?.text ?? "";
  lastRaw = { raw: content, finish: res.choices[0]?.finish_reason ?? "" };
  return content;
}

/** 直近の生成の統計(評価スクリプト用) */
let lastStats: Record<string, number> = {};
let lastRaw: Record<string, string> = {};

/** 直近の文がルール変換に切り替わったか(評価スクリプト用) */
let lastFallback = false;

/** 1 文をモデルで変換する。意味が変わる出力や文の途中を変えた出力はルール変換に切り替える */
async function convertSentence(eng: webllm.MLCEngine, sentence: string): Promise<{ text: string; byRule: boolean }> {
  const fallback = () => ({ text: convertByRule(sentence, false), byRule: true });
  const trimmed = sentence.trim();
  if (!isConvertible(trimmed)) return { text: sentence, byRule: false };

  // 語尾の言い換えを学習させたモデルなので、元の文との違いが対応表の範囲に収まっているかで判定する
  const bad = (t: string) => !postProcess(t, false, trimmed) || !isAllowedRewrite(trimmed, t);
  let out = (await generate(eng, trimmed, 0)).trim();
  if (bad(out)) {
    // 貪欲法で崩れたときは、少しだけ揺らして一度だけやり直す
    out = (await generate(eng, trimmed, 0.3, Date.now() % 100000)).trim();
  }
  if (bad(out)) {
    console.debug("[nyantopia] 対応表の範囲を超えているのでルール変換にします:", trimmed, "→", out);
    lastFallback = true;
    return fallback();
  }
  lastFallback = false;
  let result = postProcess(out, false, trimmed);
  // モデルが句点の代わりに改行や連続スペースを出すことがあるので、元の文になければ取り除く
  if (!/\n/.test(trimmed)) result = result.replace(/\s*\n\s*/g, "");
  result = result.replace(/[ \t]{2,}/g, " ").trim();
  // 元の文末の句読点が落ちていたら戻す
  const punct = trimmed.match(/[。！？!?]+$/u)?.[0] ?? "";
  if (punct && !/[。！？!?]$/u.test(result)) result += punct;
  return { text: result || fallback().text, byRule: false };
}

/** テキストノード 1 つ分を変換する。文ごとに分けて LLM にかける(短いほど写し間違いが減る) */
async function convertOne(eng: webllm.MLCEngine, text: string, emoji: boolean): Promise<string | null> {
  if (!isConvertible(text)) return null;
  const parts: string[] = [];
  for (const sentence of splitSentences(text)) {
    const lead = sentence.match(/^\s*/)?.[0] ?? "";
    const trail = sentence.match(/\s*$/)?.[0] ?? "";
    const { text: converted } = await convertSentence(eng, sentence);
    parts.push(lead + converted.trim() + trail);
  }
  const joined = parts.join("");
  const result = emoji ? addTailEmojis(joined) : joined;
  return result.trim() ? result : null;
}

// 変換要求は直列に処理する(エンジンは同時に 1 件しか扱えない)
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

function convertByRuleBatch(texts: string[], emoji: boolean): (string | null)[] {
  return texts.map((t) => (isConvertible(t) ? convertByRule(t, emoji) : null));
}

// ---------- メッセージの処理 ----------

type Response = ConvertResponse | ErrorResponse | ModelStatusResponse | { ok: true; stats?: Record<string, number | string> };

async function handle(msg: BackgroundMessage): Promise<Response> {
  switch (msg.type) {
    case "convert": {
      // 件数は content script 側で数える(ルール変換を先に適用した時点で 1 回だけ)
      if (msg.engine === "rule") {
        return { ok: true, results: convertByRuleBatch(msg.texts, msg.emoji) };
      }
      const { modelId } = await loadSettings();
      return enqueue(async () => {
        const eng = await ensureModel(modelId);
        const results: (string | null)[] = [];
        for (const text of msg.texts) {
          try {
            results.push(await convertOne(eng, text, msg.emoji));
          } catch (err) {
            console.error("[nyantopia]", err);
            results.push(null);
          }
        }
        return { ok: true, results } satisfies ConvertResponse;
      });
    }
    case "loadModel":
      await ensureModel(msg.modelId);
      return { ok: true };
    case "clearCache":
      if (engine) {
        await engine.unload();
        engine = null;
        loadedModelId = "";
      }
      try {
        await webllm.deleteModelAllInfoInCache(msg.modelId, appConfig ?? (await buildAppConfig(msg.modelId)));
      } catch (err) {
        // 同梱 wasm は Cache API の対象外なので、その削除に失敗しても無視する
        console.warn("[nyantopia] キャッシュ削除で警告:", err);
      }
      await setStatus({ state: "idle", modelId: "", text: "キャッシュを削除しました" });
      return { ok: true };
    case "stats":
      return { ok: true, stats: { ...lastStats, ...lastRaw, fallback: lastFallback ? 1 : 0 } };
    case "modelStatus":
      return { ok: true, status: await loadModelStatus() };
  }
}

// リスナーから Promise を返すと、その値が応答になる
browser.runtime.onMessage.addListener((msg: unknown): Promise<Response> | undefined => {
  if (!isTargeted(msg, "background")) return undefined;
  return handle(msg as BackgroundMessage).catch((err: unknown): ErrorResponse => {
    const error = friendlyError(err);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[nyantopia]", error, err);
    return { ok: false, error, detail };
  });
});

// ---------- バッジ ----------

// ON/OFF に合わせてツールバーのバッジを更新する
async function updateBadge(enabled: boolean): Promise<void> {
  await browser.browserAction.setBadgeText({ text: enabled ? "にゃ" : "" });
  await browser.browserAction.setBadgeBackgroundColor({ color: "#f4a261" });
}

onSettingsChanged((s) => {
  void updateBadge(s.enabled);
});

// 拡張機能の再読み込みや無効化でこのページが閉じるとき、GPU のメモリを明示的に返す
// (返さないと、次に起動した背景ページでモデルを読み込むときに GPU メモリが足りなくなることがある)
window.addEventListener("pagehide", () => {
  if (engine) {
    void engine.unload().catch(() => undefined);
    engine = null;
    loadedModelId = "";
  }
});

// 常駐ページなので、ブラウザ起動時(と拡張機能の再読み込み時)にここが 1 回だけ走る
void (async () => {
  await setStatus({ state: "idle", modelId: "", text: "未読み込み" });
  await updateBadge((await loadSettings()).enabled);
  await removeLegacyCounts();
  await removeLegacyModelCaches();
})();
