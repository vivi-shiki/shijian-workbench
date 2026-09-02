import fs from "node:fs/promises";
import path from "node:path";
import { HistoryStore } from "../server/change-history.mjs";

const projectId = process.argv[2] || "yiyuji-four-volumes";
const target = path.resolve("data", "projects", projectId, "ebook", "structured.json");
const document = JSON.parse(await fs.readFile(target, "utf8"));
const originalDocument = structuredClone(document);
const history = new HistoryStore(path.resolve("data", "projects"));
const revisionKey = "2026-09-02 poetry hierarchy review";
if (document.review?.revisions?.some(item => item.basis === revisionKey)) {
  console.log(`Review already applied to ${target}`);
  process.exit(0);
}

function entry(kind, fields = {}) {
  return {
    id: "",
    kind,
    title: "",
    subtitle: "",
    author: "",
    form: "",
    heading_level: null,
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

function poem(lines, sourcePages, fields = {}) {
  return entry("poem", { lines, source_pages: sourcePages, ...fields });
}

function note(marker, text) {
  return { marker, text };
}

const prefix = [];
for (const source of document.entries.filter(item => item.source_pages.every(page => page < 22))) {
  const current = { ...source, heading_level: source.heading_level || null };
  if (current.kind === "book_text" && current.title === "卷端") {
    prefix.push(entry("heading", {
      title: current.lines[0] || "疑雨集註卷一",
      heading_level: 1,
      source_pages: current.source_pages
    }));
    prefix.push(entry("book_text", {
      title: "卷端題署",
      lines: current.lines.slice(1),
      source_pages: current.source_pages
    }));
    continue;
  }
  if (current.kind === "poem" && current.title === "乙卯年") {
    prefix.push(entry("heading", { title: "乙卯年", heading_level: 2, source_pages: current.source_pages }));
    prefix.push({ ...current, title: "花燭詞", subtitle: "" });
    continue;
  }
  if (current.kind === "heading" && current.title === "丙辰年") current.heading_level = 2;
  if (current.series?.title === "吳行紀事") current.series = { ...current.series, total: 7 };
  prefix.push(current);
}

const reviewed = [
  poem(
    ["燒殘絳蠟啼千筯，", "碎嚼冰蠶攪萬絲。", "水國不生紅豆子，", "贈卿何物助相思。"],
    [22],
    {
      form: "七言絕句",
      series: { title: "吳行紀事", index: 4, total: 7 },
      notes: [
        note("燒殘絳蠟啼千筯", "蘇軾詩：絳蠟燒殘玉斚飛，驪歌唱徹萬行啼。"),
        note("碎嚼冰蠶攪萬絲", "拾遺記：員嶠山有冰蠶，以霜雪覆之，然後作繭，長一丈，其色五彩。"),
        note("水國不生紅豆子", "晏子春秋：河伯以水為國。"),
        note("贈卿何物助相思", "王維詩：紅豆生南國，春來發幾枝。勸君多采擷，此物最相思。")
      ]
    }
  ),
  poem(
    ["尊前一笑兩相同，", "映燭羞顏旖旎紅。", "更有銷魂人不見，", "斷雲零雨數聲中。"],
    [22],
    {
      form: "七言絕句",
      series: { title: "吳行紀事", index: 5, total: 7 },
      notes: [
        note("映燭羞顏旖旎紅", "李白長干行：羞顏未嘗開。上林賦注：旖旎，猶阿那也。"),
        note("更有銷魂人不見", "金趙可贈妓詞：悵斷雲零雨，不見高城。")
      ]
    }
  ),
  poem(
    ["愛弄黃金佛手香，", "不因清囀不輕嘗。", "從今奪却春鶯舌，", "只辨雙柑聽繞梁。"],
    [22],
    {
      form: "七言絕句",
      series: { title: "吳行紀事", index: 6, total: 7 },
      notes: [
        note("愛弄黃金佛手香", "羣芳譜：佛手柑木似朱欒，其實如人手有指，清香襲人。"),
        note("只辨雙柑聽繞梁", "世說補：戴仲若春日擕雙柑斗酒，人問何之，答曰聽黃鸝聲。列子：韓娥鬻歌於雍門，既去而餘音繞梁三日不絕。")
      ]
    }
  ),
  poem(
    ["感郎珍重不能羞，", "夜淺香濃掩畫樓。", "翠澀乍慵花上蝶，", "紅酣常溼雨中鳩。"],
    [22],
    {
      form: "七言絕句",
      series: { title: "吳行紀事", index: 7, total: 7 },
      notes: [
        note("感郎珍重不能羞", "樂府碧玉歌：感郎千金意。韋莊詞：縱被無情棄，不能羞。詳案：孫綽情人碧玉歌作感郎不羞。"),
        note("夜淺香濃", "一作春深。")
      ]
    }
  ),
  entry("heading", { title: "丁巳年", heading_level: 2, source_pages: [23] }),
  poem(
    ["燈樓月沼映春雲，", "簫鼓風前院院聞。", "但是酒旗歌板地，", "一時淒切想離羣。"],
    [23],
    {
      form: "七言絕句",
      series: { title: "燈宵記事", index: 1, total: 4 },
      notes: [
        note("燈樓月沼映春雲", "李商隱詩：樓上春雲水底天。"),
        note("但是酒旗歌板地", "元稹詩：試問酒旗歌板地。"),
        note("一時淒切想離羣", "裴羽仙詩：獨下瑤階轉淒切。禮檀弓：吾離羣而索居亦已久矣。")
      ]
    }
  ),
  poem(
    ["踏月天街艷步狂，", "微風一道染衣香。", "遊人暗逐芳塵去，", "拾得兒家紫佩囊。"],
    [23],
    {
      form: "七言絕句",
      series: { title: "燈宵記事", index: 2, total: 4 },
      notes: [
        note("踏月天街艷步狂", "韓愈詩：天街小雨潤如酥。"),
        note("微風一道", "一作路。"),
        note("遊人暗逐芳塵去", "陸雲賦：蒙紫庭之芳塵兮。"),
        note("拾得兒家紫佩囊", "杜甫詩：莫佩紫荷囊。")
      ]
    }
  ),
  poem(
    ["春空淡白照銀紗，", "一徑幽尋避月華。", "記得畫橋南畔去，", "綠楊陰下是他家。"],
    [23],
    {
      form: "七言絕句",
      series: { title: "燈宵記事", index: 3, total: 4 },
      notes: [
        note("春空淡白照銀紗", "照一作似。齊東野語：紗之輕者曰銀條紗。"),
        note("一徑幽尋避月華", "歐陽修詞：闌干倚處，待得月華生。"),
        note("記得畫橋南畔去", "南一作西。司空圖詩品：畫橋碧陰。"),
        note("綠楊陰下是他家", "孫蕡詩：綠楊陰下玉驄嘶。")
      ]
    }
  ),
  poem(
    ["趙李鈿車昔昔遊，", "酒邊燈下共遲留。", "如何月照金堂夜，", "只有梅花伴莫愁。"],
    [24],
    {
      form: "七言絕句",
      series: { title: "燈宵記事", index: 4, total: 4 },
      notes: [
        note("趙李鈿車昔昔遊", "阮籍詠懷詩：西遊咸陽中，趙李相經過。周邦彥詞：鈿車如水，時時花徑相過。列子：昔昔夢為國君。按昔昔即夜夜也。"),
        note("如何月照金堂夜", "沈佺期詩：盧家少婦鬱金堂。"),
        note("只有梅花伴莫愁", "梁武帝詩：盧家少婦名莫愁。")
      ]
    }
  ),
  poem(
    ["玉壺傳點出花叢，", "青鳥銜箋尚未通。", "砌就銀灣烏不渡，", "築成瑤島鶴難逢。", "春濃逗夢三千里，", "路暗迷人十二峯。", "蠟照漸微香炧冷，", "珮聲纔達畫堂東。"],
    [24],
    {
      form: "七言律詩",
      series: { title: "無題", index: 1, total: 2 },
      notes: [
        note("玉壺傳點出花叢", "李商隱詩：玉壺傳點咽銅龍。"),
        note("青鳥銜箋尚未通", "劉禹錫詩：能言青鳥罷銜箋。"),
        note("砌就銀灣烏不渡", "雞跖集：銀灣謂銀河也。"),
        note("築成瑤島鶴難逢", "陸游詩：放鶴去尋三島路。"),
        note("路暗迷人十二峯", "李端詩：巫山十二峯皆在碧虛中。")
      ]
    }
  ),
  poem(
    ["繞枕離懷話未窮，", "河梁只在此樓中。", "迎愁月剩三分白，", "隔淚燈搖一點紅。", "有霧不曾遮別路，", "隨風想得過花叢。", "王昌望裏千回首，", "滿院簾櫳颺曉風。"],
    [24, 25],
    {
      form: "七言律詩",
      series: { title: "無題", index: 2, total: 2 },
      notes: [
        note("河梁只在此樓中", "李陵別蘇武詩：攜手上河梁，遊子暮何之。"),
        note("王昌望裏千回首", "韓偓詩：王昌只在此墻東。")
      ]
    }
  ),
  entry("heading", { title: "戊午年", heading_level: 2, source_pages: [25] }),
  poem(
    ["心期如水較清深，", "未許湘波隔桂林。", "勝賞每邀雌蜺句，", "壯情時警怒鼃吟。", "機邊手爪歡何似，", "鏡裏頭顱嘆不禁。", "此夕吳裝冷煙月，", "橫塘清嘯一相尋。"],
    [25],
    {
      title: "入吳訪賀無因",
      form: "七言律詩",
      notes: [
        note("心期如水較清深", "李白贈汪倫詩：桃花潭水深千尺，不及汪倫送我情。"),
        note("未許湘波隔桂林", "張平子四愁詩：吾所思兮在桂林，欲往從之湘水深。"),
        note("勝賞每邀雌蜺句", "南史王筠傳：沈約製郊居賦示筠，筠讀至雌蜺連蜷，約撫掌欣忭。"),
        note("壯情時警怒鼃吟", "韓非子：越王伐吳，見怒鼃乃為之式。"),
        note("機邊手爪歡何似", "古詩：顏色雖相似，手爪不相如；新人工織縑，故人工織素。"),
        note("鏡裏頭顱嘆不禁", "陸游詩：功名正爾嘆頭顱。"),
        note("橫塘清嘯一相尋", "寰宇紀：蘇州府吳縣石湖北有橫塘。")
      ]
    }
  ),
  poem(
    ["大地炎埃隙地清，", "烏衣遊集葛衣新。", "巳隨雁序流三雅，", "更倚篪音奏四聲。", "慕寂未能捐塵拂，", "凌寒何事熨棋枰。", "阿連更借幽心句，", "一夕西堂夢草生。"],
    [25, 26],
    {
      title: "昆季避暑分韻得清字",
      form: "七言律詩",
      notes: [
        note("大地炎埃隙地清", "朱超然詩：當夏苦炎埃。"),
        note("烏衣遊集葛衣新", "南史謝宏微傳：叔父混與族子靈運、瞻、晦曜以文義賞會，居烏衣巷，故謂之烏衣之遊。"),
        note("巳隨雁序流三雅", "魏文帝典論：劉表有酒爵三，曰伯雅、仲雅、季雅。"),
        note("更倚篪音奏四聲", "齊書陸厥傳：沈約等文皆用宮商，以平上去入為四聲以制韻。"),
        note("慕寂未能捐塵拂", "南史陳顯達傳：麈尾蠅拂是王謝家物。"),
        note("凌寒何事熨棋枰", "世說：劉真長見王丞相導時大熱，丞相以腹熨石棋枰局。"),
        note("阿連更借幽心句", "南史謝惠連傳：兄靈運夢見惠連，即得池塘生春草之句。")
      ]
    }
  ),
  poem(
    ["花影花香攪睡情，", "香融繡被夾羅輕。", "楚雲入夢渾迷曉，", "蜀酒禁愁誤達晨。", "曲曲銀屏低拂燕，", "層層珠箔畧聞鶯。", "遊人竊探棲鴛去，", "刻向琅玕記我曾。"],
    [26, 27],
    {
      title: "有所窺",
      form: "七言律詩",
      notes: [
        note("題注", "自注：春日訪無因，尚在內寢，侍兒囑勿喚，因留八句。"),
        note("楚雲入夢渾迷曉", "張謂詩：紅粉青蛾映楚雲。"),
        note("曲曲銀屏低拂燕", "金幼孜詞：瓊樓層層十二敞銀屏。"),
        note("層層珠箔畧聞鶯", "郭珏詩：美人當窗捲珠箔。"),
        note("琅玕", "一作闌干。")
      ]
    }
  ),
  poem(
    ["一寸心期百尺樓，", "明河界作兩邊秋。", "移開月扇朝雲出，", "掩過銀屏夜月收。", "鬢態易迷花影亂，", "衣香暗接水光浮。", "殘陽沒後寒燈小，", "各自垂簾背面愁。"],
    [27],
    {
      title: "賦得隔水樓臺",
      form: "七言律詩",
      notes: [
        note("百尺樓", "晉書樂志：百尺高樓與天通。"),
        note("明河", "唐宋之問有明河篇。"),
        note("月扇", "李商隱詩：月扇未障羞。"),
        note("銀屏", "韋莊詩：覺來紅燭隔銀屏。"),
        note("鬢態", "溫庭筠詩：鬢態伴愁來。"),
        note("衣香", "庾信春賦：屋裏衣香不如花。"),
        note("水光", "一作煙。"),
        note("背面愁", "李商隱詩：背面秋千下。")
      ]
    }
  ),
  poem(
    ["睡起即尊前，", "前墀霽魄圓。", "晚花疎更好，", "秋鳥靜堪憐。", "風露當歌落，", "星河向酒懸。", "宿酲猶未解，", "於此復陶然。"],
    [27],
    {
      title: "睡起",
      form: "五言律詩",
      notes: [
        note("宿酲", "說文：酲，酒病也。"),
        note("陶然", "晉書劉伶傳：飲酒食肉，陶然自樂。")
      ]
    }
  )
];

const tail = document.entries.filter(item => item.source_pages.every(page => page > 27));
document.entries = [...prefix, ...reviewed, ...tail].map((item, index) => ({
  ...item,
  id: `entry-${String(index + 1).padStart(4, "0")}`,
  heading_level: item.heading_level || null,
  series: item.series || null
}));
document.issues = document.issues.filter(issue => ![
  "issue-0021", "issue-0025", "issue-0027", "issue-0028", "issue-0029", "issue-0030"
].includes(issue.id));
document.review = {
  ...document.review,
  updated_at: new Date().toISOString(),
  revisions: [
    ...(document.review?.revisions || []),
    { basis: revisionKey, reviewed_pages: [22, 23, 24, 25, 26, 27] }
  ]
};

const backupDirectory = path.join(path.dirname(target), "backups");
await fs.mkdir(backupDirectory, { recursive: true });
const backup = path.join(backupDirectory, "structured-before-20260902-round2.json");
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
  note: "Codex 疑雨集电子书第二轮校订" });
console.log(`Updated ${target}: ${document.entries.length} entries`);
console.log(`Backup ${backup}`);
