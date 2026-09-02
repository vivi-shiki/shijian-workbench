import fs from "node:fs/promises";
import path from "node:path";
import { HistoryStore } from "../server/change-history.mjs";

const projectId = process.argv[2] || "yiyuji-four-volumes";
const target = path.resolve("data", "projects", projectId, "ebook", "structured.json");
const document = JSON.parse(await fs.readFile(target, "utf8"));
const originalDocument = structuredClone(document);
const history = new HistoryStore(path.resolve("data", "projects"));
if (document.review?.basis === "2026-09-01 user review") {
  console.log(`Review already applied to ${target}`);
  process.exit(0);
}
const originalEntries = document.entries;
const originalNotes = originalEntries.find(entry => entry.id === "entry-0008")?.notes || [];
const noteByMarker = new Map(originalNotes.map(note => [note.marker, note]));

function note(marker, text) {
  const source = noteByMarker.get(marker);
  return { marker, text: text || source?.text || "" };
}

function entry(kind, fields = {}) {
  return {
    id: "",
    kind,
    title: "",
    subtitle: "",
    author: "",
    form: "",
    series: null,
    lines: [],
    prose: "",
    notes: [],
    source_pages: [],
    confidence: 1,
    review_status: "reviewed",
    ...fields
  };
}

function poem(lines, sourcePages, series, notes = [], fields = {}) {
  return entry("poem", {
    form: "七言絕句",
    lines,
    notes,
    source_pages: sourcePages,
    series,
    ...fields
  });
}

const firstPreface = originalEntries.find(item => item.id === "entry-0005");
const secondPreface = originalEntries.find(item => item.id === "entry-0006");
const splitPrefaces = originalEntries.find(item => item.id === "entry-0007").prose.split("\n");

