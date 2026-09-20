export const REVISION_PRESETS = Object.freeze([
  {
    id: "boundaries",
    label: "边界与跨页",
    summary: "复核作品拆合、前后页续接和漏诗重诗",
    prompt: "请重点复核作品边界与跨页续接。先按古籍竖排从右到左、每栏从上到下恢复阅读顺序，再结合题名字号与位置、五七言句式、绝句或律诗句数、押韵以及注文归属，检查是否存在两首误合、一首误拆、前作末句并入后作、后作首句并入前作、跨页续文遗漏或重复。前后页只作为边界证据，不得把上下文页独有正文写入目标范围；不得用注文引诗凑足诗句。无法确认的边界保留原文并写入 issues，不猜补、不改写。"
  },
  {
    id: "lines",
    label: "分句与句读",
    summary: "复核逐句切分、次序、标点和体裁线索",
    prompt: "请重点复核诗词正文的分句、次序与现代句读。lines 的每个数组元素只能保存一个完整诗句，不得把两句、四句或整首粘在一项中，也不得把一个完整诗句拆碎；五言、七言近体诗按句式逐句保存，词曲按词牌或曲牌分句并保留分阕。结合版面、字数、句数与押韵复核 form，但不得为了符合体裁而补造、复制或挪用文字。除标点和空白外必须保持原文字序列不变，疑字和缺字按证据保留或写入 issues。"
  },
  {
    id: "titles-series",
    label: "标题与组诗",
    summary: "复核题名、长题、目录层级和组诗关系",
    prompt: "请重点复核题名、目录标题与组诗结构。根据字号、栏位、题名位置及其统辖范围判断 title，禁止把正文首句当题名，也不得把题旁小字说明并入标题；长题按完整句意添加现代标点。卷名、年次和小目录使用 kind=heading 与正确 heading_level，不得误作诗题。组诗必须一首一个 poem，共用 series.title，series.index 连续递增，可确认时填写 series.total；除原书另有子题外，各首 title 留空，不得把总题复制到每首或把“其一、其二”写进题名。无法确认时写入 issues。"
  },
  {
    id: "notes",
    label: "注文与锚点",
    summary: "复核注文文字、归属、拆合和精确 offset",
    prompt: "请重点复核注文内容、所属作品与精确锚点。小字注文不得混入 title 或 lines，注文中的引诗也不得当作正文；每条注文应紧随其所属单诗，不得汇总到组末或挂到相邻作品。根据注文引文和原版小字位置设置 position：诗句使用 field=lines、从 1 开始的 line 和被注词语后的 Unicode 字符 offset，题下注使用 field=title，组题下注使用 field=series；不得机械挂在句末。同一句不同词语的注文分别定位，解释多个位置的注文按语义合理拆分。notes[].text 只调整标点、书名号和空白，不得增删改原文字词。"
  }
]);

export function revisionPreset(id) {
  return REVISION_PRESETS.find((preset) => preset.id === id) || null;
}
