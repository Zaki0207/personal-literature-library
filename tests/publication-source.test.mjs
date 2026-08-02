import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicationSource } from "../lib/publication-source.mjs";

test("会议全称、简称、年份和展示属性统一为简写格式", () => {
  assert.equal(
    normalizePublicationSource(
      "2025 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)",
      "2025-06-12",
    ),
    "CVPR 2025",
  );
  assert.equal(
    normalizePublicationSource("CVPR 2025（Oral）", "2025-06"),
    "CVPR 2025 (Oral)",
  );
  assert.equal(
    normalizePublicationSource(
      "2023 IEEE/CVF International Conference on Computer Vision (ICCV)",
      "2023-10-01",
    ),
    "ICCV 2023",
  );
});

test("期刊和 SIGGRAPH 联合出处保留必要信息但统一位置", () => {
  assert.equal(
    normalizePublicationSource("ACM TOG（SIGGRAPH 2023）", "2023-07"),
    "ACM TOG 2023 (SIGGRAPH)",
  );
  assert.equal(
    normalizePublicationSource(
      "ACM TOG（SIGGRAPH Asia 2023）",
      "2023-12",
    ),
    "ACM TOG 2023 (SIGGRAPH Asia)",
  );
  assert.equal(
    normalizePublicationSource(
      "Proceedings of the ACM on Computer Graphics and Interactive Techniques",
      "2025",
    ),
    "PACM CGIT 2025",
  );
});

test("仅有出版社时可从明确的论文集标题恢复出处，未知来源不臆造简称", () => {
  assert.equal(
    normalizePublicationSource("Association for Computing Machinery", "2024", {
      title: "SIGGRAPH Asia 2024 Conference Papers",
    }),
    "SIGGRAPH Asia 2024",
  );
  assert.equal(
    normalizePublicationSource("Association for Computing Machinery", "2024", {
      title: "An Unrelated Paper",
    }),
    "",
  );
  assert.equal(
    normalizePublicationSource("Journal of Unmapped Research", "2025"),
    "Journal of Unmapped Research",
  );
});

test("预印本只保留 arXiv 和年份，不把编号误当年份", () => {
  assert.equal(
    normalizePublicationSource("arXiv 2509.21751", "2025-09-25"),
    "arXiv 2025",
  );
});
