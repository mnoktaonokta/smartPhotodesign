import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlotHistory } from "../../web/js/history.js";

function photo(params = {}) {
  return {
    params: { exposure: 0, ...params },
    geometry: { zoom: 1, angle: 0, quarter: 0, cx: 0.5, cy: 0.5 },
    masks: [],
    selectedMask: -1,
    showMask: false,
    match: null,
    pixels: null,
  };
}

describe("SlotHistory", () => {
  it("keeps before and after undo stacks independent", () => {
    const history = new SlotHistory();
    const before = photo({ exposure: 0 });
    const after = photo({ exposure: 0 });

    history.push("before", before);
    before.params.exposure = 1;
    history.push("after", after);
    after.params.exposure = 2;

    assert.equal(history.canUndo("before"), true);
    assert.equal(history.canUndo("after"), true);

    assert.equal(history.undo("before", before), true);
    assert.equal(before.params.exposure, 0);
    assert.equal(after.params.exposure, 2);

    assert.equal(history.undo("after", after), true);
    assert.equal(after.params.exposure, 0);
    assert.equal(before.params.exposure, 0);
  });

  it("clear(slot) only resets that slot", () => {
    const history = new SlotHistory();
    const before = photo();
    const after = photo();
    history.push("before", before);
    history.push("after", after);
    history.clear("before");
    assert.equal(history.canUndo("before"), false);
    assert.equal(history.canUndo("after"), true);
  });
});
