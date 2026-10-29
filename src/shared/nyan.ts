// ねこ語変換のプロンプトと後処理。nyanyaku (https://github.com/rayjasm/nyanyaku) から移植
// DOM や browser API に依存しない純粋な関数だけを置く

export const MAX_TOKENS = 256;

/**
 * ねこ語モデル(llm-jp-3-150m を学習させたもの)向けのプロンプト。モデル既定の指示/応答形式で、学習(trl)ではこの文字列全体を
 * 1 つの文字列として符号化している(BOS は先頭の <s> の 1 個だけ)。WebLLM でも chat API ではなく completions API に
 * この文字列を渡して、学習時と同じトークン列にする(chat API は system / user / assistant を別々に符号化するので、
 * 「###」の前に ▁ が入るかどうかが学習時と変わってしまう)
 */
export function buildLlmjpPrompt(text: string): string {
  return `<s>以下は、タスクを説明する指示です。要求を適切に満たす応答を書きなさい。\n\n### 指示:\n${text}\n\n### 応答:\n`;
}

const OPEN_BRACKETS = "「『（(［[【〈《“\"";
const CLOSE_BRACKETS = "」』）)］]】〉》”\"";

/**
 * ハッシュタグ 1 つ(「#てんちむ」「＃ゲーム実況」)。英数字の直後の #(「C#」)は除く。
 * YouTube の概要欄や X の投稿では文末に並ぶので、「にゃ」と絵文字はその前に置き、タグだけの文字列は文とみなさない
 */
const HASHTAG = "(?<![A-Za-z0-9])[#＃][^\\s#＃。、！？!?「」『』（）()]+";
const HASHTAG_TAIL = new RegExp(`(?:\\s*${HASHTAG})+\\s*$`, "u");
const HASHTAGS_ONLY = new RegExp(`^(?:\\s*${HASHTAG})+\\s*$`, "u");

/** 文末に並ぶハッシュタグを切り離す。tags は前の空白を含む(戻すときはそのまま連結する) */
export function splitHashtagTail(text: string): { body: string; tags: string } {
  if (HASHTAGS_ONLY.test(text)) return { body: "", tags: text };
  const m = text.match(HASHTAG_TAIL);
  if (!m || m.index === undefined) return { body: text, tags: "" };
  return { body: text.slice(0, m.index), tags: text.slice(m.index) };
}

/** 文の区切りで分割する。区切り文字は前の文に含める。かっこの中の「。？！」では区切らない */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      depth = depth === 0 ? 1 : 0; // 二重引用符は開閉が同じ文字なので交互に扱う
    } else if (OPEN_BRACKETS.includes(ch)) {
      depth++;
    } else if (CLOSE_BRACKETS.includes(ch)) {
      depth = Math.max(0, depth - 1);
    }
    const isBreak = ch === "\n" || (depth === 0 && "。！？!?".includes(ch));
    if (isBreak) {
      // 「！？」「。。」のような連続した区切り文字はまとめる
      while (i + 1 < text.length && depth === 0 && "。！？!?".includes(text[i + 1])) i++;
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.length > 0);
}

/** 「にゃ」と句読点・空白・絵文字を除いた、比較用の文字列 */
export function stripForCompare(s: string): string {
  return s
    .replace(/にゃ[んあー〜～]?/g, "")
    .replace(/[\s。、！？!?,.「」『』…〜～ー]/g, "")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "");
}

/**
 * 「ワロタw」「おっそい（笑）」「うける笑」のように、文の後ろに付くネットスラングの記号。
 * 「にゃ」はこの前に置く。英単語の末尾の w や「爆笑」の笑は対象にしない
 */
const SLANG_TAIL = "(?:(?<![A-Za-z])[wｗ]+|[（(]笑[）)]|(?<!\\p{Script=Han})笑)";

