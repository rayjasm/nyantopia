// content script。ページ内のテキストを集めて、ねこ語に変換して置き換える
//
// 速度のための方針:
// - まずルール変換を即座に適用する(ページを開いた瞬間に「にゃ」になる)
// - LLM モードでは、その後に画面に近いものから順にモデルで変換し直し、結果が来たら差し替える
// - 画面から遠いものはスクロールで近づいてから変換する

import type { ConvertRequest, ConvertResponse, ContentCommand, ErrorResponse } from "./shared/messages";
import { convertByRule, isConvertible, stripForCompare } from "./shared/nyan";
import { loadSettings, onSettingsChanged, type Settings } from "./shared/settings";

/** 一度に LLM に送る単位の数 */
const BATCH_SIZE = 4;
/** 1 ページで LLM にかける単位の上限 */
const MAX_UNITS_LLM = 300;
/**
 * 1 単位(<br> でつながったテキストのまとまり)の目安の最大文字数。
 * これを超えるまとまりは文の切れ目(<br> の前が句点など)で分割する。それでも超える単位はルール変換だけにして LLM には送らない
 */
const MAX_TEXT_LENGTH = 300;
/** 画面の高さの何倍以内にあれば「画面に近い」として LLM にかけるか */
const NEAR_VIEWPORT = 1.5;

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON",
  "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "IFRAME", "CANVAS", "TEMPLATE",
  // 見出しは文ではないことが多く、小型モデルが崩しやすいので対象外にする
  "H1", "H2", "H3", "H4", "H5", "H6", "TITLE",
]);

/**
 * 変換しない UI 部品の WAI-ARIA ロール。
 * 検索窓の入力候補(listbox / option)やメニューは文章ではなく、変換すると操作の邪魔になる
 */
const SKIP_ROLES = new Set([
  "listbox", "option", "combobox", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tree", "treeitem", "tablist", "tab", "tooltip", "searchbox", "textbox", "spinbutton", "slider", "progressbar",
]);

/** <br> や空白でつながった連続するテキストノードを 1 つの単位として扱う */
interface Unit {
  nodes: Text[];
  /** 各ノードのテキストをつなげたもの(改行は入れない) */
  text: string;
}

/** 変換前のテキスト(OFF にしたとき戻す) */
const originals = new Map<Text, string>();
/** 直近にこのスクリプトが書き込んだ値(外部に書き換えられたか検出する) */
const applied = new Map<Text, string>();
/** LLM の結果のキャッシュ。同じ文は二度変換しない */
const llmCache = new Map<string, string>();
/** LLM 待ちの単位 */
let pending: Unit[] = [];

let settings: Settings;
let processing = false;
let generation = 0;
let llmCount = 0;

// ---------- テキストノードの収集 ----------

function shouldSkipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute("role");
  if (role && SKIP_ROLES.has(role)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest("[data-nyantopia-ignore]")) return true;
  return false;
}

function isSkippable(node: Node): boolean {
  for (let el: Element | null = node.parentElement; el; el = el.parentElement) {
    if (shouldSkipElement(el)) return true;
  }
  return false;
}

/** prev と next が同じ親を持ち、間に <br> か空白テキストしかなければ同じ単位とみなす */
function continuesAfter(prev: Text, next: Text): boolean {
  if (prev.parentNode !== next.parentNode) return false;
  let sib: Node | null = prev.nextSibling;
  while (sib && sib !== next) {
    if (sib.nodeType === Node.ELEMENT_NODE) {
      if ((sib as Element).tagName !== "BR") return false;
    } else if (sib.nodeType === Node.TEXT_NODE) {
      if ((sib.nodeValue ?? "").trim()) return false;
    } else {
      return false;
    }
    sib = sib.nextSibling;
  }
  return sib === next;
}

/**
 * <br> でつながった長いまとまりを、文の切れ目で MAX_TEXT_LENGTH 以下の単位に分ける。
 * ニュース記事などは本文全体が 1 つの <p> に <br> 区切りで入っていることがあり、そのままでは 1 単位が長すぎる
 */