const reviewed = [
  entry("heading", { title: "疑雨集註", subtitle: "掃葉山房印行", source_pages: [1] }),
  entry("book_text", {
    title: "首頁題字",
    lines: ["常熟丁秉衡先生註", "後齋伊太勤題", "總發行所", "上海北市棋盤街", "掃葉山房"],
    source_pages: [3, 4],
    confidence: 0.8,
    review_status: "needs_review"
  }),
  { ...firstPreface, author: "", review_status: "reviewed" },
  { ...secondPreface, author: "", review_status: "reviewed" },
  entry("preface", { title: "疑雨集注序", prose: splitPrefaces[0], source_pages: [9, 10] }),
  entry("preface", { title: "疑雨集注序", prose: splitPrefaces[1], source_pages: [11, 12, 13] }),
  entry("biography", {
    title: "金壇縣志",
    prose: "王彦泓字次回歲貢生博雅有俊才詩工豔體格調逼真韓致\n光所著有泥蓮疑雨等稿嘗手錄成帙筆精墨妙人稱雙絕任\n松江訓導年甫艾而沒",
    source_pages: [15]
  }),
  entry("book_text", {
    title: "卷端",
    lines: ["疑雨集註卷一", "金壇王彥泓次回原撰", "常熟丁國鈞秉衡注"],
    source_pages: [17]
  }),
  poem(
    ["四月春蠶巳剝綿，", "困人風日嫁人天。", "不知織就鴛鴦錦，", "廢却如花幾夜眠。"],
    [17],
    null,
    [note("花燭詞"), note("四月春蠶巳剝綿"), note("織就鴛鴦錦"), note("廢却如花幾夜眠")],
    { title: "乙卯年", subtitle: "花燭詞" }
  ),
  poem(
    ["弄玉當年未嫁時，", "徘徊好影自矜持。", "幾從畫府迴嬌靨，", "差向花間臾綺綨。"],
    [17], { title: "無題", index: 1, total: 8 },
    [note("弄玉當年未嫁時"), note("徘徊好影自矜持"), note("幾從畫府迴嬌靨"), note("差向花間臾綺綨")]
  ),
  poem(
    ["千蝶帳深縈短夢，", "九雛釵重困初笄。", "朝迴夫壻鳴騶去，", "却下珠簾不敢窺。"],
    [17, 18], { title: "無題", index: 2, total: 8 },
    [note("千蝶帳深縈短夢"), note("九雛釵重困初笄"), note("朝迴夫壻鳴騶去"), note("却下珠簾不敢窺")]
  ),
  poem(
    ["學書不學衞夫人，", "度曲惟教唱柳君。", "鸚鵡自將新律教，", "猧兒閒取練香薰。"],
    [18], { title: "無題", index: 3, total: 8 },
    [note("學書不學衞夫人"), note("度曲惟教唱柳君"), note("鸚鵡自將新律教"), note("猧兒閒取練香薰")]
  ),
  poem(
    ["鏡中鑄就嬌顏色，", "帳裏驚迴好夢魂。", "一榻茶煙清似水，", "金釵劃作斷腸紋。"],
    [18], { title: "無題", index: 4, total: 8 },
    [note("鏡中鑄就嬌顏色"), note("帳裏驚迴好夢魂")]
  ),
  poem(
    ["瓊樹瑤枝分外清，", "雒川應是舊儀形。", "閣中碧玉誰人識，", "樓上羅敷祗自名。"],
    [18], { title: "無題", index: 5, total: 8 },
    [note("瓊樹瑤枝分外清"), note("雒川應是舊儀形"), note("閣中碧玉誰人識"), note("樓上羅敷祗自名")]
  ),
  poem(
    ["三尺吐雲嫌髻短，", "五銖含霧喜身輕。", "從來不作多情調，", "羞讀關睢第四聲。"],
    [18, 19], { title: "無題", index: 6, total: 8 },
    [note("三尺吐雲嫌髻短"), note("五銖含霧喜身輕")]
  ),
  poem(
    ["栽培艷質向瑤階，", "取次簾櫳不放開。", "裹手倩人收寶鈿，", "含顰揀樣畫香煤。"],
    [19], { title: "無題", index: 7, total: 8 },
    [note("栽培艷質向瑤階"), note("取次簾櫳不放開"), note("裹手倩人收寶鈿"), note("含顰揀樣畫香煤")]
  ),
  poem(
    ["腰肢未許同行擬，", "性格還從夫壻猜。", "阿母錯憐教不嫁，", "幾回偷看畫圖來。"],
    [19], { title: "無題", index: 8, total: 8 },
    [note("阿母錯憐教不嫁")]
  ),
  poem(
    ["嬌羞不肯下粧臺，", "侍女環將九子釵。", "寄語倦粧人說道，", "輕施朱粉學慵來。"],
    [19], { title: "催粧詩六首", index: 1, total: 6 },
    [note("嬌羞不肯下粧臺"), note("侍女環將九子釵"), note("寄語倦粧人說道")]
  ),
  poem(
    ["十步笙歌響碧霄，", "嚴粧無力夜迢迢。", "休將雙黛憑人試，", "留與張郎見後描。"],
    [19, 20], { title: "催粧詩六首", index: 2, total: 6 },
    [note("嚴粧無力夜迢迢"), note("休將雙黛憑人試")]
  ),
  poem(
    ["說嫁心驚盡曰癡，", "尊前玉筯鎮雙垂。", "不知夫壻尤憐惜，", "却勝嬌嗔阿母時。"],
    [20], { title: "催粧詩六首", index: 3, total: 6 },
    [note("尊前玉筯鎮雙垂")]
  ),
  poem(
    ["羞向明窗結佩璫，", "穿衣寶鏡暗生光。", "生憎烏鵲來相噪，", "嘿嘿無言下象牀。"],
    [20], { title: "催粧詩六首", index: 4, total: 6 },
    [note("穿衣寶鏡暗生光"), note("生憎烏鵲來相噪"), note("嘿嘿無言下象牀")]
  ),
  poem(
    ["當初忍笑畫鴛鴦，", "真箇如今擬鳳凰。", "別却羣仙拜王母，", "巳聞青鳥報劉郎。"],
    [20], { title: "催粧詩六首", index: 5, total: 6 },
    [note("當初忍笑畫鴛鴦"), note("巳聞青鳥報劉郎")]
  ),
  poem(
    ["雲作雙鬟雪作肌，", "天教分付與男兒。", "轉身拭淚銀河畔，", "別却鴛機再不歸。"],
    [20, 21], { title: "催粧詩六首", index: 6, total: 6 },
    [note("轉身拭淚銀河畔"), note("別却鴛機再不歸", "上官儀詩方移花影上鴛機")]
  ),
  entry("heading", { title: "丙辰年", source_pages: [21] }),
  poem(
    ["月鐘霜瓦凍鴉啼，", "夢裏楓橋却向西。", "暖語未終天忽曉，", "不堪空作翠鄉迷。"],
    [21], { title: "吳行紀事", index: 1 }, [note("月鐘霜瓦凍鴉啼", noteByMarker.get("一統志")?.text)]
  ),
  poem(
    ["相要不說卷衣裳，", "笑挽流蘇背燭光。", "賴有暖言堪入骨，", "一宵輸意伴王昌。"],
    [21], { title: "吳行紀事", index: 2 },
    [note("相要不說卷衣裳", noteByMarker.get("樂府古題要解")?.text), note("笑挽流蘇背燭光", noteByMarker.get("海錄碎事")?.text), note("賴有暖言堪入骨", noteByMarker.get("溫庭筠")?.text), note("一宵輸意伴王昌", noteByMarker.get("崔顥")?.text)]
  ),
  poem(
    ["遶身一步也堪憐，", "特地呼來放膝邊。", "問道初寒身怕冷，", "今宵多半要裝綿。"],
    [21], { title: "吳行紀事", index: 3 }, [note("今宵多半要裝綿", noteByMarker.get("杜甫")?.text)]
  )
];

const untouched = originalEntries.slice(8).map(item => ({ ...item }));
document.entries = [...reviewed, ...untouched].map((item, index) => ({
  ...item,
  id: `entry-${String(index + 1).padStart(4, "0")}`,
  series: item.series || null
}));
document.issues = document.issues.filter(issue => !["issue-0002", "issue-0014", "issue-0015"].includes(issue.id));
document.review = {
  updated_at: new Date().toISOString(),
  reviewed_pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18, 19, 20, 21],
  basis: "2026-09-01 user review"
};

const backupDirectory = path.join(path.dirname(target), "backups");
await fs.mkdir(backupDirectory, { recursive: true });
const backup = path.join(backupDirectory, "structured-before-20260901-review.json");
try {
  await fs.access(backup);
} catch {
  await fs.copyFile(target, backup);
}
const temporary = `${target}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
await fs.rename(temporary, target);
await history.recordChange({ projectId, target: { kind: "ebook" }, before: originalDocument, after: document,
  actor: "ai:codex", source: "codex-review-script", operation: "codex_review",
  note: "Codex 疑雨集电子书首轮校订" });
console.log(`Updated ${target}: ${document.entries.length} entries`);
console.log(`Backup ${backup}`);