/** 「〜よにゃ」「〜ないなにゃ」のように終助詞の直後に付いた「にゃ」を自然な形に整える */
export function normalizeParticles(text: string): string {
  return text
    // 「ワロタwにゃ」「おっそい（笑）にゃ」のようにスラングの記号の後ろに付いた「にゃ」は前に移す
    .replace(new RegExp(`(${SLANG_TAIL})\\s*(にゃ[んあー〜～]?)`, "gu"), "$2$1")
    // 「〜ませんか？にゃ」のように句読点の後ろに付いた「にゃ」は前に移す(「さぁ?wにゃ」→「さぁにゃ?w」になるよう、スラングの後に行う)
    .replace(/([。！？!?]+)\s*(にゃ[んあー〜～]?)/gu, "$2$1")
    // 「断れなかった…にゃ」のように三点リーダーや波線の後ろに付いた「にゃ」も前に移す(「断れなかったにゃ…」)
    .replace(/([…‥〜～]+)\s*(にゃ[んあー]?)/gu, "$2$1")
    // 「だよにゃ」「ですねにゃ」→「だにゃ」「ですにゃ」
    .replace(/[よねぞぜわ]にゃ/gu, "にゃ")
    // 「ないなにゃ」「だなにゃ」→「ないにゃ」「だにゃ」(「くるなにゃ」のような禁止の な は残す)
    .replace(/(?<=[いだ])なにゃ/gu, "にゃ")
    // 「にゃにゃ」「にゃ？にゃ？」「にゃ？にゃ」のような重複を最初の 1 つにする
    .replace(/(にゃ[！？!?。]?)(?:\s*にゃ[！？!?。]?)+/gu, "$1");
}

const TAIL_EMOJIS = ["🐈", "🐱"];
/** 文の内容から絵文字を決める。ルール変換と LLM 変換で同じ絵文字になり、差し替え時にちらつかない */
function pickEmoji(body: string): string {
  const key = stripForCompare(body);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TAIL_EMOJIS[h % TAIL_EMOJIS.length];
}

/** 出力が入力とほぼ同じ (変換されていない) */
export function unchanged(outText: string, inText: string): boolean {
  const norm = (x: string) => x.replace(/[\s。！？!?、]/g, "");
  return norm(outText) === norm(inText);
}

/** 文末の「にゃ」を保証する。LLM の出力がルールから外れたときの保険にも、ルールのみ変換にも使う */
export function ensureNyan(text: string): string {
  const parts = splitSentences(text);
  const fixed = parts.map((seg) => {
    // 文末のハッシュタグは外しておき、「にゃ」を付けた後ろに戻す
    const { body: core, tags } = splitHashtagTail(seg);
    const m = core.match(/^(.*?)([\s。！？!?\n…〜～ー♪♡\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]*)$/su);
    if (!m) return seg;
    const body = m[1];
    const tail = m[2] || "";
    // 空、または「は？」のような 1 文字の相づちは触らない
    if (body.trim().length <= 1) return seg;
    // 日本語を含まない文(「Yahoo!ニュース」の「Yahoo!」、英語の感嘆文)には付けない。LLM の経路と同じ判定
    if (!hasJapanese(core)) return seg;
    // 日付やラベルのような文でないものには付けない
    if (!looksLikeSentence(core)) return seg;
    if (/(にゃ|にゃん|にゃあ|にゃー|にゃ〜|にゃ～)$/u.test(body)) return seg;
    return normalizeParticles(body + "にゃ") + tail + tags;
  });
  return moveNyanIntoQuotes(fixed.join(""));
}

/**
 * 「もう帰る」にゃ → 「もう帰るにゃ」のように、かぎかっこで閉じた発話の後ろに付いた「にゃ」を中に入れる。
 * 中身が文(述語で終わる)のときだけ。「タイトルは『春』にゃ」のような名詞の引用はそのまま
 */
export function moveNyanIntoQuotes(text: string): string {
  return text.replace(/([「『])([^「」『』]*?)([」』])\s*(にゃ[んあー〜～]?)/gu, (m, open, inner, close, nyan) =>
    looksLikeSentence(inner) ? `${open}${normalizeParticles(inner + nyan)}${close}` : m,
  );
}