function splitLongGroup(nodes: Text[]): Text[][] {
  const len = (n: Text) => (n.nodeValue ?? "").trim().length;
  if (nodes.reduce((sum, n) => sum + len(n), 0) <= MAX_TEXT_LENGTH) return [nodes];
  const groups: Text[][] = [];
  let group: Text[] = [];
  let groupLen = 0;
  for (const node of nodes) {
    const last = group[group.length - 1];
    const endsSentence = last !== undefined && /[。！？!?」』）)]\s*$/u.test(last.nodeValue ?? "");
    if (group.length > 0 && endsSentence && groupLen + len(node) > MAX_TEXT_LENGTH) {
      groups.push(group);
      group = [];
      groupLen = 0;
    }
    group.push(node);
    groupLen += len(node);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** root 以下の、まだ変換していないテキストを単位にまとめて返す */
function collectUnits(root: Node): Unit[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement || isSkippable(node)) return NodeFilter.FILTER_REJECT;
      if (originals.has(node as Text)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const units: Unit[] = [];
  let current: Text[] = [];
  let prevNode: Text | null = null;
  const flush = () => {
    if (current.length === 0) return;
    for (let group of splitLongGroup(current)) {
      // 空白だけのノードは単位の先頭・末尾から外す
      while (group.length > 1 && !(group[0].nodeValue ?? "").trim()) group = group.slice(1);
      while (group.length > 1 && !(group[group.length - 1].nodeValue ?? "").trim()) group = group.slice(0, -1);
      const text = group.map((n) => n.nodeValue ?? "").join("");
      if (isConvertible(text)) units.push({ nodes: group, text });
    }
    current = [];
  };
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const node = n as Text;
    if (!(prevNode && continuesAfter(prevNode, node))) flush();
    current.push(node);
    prevNode = node;
  }
  flush();
  return units;
}

// ---------- 書き込み ----------

/** 「にゃ」「絵文字」「句読点」「空白」の連続(ノード境界の後ろに付いていてよいもの) */
const FILLER_RUN = /^(?:にゃ[んあー〜～]?|[\s。、！？!?,.「」『』…〜～ー]|\p{Extended_Pictographic}\uFE0F?)+/u;

/**
 * 変換結果を元のノード境界に合わせて配り直す。
 * 変換は「写して にゃ を付け足す」だけなので、各ノードの文字列(にゃ・句読点・絵文字を除く)が
 * 出力の先頭から順に現れるはず。比較は stripForCompare でそろえる(「に」「ん」のような 1 文字は本文として扱う)。
 * 見つからなければ残り全部をそのノードに入れる
 */
function distribute(unit: Unit, converted: string): string[] {
  const pieces: string[] = [];
  let rest = converted;
  for (let i = 0; i < unit.nodes.length; i++) {
    const original = originals.get(unit.nodes[i]) ?? unit.nodes[i].nodeValue ?? "";
    if (i === unit.nodes.length - 1) {
      pieces.push(rest);
      break;
    }
    const target = stripForCompare(original);
    if (!target) {
      pieces.push(original);
      continue;
    }
    let cut = -1;
    for (let k = 1; k <= rest.length; k++) {
      const got = stripForCompare(rest.slice(0, k));
      if (got === target) {
        cut = k;
        break;
      }
      // 「にゃ」の途中で一時的に長くなることがあるので、少し余裕を見てから諦める
      if (got.length > target.length + 3) break;
    }
    if (cut < 0) {
      pieces.push(rest);
      rest = "";
      continue;
    }
    // ノードの文字列の直後に付いた「にゃ」や句読点、絵文字は同じノードに含める
    cut += rest.slice(cut).match(FILLER_RUN)?.[0].length ?? 0;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  while (pieces.length < unit.nodes.length) pieces.push("");
  return pieces;
}

/** 単位に変換結果を書き込む。外部に書き換えられていたら何もしない */
function writeUnit(unit: Unit, converted: string): boolean {
  for (const node of unit.nodes) {
    const expected = applied.get(node) ?? originals.get(node);
    if (expected !== undefined && node.nodeValue !== expected) return false;
  }
  const pieces = distribute(unit, converted.trim());
  unit.nodes.forEach((node, i) => {
    if (!originals.has(node)) originals.set(node, node.nodeValue ?? "");
    const original = originals.get(node) ?? "";
    const lead = original.match(/^\s*/)?.[0] ?? "";
    const trail = original.match(/\s*$/)?.[0] ?? "";
    const value = lead + pieces[i].trim() + trail;
    node.nodeValue = value;
    applied.set(node, value);
  });
  return true;
}

// ---------- 変換の流れ ----------

/** 集めた単位にまずルール変換を適用し、LLM モードなら待ち行列に入れる */
function handleUnits(units: Unit[]): void {
  for (const unit of units) {
    const text = unit.text.trim();
    const cached = settings.engine === "llm" ? llmCache.get(text) : undefined;
    const ruleText = cached ?? convertByRule(text, settings.emoji);
    if (!writeUnit(unit, ruleText)) continue;
    // 文の切れ目で分けても長すぎる単位はルール変換のままにする(小型モデルは長文を崩しやすい)
    if (settings.engine === "llm" && cached === undefined && text.length <= MAX_TEXT_LENGTH) pending.push(unit);
  }
  kick();
}

/** 単位が画面からどれだけ離れているか(px)。画面内なら 0、非表示なら Infinity */
function distanceFromViewport(unit: Unit): number {
  const range = document.createRange();
  range.selectNodeContents(unit.nodes[0]);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return Number.POSITIVE_INFINITY;
  if (rect.bottom < 0) return -rect.bottom;
  if (rect.top > window.innerHeight) return rect.top - window.innerHeight;
  return 0;
}

/** 画面に近い順に、LLM にかける単位を取り出す */
function takeNearBatch(): Unit[] {
  const limit = window.innerHeight * NEAR_VIEWPORT;
  const scored = pending
    .map((unit) => ({ unit, dist: distanceFromViewport(unit) }))
    .filter((s) => s.dist <= limit && s.unit.nodes.every((n) => n.isConnected))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, BATCH_SIZE)
    .map((s) => s.unit);
  if (scored.length) pending = pending.filter((u) => !scored.includes(u));
  return scored;
}

