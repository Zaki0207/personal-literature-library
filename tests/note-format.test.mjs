import assert from "node:assert/strict";
import test from "node:test";
import { noteRuns } from "../lib/note-format.mjs";

test("bold notes preserve line breaks, Unicode and literal HTML", () => {
  assert.deepEqual(noteRuns("第一行 **重点**\n\n<script>literal</script>"), [
    { text: "第一行 ", bold: false }, { text: "重点", bold: true }, { text: "\n\n<script>literal</script>", bold: false },
  ]);
  assert.deepEqual(noteRuns("unmatched ** stars"), [{ text: "unmatched ** stars", bold: false }]);
  assert.deepEqual(noteRuns("**多行\n重点**"), [{ text: "多行\n重点", bold: true }]);
});
