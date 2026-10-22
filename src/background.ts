// 常駐のバックグラウンドページ。content / popup からのメッセージを受けて、ねこ語変換を行う
//
// Manifest V2 の常駐バックグラウンドページは通常のドキュメントなので WebGPU が使える。
// WebLLM をこのページで直接動かし、読み込んだモデルをブラウザを閉じるまで保持する

import * as webllm from "@mlc-ai/web-llm";
import {
  isTargeted, type BackgroundMessage, type ConvertResponse, type ErrorResponse, type ModelStatusResponse,
} from "./shared/messages";
import {
  addTailEmojis, buildMessages, convertByRule, copiedExample, hasForeignChars, isConvertible, MAX_TOKENS, postProcess, retention,
  splitSentences,
} from "./shared/nyan";
import { loadModelStatus, loadSettings, onSettingsChanged, saveModelStatus, type ModelStatus } from "./shared/settings";
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
 * WebLLM の組み込み設定をもとに、モデル実行用の wasm を拡張機能内のファイルに差し替えた設定を作る。
 * addons.mozilla.org のポリシーでも外部から実行コードを取得できないため、
 * scripts/fetch-wasm.mjs でダウンロードして public/wasm/ に同梱している。
 * URL が http で始まらないと WebLLM はキャッシュを使わず直接 fetch する
 */
function buildAppConfig(modelId: string): webllm.AppConfig {
  const record = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
  if (!record) throw new Error(`WebLLM の設定に ${modelId} がありません`);
  const file = record.model_lib.split("/").pop() ?? "";
  return {
    ...webllm.prebuiltAppConfig,
    model_list: [{ ...record, model_lib: browser.runtime.getURL(`wasm/${file}`) }],
  };
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
      resetHistory();
      await ensureRuntimeWasm();
      appConfig = buildAppConfig(modelId);
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
 * KV キャッシュを再利用するための会話履歴。
 * WebLLM は「前回の会話の続き」の形(前回のメッセージ列 + 前回の答え + 新しい文)で送られたときだけ、
 * 前回分の KV キャッシュを使い回して新しい部分だけを prefill する。
 * そこで「文 → 答え → 次の文 → 答え…」と 1 つの会話として積み重ねて送る。
 * 履歴の答えは、モデルが生成したものを一字も変えずに入れる(変えると「続き」と判定されない)
 */
let history: webllm.ChatCompletionMessageParam[] = [];
/** 会話が長くなりすぎないよう、このターン数でリセットする */
const MAX_HISTORY_TURNS = 12;

function resetHistory(): void {
  history = [];
}

async function generate(eng: webllm.MLCEngine, text: string, temperature: number, seed?: number): Promise<string> {
  if (history.length >= MAX_HISTORY_TURNS * 2) resetHistory();
  const base = buildMessages(text);
  const messages: webllm.ChatCompletionMessageParam[] = [
    ...(base.slice(0, -1) as webllm.ChatCompletionMessageParam[]),
    ...history,
    base[base.length - 1] as webllm.ChatCompletionMessageParam,
  ];
  const t0 = performance.now();
  const res = await eng.chat.completions.create({
    messages,
    temperature,
    top_p: 0.9,
    max_tokens: MAX_TOKENS,
    // 「にゃ」の繰り返しを罰しないよう frequency_penalty は使わず、同じ文のループだけ軽く抑える
    repetition_penalty: 1.1,
    seed,
    stop: ["入力:", "\n\n\n"],
    // Qwen3 の thinking モードを無効化する
    extra_body: { enable_thinking: false },
  });
  lastStats = {
    prompt_tokens: res.usage?.prompt_tokens ?? -1,
    completion_tokens: res.usage?.completion_tokens ?? -1,
    prefill_tokens_per_s: res.usage?.extra?.prefill_tokens_per_s ?? -1,
    decode_tokens_per_s: res.usage?.extra?.decode_tokens_per_s ?? -1,
    ms: Math.round(performance.now() - t0),
    history_len: history.length,
    messages_len: messages.length,
  };
  const content = res.choices[0]?.message?.content ?? "";
  lastRaw = { raw: content, finish: res.choices[0]?.finish_reason ?? "" };
  return content;
}

/** 直近の生成の統計(評価スクリプト用) */
let lastStats: Record<string, number> = {};
let lastRaw: Record<string, string> = {};

/** この値未満しか元の文が残っていなければ、モデルの出力を捨ててルール変換にする */
const MIN_RETENTION = 0.85;
/** 直近の文がルール変換に切り替わったか(評価スクリプト用) */
let lastFallback = false;

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gu, "").trim();
}

/** 1 文を LLM で変換する。元の文が崩れていたらルール変換に切り替える */
async function convertSentence(eng: webllm.MLCEngine, sentence: string): Promise<{ text: string; byRule: boolean }> {
  const fallback = () => ({ text: convertByRule(sentence, false), byRule: true });
  const trimmed = sentence.trim();
  if (!isConvertible(trimmed)) return { text: sentence, byRule: false };

  const bad = (t: string) =>
    !postProcess(t, false, trimmed) ||
    copiedExample(t, trimmed) ||
    hasForeignChars(trimmed, t) ||
    retention(trimmed, t) < MIN_RETENTION;
  // Qwen3 は thinking を無効にしても出力の先頭に空の <think></think> を付けるので、判定の前に外す
  let raw = await generate(eng, trimmed, 0);
  let out = stripThink(raw);
  if (bad(out)) {
    // 貪欲法で崩れたときは、少しだけ揺らして一度だけやり直す
    raw = await generate(eng, trimmed, 0.3, Date.now() % 100000);
    out = stripThink(raw);
  }
  if (bad(out)) {
    // 崩れた答えを履歴に残すと後の文に悪影響なので、会話をやり直す
    console.debug("[nyantopia] 保持率が低いのでルール変換にします:", trimmed, "→", out);
    resetHistory();
    lastFallback = true;
    return fallback();
  }
  lastFallback = false;
  // 直近に生成した答えを「生のまま」履歴に入れる(一字でも変えると WebLLM が会話の続きと判定しない)
  history.push({ role: "user", content: trimmed }, { role: "assistant", content: raw });
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
        await webllm.deleteModelAllInfoInCache(msg.modelId, appConfig ?? buildAppConfig(msg.modelId));
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
})();