async function requestConvert(texts: string[]): Promise<(string | null)[]> {
  const req: ConvertRequest = {
    target: "background",
    type: "convert",
    texts,
    engine: "llm",
    emoji: settings.emoji,
  };
  const res = (await browser.runtime.sendMessage(req)) as ConvertResponse | ErrorResponse | undefined;
  if (!res) throw new Error("background から応答がありません");
  if (!res.ok) throw new Error(res.error);
  return res.results;
}

/** 待ち行列を画面に近い順に LLM で変換し直す */
async function processPending(): Promise<void> {
  if (processing || !settings.enabled || settings.engine !== "llm") return;
  processing = true;
  const myGen = generation;
  try {
    while (myGen === generation && settings.enabled && llmCount < MAX_UNITS_LLM) {
      const batch = takeNearBatch();
      if (batch.length === 0) break;
      const texts = batch.map((u) => u.text.trim());
      let results: (string | null)[];
      try {
        results = await requestConvert(texts);
      } catch (err) {
        console.warn("[nyantopia] モデルでの変換に失敗しました。ルール変換のままにします:", err);
        return;
      }
      if (myGen !== generation) return;
      results.forEach((r, i) => {
        llmCount++;
        if (!r) return;
        llmCache.set(texts[i], r);
        writeUnit(batch[i], r);
      });
    }
  } finally {
    processing = false;
  }
}

let kickTimer: number | undefined;
/** 少し待ってから待ち行列の処理を始める(スクロールや DOM 変更の連打をまとめる) */
function kick(delay = 100): void {
  clearTimeout(kickTimer);
  kickTimer = window.setTimeout(() => void processPending(), delay);
}

function convertPage(root: Node = document.body): void {
  if (!settings.enabled) return;
  handleUnits(collectUnits(root));
}

function restorePage(): void {
  generation++;
  pending = [];
  llmCount = 0;
  for (const [node, original] of originals) {
    if (node.isConnected) node.nodeValue = original;
  }
  originals.clear();
  applied.clear();
}

// ---------- イベント ----------

// SPA などで後から追加されたテキストも変換する
let added: Node[] = [];
let mutationTimer: number | undefined;
const observer = new MutationObserver((mutations) => {
  if (!settings.enabled) return;
  for (const m of mutations) {
    for (const n of m.addedNodes) {
      if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) added.push(n);
    }
  }
  if (added.length === 0) return;
  clearTimeout(mutationTimer);
  mutationTimer = window.setTimeout(() => {
    const targets = added;
    added = [];
    for (const t of targets) {
      if (!t.isConnected) continue;
      convertPage(t.nodeType === Node.TEXT_NODE ? (t.parentNode ?? t) : t);
    }
  }, 500);
});

function startObserving(): void {
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
}

function stopObserving(): void {
  observer.disconnect();
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onScroll);
}

function onScroll(): void {
  if (pending.length > 0) kick(300);
}

async function start(): Promise<void> {
  settings = await loadSettings();
  if (settings.enabled) {
    startObserving();
    convertPage();
  }

  onSettingsChanged((next) => {
    const wasEnabled = settings.enabled;
    const changed = settings.engine !== next.engine || settings.emoji !== next.emoji;
    settings = next;
    if (!wasEnabled && next.enabled) {
      startObserving();
      convertPage();
    } else if (wasEnabled && !next.enabled) {
      stopObserving();
      restorePage();
    } else if (next.enabled && changed) {
      restorePage();
      llmCache.clear();
      convertPage();
    }
  });

  browser.runtime.onMessage.addListener((msg: unknown): Promise<{ ok: true }> | undefined => {
    const cmd = msg as ContentCommand | undefined;
    if (cmd?.type === "rerun") {
      restorePage();
      llmCache.clear();
      convertPage();
      return Promise.resolve({ ok: true });
    }
    if (cmd?.type === "restore") {
      restorePage();
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
}

void start();