/** LLM の出力を整える。input を渡すと、元の文にあったかぎかっこは残す */
export function postProcess(text: string, emoji: boolean, input?: string): string {
  let t = text.trim();
  // thinking の残骸を除去
  t = t.replace(/<think>[\s\S]*?<\/think>/gu, "").trim();
  // 先頭のラベルを除去
  t = t.replace(/^(変換後|出力|ねこ語|にゃん訳|結果)\s*[:：]\s*/u, "");
  // モデルが勝手に付けた、全体を囲む引用符を除去(元の文が引用符で始まる場合は残す)
  if (!input || !/^[「『"“]/u.test(input.trim())) t = t.replace(/^[「『"“]+/u, "");
  if (!input || !/[」』"”]$/u.test(input.trim())) t = t.replace(/[」』"”]+$/u, "");
  t = t.trim();
  if (!t) return t;

  let out = ensureNyan(normalizeParticles(t));
  // 同じ絵文字・記号の連続を 1 つにまとめる
  out = out.replace(/(\p{Extended_Pictographic}️?)(?:\s*\1)+/gu, "$1");
  // まったく同じ文の繰り返しを除去する
  const seen = new Set<string>();
  out = splitSentences(out)
    .filter((s) => {
      const k = s.trim();
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join("");
  out = out.trim();
  return emoji ? addTailEmojis(out) : out;
}

/** 各文の終わりに 🐈 / 🐱 を付ける。句点「。」は絵文字に置き換え、「！」「？」は残す */
export function addTailEmojis(text: string): string {
  // 文末の句読点・三点リーダーの後ろに絵文字を付ける(「断れなかったにゃ…🐱」)。
  // かぎかっこで閉じた発話では、絵文字もかっこの中に入れる(「もう帰るにゃ🐱」)
  const re = new RegExp(`^(.*?)([。！？!?…‥]*)(${SLANG_TAIL}?)([。！？!?…‥]*)([」』]*)(\\s*)$`, "su");
  return splitSentences(text)
    .map((seg) => {
      // 文末のハッシュタグは外しておき、絵文字の後ろに戻す
      const { body: core, tags } = splitHashtagTail(seg);
      const m = core.match(re);
      if (!m) return seg;
      const [, body, punct1, slang, punct2, closeQuotes, trail] = m;
      // 空、または「は？」のような 1 文字の相づちには付けない
      if (body.trim().length <= 1) return seg;
      // 変換されていない(にゃ で終わっていない)文には付けない
      if (!/(にゃ|にゃん|にゃあ|にゃー|にゃ〜|にゃ～)$/u.test(body)) return seg;
      if (/\p{Extended_Pictographic}️?\s*$/u.test(body)) return seg;
      return body + punct1.replace(/。/g, "") + slang + punct2.replace(/。/g, "") + pickEmoji(body) + closeQuotes + trail + tags;
    })
    .join("");
}

/** ルールのみの変換。LLM を使わず即座に返す */
export function convertByRule(text: string, emoji: boolean): string {
  const out = ensureNyan(text);
  return emoji ? addTailEmojis(out) : out;
}

/** 日本語の文字を含むか */
export function hasJapanese(text: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
}

/** UI のラベルによくある言い回し。文の形をしていても変換しない */
const UI_LABELS = new Set([
  "おすすめ", "おまけ", "いいね", "お知らせ", "お問い合わせ", "問い合わせ", "お気に入り",
  "もっと見る", "続きを読む", "詳細を見る", "すべて見る", "さらに表示", "もっと読む", "全文を表示",
  "読み込み中", "送信中", "返信する", "共有する", "報告する", "保存する", "削除する", "編集する",
  "投稿する", "送信する", "登録する", "購入する", "ログインする", "ログアウトする", "フォローする",
  "コピーする", "検索する", "閉じる", "開く", "戻る", "次へ", "前へ", "同意する", "キャンセル",
]);

/**
 * 述語で終わる「文」らしいか。日付、ラベル、見出し、名詞だけの文字列を変換対象から外すための判定。
 * 形態素解析は使わず、末尾の形で判断する
 */
export function looksLikeSentence(text: string): boolean {
  // ハッシュタグだけなら文ではない。文末に並ぶハッシュタグは外して判定する
  let t = splitHashtagTail(text.trim()).body.trim();
  // 末尾の「（編集済み）」「(edited)」のようなかっこ書きを外す
  t = t.replace(/[（(][^（）()]*[）)]\s*$/u, "").trim();
  // 末尾の絵文字・記号・空白を外す
  t = t.replace(/[\s\p{Extended_Pictographic}\uFE0F…〜～ー♪♡♥★☆]+$/u, "");
  // 閉じかっこは中身で判断する(「もう帰る。」のように句点がかっこの中にあることがあるので、先に外す)
  t = t.replace(/[」』）)]+$/u, "");
  const endsWithPunct = /[。！？!?]$/u.test(t);
  t = t.replace(/[。！？!?]+$/u, "").trim();
  t = t.replace(/[」』）)]+$/u, "");
  // 「！？」のように中身が記号だけのかぎかっこは文ではない
  if (/[「『（(]$/u.test(t)) return false;
  if (t.length < 2) return false;
  if (UI_LABELS.has(t)) return false;
  // 「返信する」「コメントを追加する」のような動作ラベル(助詞が「を」だけで、漢字・カタカナ + する)
  if (/^(?:[\p{Script=Han}\p{Script=Katakana}ー]+を)?[\p{Script=Han}\p{Script=Katakana}ー]+(する|して|へ)$/u.test(t)) return false;
  // 「初心者向け」「対応済み」のような名詞、「名無しさん」のような呼び名
  if (/(向け|済み|付き|込み|入り|あり|なし|のみ|さん|くん|ちゃん|様|氏)$/u.test(t)) return false;
  // 句点・感嘆符・疑問符で終わっていれば文とみなす(体言止めも含む)
  if (endsWithPunct) return true;
  // ネットスラングの文末
  if (/(草|w+|笑)$/u.test(t)) return true;
  // 「い」を省いた形容詞(「説明おっそ」「これやば」)と、よく使う命令形(「言え」「急げ」。「え」で終わる名詞と区別できないので個別に)
  if (/(やば|すご|すげ|うま|はや|おそ|おっそ|でか|こわ|たか|たっか|やす|やっす|きも|えぐ|しんど|ねむ|だる|さむ|あつ|いた|くさ|まず|うざ|ださ|むず|つら|きつ|きっつ)$/u.test(t)) return true;
  if (/(言え|追え|買え|払え|使え|会え|笑え|急げ|飛べ|遊べ|学べ|選べ|呼べ|叫べ|帰れ|消えろ)$/u.test(t)) return true;
  // 典型的な文末表現
  if (/(けど|けれど|から|ので|のに|って|じゃん|やん|っす|かも|かな|よね|だね|たい|ない|てる|です|ます|でした|ました|ません|だろ|でしょ|ろ|れ|ね|な|よ|ぞ|ぜ|わ|か|の|さ|や)$/u.test(t)) return true;
  // 動詞・形容詞・助動詞の終止形は う段、た/だ、い、ん で終わる。命令形は け/て を許容する
  return /[うくぐすずつづぬふぶむるただいんけてめせ]$/u.test(t);
}

/** 変換対象にする価値があるテキストか。複数文なら、どれか 1 つでも文らしければ対象にする */
export function isConvertible(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  if (!hasJapanese(t)) return false;
  // ひらがな・カタカナが一つもない(漢字だけ、固有名詞など)は対象外
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)) return false;
  return splitSentences(t).some(looksLikeSentence);
}

