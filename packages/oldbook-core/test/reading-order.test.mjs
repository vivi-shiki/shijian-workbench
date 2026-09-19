import assert from "node:assert/strict";
import test from "node:test";
import { orderRegionsByVerticalColumns } from "../src/reading-order.mjs";

const region = (id, order, x, y) => ({ id, order, bbox: [x, y, 40, 100], source: { raw_id: order - 1 } });

test("vertical column ordering is top-to-bottom then left-to-right", () => {
  const ordered = orderRegionsByVerticalColumns([
    region("right-bottom", 1, 300, 500),
    region("left-bottom", 2, 100, 500),
    region("right-top", 3, 302, 100),
    region("left-top", 4, 98, 100)
  ], "ltr");
  assert.deepEqual(ordered.map((item) => item.id), ["left-top", "left-bottom", "right-top", "right-bottom"]);
  assert.deepEqual(ordered.map((item) => item.order), [1, 2, 3, 4]);
  assert.deepEqual(ordered.map((item) => item.source.raw_order), [4, 2, 3, 1]);
});

test("right-to-left uses the same within-column order", () => {
  const ordered = orderRegionsByVerticalColumns([
    region("left", 1, 100, 100),
    region("right-bottom", 2, 300, 300),
    region("right-top", 3, 300, 100)
  ], "rtl");
  assert.deepEqual(ordered.map((item) => item.id), ["right-top", "right-bottom", "left"]);
});
