function median(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function orderRegionsByVerticalColumns(regions, columnDirection = "ltr") {
  if (!['ltr', 'rtl'].includes(columnDirection)) throw new Error("columnDirection must be ltr or rtl");
  const items = regions.map((region, index) => {
    const [x = 0, y = 0, width = 1, height = 1] = region.bbox || [];
    return { region, rawIndex: index, x, y, width, height, cx: x + width / 2 };
  });
  const threshold = Math.max(24, median(items.map((item) => item.width)) * 0.65);
  const columns = [];
  const byX = [...items].sort((left, right) => columnDirection === "ltr" ? left.cx - right.cx : right.cx - left.cx);

  for (const item of byX) {
    let selected = null;
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (const column of columns) {
      const distance = Math.abs(column.center - item.cx);
      const localThreshold = Math.max(threshold, Math.min(column.width, item.width) * 0.8);
      if (distance <= localThreshold && distance < selectedDistance) {
        selected = column;
        selectedDistance = distance;
      }
    }
    if (!selected) {
      columns.push({ center: item.cx, width: item.width, weight: 1, items: [item] });
      continue;
    }
    selected.items.push(item);
    selected.center = (selected.center * selected.weight + item.cx) / (selected.weight + 1);
    selected.width = Math.max(selected.width, item.width);
    selected.weight += 1;
  }

  columns.sort((left, right) => columnDirection === "ltr" ? left.center - right.center : right.center - left.center);
  return columns.flatMap((column) => [...column.items]
    .sort((left, right) => left.y - right.y || left.x - right.x || left.rawIndex - right.rawIndex))
    .map((item, index) => ({
      ...structuredClone(item.region),
      order: index + 1,
      source: {
        ...(item.region.source || {}),
        raw_order: item.region.order,
        reading_order: `vertical-columns-${columnDirection}-v1`
      }
    }));
}