// ---------- チューニング済みモデルの出力検査 ----------

/**
 * 言い換えで許す「元の語尾 → 変換後の語尾」の組。nyantopia-model の docs/style-guide.md の対応表と同じ内容。
 * モデルが提案した言い換えのうち、この表にある形だけを通し、それ以外(意味が変わるもの)はルール変換に戻す
 */
const TAIL_REWRITES: [string, string][] = [
  // 禁止: 〜するな → 〜しないで(五段・一段・サ変・カ変、縮約形)
  ["るな", "ないで"], ["くな", "かないで"], ["ぐな", "がないで"], ["すな", "さないで"], ["つな", "たないで"],
  ["ぬな", "なないで"], ["ぶな", "ばないで"], ["むな", "まないで"], ["うな", "わないで"],
  ["すんな", "しないで"], ["くんな", "こないで"], ["んな", "ないで"], ["来るな", "来ないで"],
  // 命令: 〜しろ → 〜して(一段・五段・サ変・カ変)
  ["ろ", "て"], ["しろ", "して"], ["せ", "して"], ["え", "って"], ["け", "いて"], ["げ", "いで"],
  ["て", "って"], ["れ", "って"], ["ね", "んで"], ["べ", "んで"], ["め", "んで"], ["来い", "来て"], ["こい", "きて"],
  ["やれ", "やって"], ["黙れ", "黙ってて"], ["黙ってろ", "黙ってて"], ["ってろ", "ってて"],
  // 断定: 〜んだよ → 〜の、〜だろ → (なし)、〜じゃねえか → 〜じゃないか、乱暴な否定 〜ねえ → 〜ない
  ["んだ", "の"], ["んだろ", "の"], ["だろ", ""], ["だろうが", ""], ["じゃねえか", "じゃないか"], ["じゃねーか", "じゃないか"],
  ["ねえ", "ない"], ["ねぇ", "ない"], ["ねー", "ない"], ["ねえぞ", "ない"], ["ねえよ", "ない"],
  ["ぞ", ""], ["ぜ", ""], ["っつーの", ""], ["だっつーの", ""],
  ["かよ", "のか"], ["のか", "のか"], ["せえ", "して"], ["うぜえ", "うざい"], ["うるせえ", "うるさい"],
  ["やがって", "やがって"],
  // 関西弁(方言のままやわらかく)
  ["とけ", "といて"], ["とけよ", "といて"], ["すんな", "せんといて"], ["来んな", "来んといて"], ["んな", "んといて"],
  ["やろ", "やん"], ["やろが", "やん"], ["やんけ", "やん"], ["せえや", "して"], ["しいや", "して"], ["やれや", "やって"],
  ["ねん", "の"], ["言わすねん", "言わすの"], ["や", ""],
  // 五段動詞の禁止(入るな → 入らないで)、縮約形(待たせんだよ → 待たせるの、してんだ → してんの、すんぞ → する)
  ["るな", "らないで"], ["るんじゃない", "ないで"], ["るんじゃねえ", "ないで"],
  ["んだ", "るの"], ["んだ", "んの"], ["んだろ", "る"], ["んだろ", "るの"], ["んだろ", "んの"], ["んだぞ", "るの"],
  ["んぞ", "る"], ["んぞ", "るの"], ["んじゃねえ", "るんじゃない"], ["すんじゃねえ", "するんじゃない"],
  ["じゃねえ", "じゃない"], ["じゃねぇ", "じゃない"], ["じゃねー", "じゃない"], ["ねえだろ", "ない"], ["ねえんだよ", "ないの"],
  // 「だ」で終わる断定は落としてよい(近所迷惑だ → 近所迷惑にゃ)
  ["だ", ""], ["だぞ", ""], ["だよ", ""], ["なんだ", "なの"], ["なんだよ", "なの"],
  ["てけ", "てって"], ["てこい", "てきて"], ["うっせえ", "うるさい"], ["うるせえ", "うるさい"], ["うっせー", "うるさい"],
  ["かよ", "なのか"], ["っか", "ない"], ["ちまうぞ", "ちまう"],
  // サ変・カ行の命令と禁止、「〜って」「〜っつーの」付き、乱暴な疑問、関西弁の命令
  ["するな", "しないで"], ["行け", "行って"], ["いけ", "いって"], ["え", "て"], ["えや", "えて"],
  ["れって", "って"], ["ろって", "て"], ["しろって", "して"], ["とけって", "といて"], ["とけっつーの", "といて"], ["ろっつーの", "て"],
  ["んな", "らないで"], ["んなや", "らんといて"], ["んな", "らんといて"],
  ["ねえのか", "ないのか"], ["ねえのかよ", "ないのか"], ["ねえか", "ないか"],
  ["たろ", "た"], ["だ", "なの"], ["だよ", "なの"], ["だろ", "なの"],
  // 残りのよくある形: 〜くるな、〜んだが、〜うんじゃない、乱暴な形容詞(でけえ → でかい)、〜っつーの
  ["くるな", "こないで"], ["くんなって", "こないで"], ["んだが", "の"], ["んだろうが", "の"], ["んだろうが", "る"], ["んだ", "る"],
  ["うんじゃない", "わないで"], ["くんじゃない", "かないで"], ["すんじゃない", "さないで"], ["つんじゃない", "たないで"],
  ["ぶんじゃない", "ばないで"], ["むんじゃない", "まないで"], ["んじゃねえか", "るじゃないか"], ["ねえじゃねえか", "ないじゃないか"],
  ["ねえんだぞ", "ないの"], ["えんだ", "いの"], ["えぞ", "い"], ["けえ", "かい"], ["くせえ", "くさい"], ["せえ", "さい"], ["てえ", "たい"],
  ["食うな", "食べないで"], ["うか", "わない"], ["だっつーの", "なの"], ["っつーの", ""],
];

