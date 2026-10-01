import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHostname,
  createPublicNetworkFetch,
  isPrivateOrReservedAddress,
} from "../scripts/network-safety.mjs";

test("本机、局域网和保留地址都不能作为远程抓取目标", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedAddress(address), true, address);
  }
  assert.equal(isPrivateOrReservedAddress("1.1.1.1"), false);
  assert.equal(isPrivateOrReservedAddress("2606:4700:4700::1111"), false);
});

test("域名解析到内网地址时，在发出网络请求前拒绝访问", async () => {
  let fetchCalls = 0;
  const guardedFetch = createPublicNetworkFetch(
    async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
    {
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  );

  await assert.rejects(
    guardedFetch("https://papers.example/article"),
    (error) => error?.code === "REMOTE_ADDRESS_NOT_ALLOWED",
  );
  assert.equal(fetchCalls, 0);
});

test("域名所有解析结果均为公网地址时允许继续请求", async () => {
  const lookups = [];
  await assertPublicHostname("papers.example", {
    lookupImpl: async (hostname, options) => {
      lookups.push({ hostname, options });
      return [
        { address: "1.1.1.1", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ];
    },
  });
  assert.deepEqual(lookups, [
    {
      hostname: "papers.example",
      options: { all: true, verbatim: true },
    },
  ]);
});
