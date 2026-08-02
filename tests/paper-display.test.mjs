import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAuthorsForDisplay,
  formatInstitutionForDisplay,
  formatPublicationForDisplay,
} from "../lib/paper-display.mjs";

test("作者最多显示前三位，其余统一显示为等", () => {
  assert.equal(
    formatAuthorsForDisplay(
      "Feng Wang; Sinan Tan; Xinghang Li; Zeyue Tian; Yafei Song; Huaping Liu",
    ),
    "Feng Wang、Sinan Tan、Xinghang Li 等",
  );
  assert.equal(
    formatAuthorsForDisplay("Yue Gao、Hong-Xing Yu、Bo Zhu、Jiajun Wu"),
    "Yue Gao、Hong-Xing Yu、Bo Zhu 等",
  );
  assert.equal(formatAuthorsForDisplay("Guanjun Wu 等 9 位"), "Guanjun Wu 等");
  assert.equal(
    formatAuthorsForDisplay("Alice Example; Bob Example; Carol Example"),
    "Alice Example、Bob Example、Carol Example",
  );
});

test("机构只显示第一所顶层机构并去掉院系和实验室层级", () => {
  assert.equal(
    formatInstitutionForDisplay(
      "Tsinghua University,Beijing National Research Center for Information Science and Technology(BNRist),Department of Computer Science and Technology; Hong Kong University of Science and Technology; Alibaba Group,XR Lab, DAMO Academy",
    ),
    "Tsinghua University",
  );
  assert.equal(
    formatInstitutionForDisplay(
      "Department of Computer Science and Technology, Tsinghua University, BNRist",
    ),
    "Tsinghua University",
  );
  assert.equal(
    formatInstitutionForDisplay("University of California, Berkeley, BAIR"),
    "UC Berkeley",
  );
  assert.equal(
    formatInstitutionForDisplay("华中科技大学、Huawei、Technical University of Munich"),
    "华中科技大学",
  );
});

test("出处已有年份时不重复展示日期，缺少年份时仅补年份", () => {
  assert.equal(
    formatPublicationForDisplay("ICCV 2023", "2023-10-01"),
    "ICCV 2023",
  );
  assert.equal(
    formatPublicationForDisplay("CVPR 2025 (Oral)", "2025-06"),
    "CVPR 2025 (Oral)",
  );
  assert.equal(
    formatPublicationForDisplay("arXiv · cs.CV", "2026-07-28"),
    "arXiv · cs.CV · 2026",
  );
});