/** 落としてよい文末の終助詞(1 つだけ) */
const DROPPABLE_PARTICLES = "よねわなぞぜさや";

/** 文の区切り(文と節)。言い換えはそれぞれの末尾で起きる */
const CLAUSE_SPLIT = /(?<=[。！？!?、])/u;

/** 比較用: 「にゃ」、文末のスラング記号、句読点・空白・かっこを除く */
function stripTail(s: string): string {
  return s
    .replace(/にゃ[んあー〜～]?/gu, "")
    .replace(/(?:(?<![A-Za-z])[wｗ]+|[（(]笑[）)]|(?<!\p{Script=Han})笑)+(?=[\s。、！？!?,.]*$)/u, "")
    .replace(/[\s。、！？!?,.「」『』…〜～ー（）()]/gu, "");
}

function clauseAllowed(inp: string, out: string): boolean {
  if (inp === out) return true;
  // 終助詞を 1 つ落としただけ
  const dropped = inp.length > 1 && DROPPABLE_PARTICLES.includes(inp[inp.length - 1]) ? inp.slice(0, -1) : inp;
  if (dropped === out) return true;
  // 「〜しろって」「〜すんなって」の引用の「って」は落としてよい
  const candidates = [inp, dropped];
  for (const c of [inp, dropped]) if (c.endsWith("って") && c.length > 3) candidates.push(c.slice(0, -2));
  for (const src of candidates) {
    for (const [a, b] of TAIL_REWRITES) {
      if (!src.endsWith(a)) continue;
      const head = src.slice(0, src.length - a.length);
      if (out === head + b) return true;
    }
  }
  return false;
}

/**
 * チューニング済みモデルの出力が、対応表の範囲の言い換えに収まっているか。
 * 文(節)ごとに、元の文との違いが「終助詞を 1 つ落とす」「対応表の語尾の組」のどれかであれば通す
 */
export function isAllowedRewrite(input: string, output: string): boolean {
  const seg = (s: string) => s.split(CLAUSE_SPLIT).map(stripTail).filter((x) => x.length > 0);
  const a = seg(input);
  const b = seg(output);
  if (a.length !== b.length) return false;
  return a.every((x, i) => clauseAllowed(x, b[i]));
}
