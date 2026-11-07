import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShellOutputDecoder,
  decodeShellOutput,
  type ShellOutputDecoder,
} from "./commandRunner.js";

// Regression guard for the Windows gateway crash of 2026-11-05, documented in
// docs/HANDOFF-Windows-20261105.md section 2.3. The decoder ran TextDecoder in
// fatal mode, so once a stream had been classified as UTF-8, any later chunk
// holding a non-UTF-8 byte threw ERR_ENCODING_INVALID_ENCODED_DATA out of the
// stdout data handler as an uncaughtException and took the whole gateway down,
// dropping every live WebSocket. The real production stack was:
//
//   uncaughtException: TypeError: The encoded data was not valid for encoding utf-8
//     at TextDecoder.decode (node:internal/encoding:464:14)
//     at Object.decode (.../src/tool/builtin/bash/commandRunner.ts:217:28)
//     at Socket.<anonymous> (.../commandRunner.ts:129:36)
//     code: 'ERR_ENCODING_INVALID_ENCODED_DATA'
//
// Encoding is chosen by inspectUtf8() over raw bytes, so fatal mode was never
// needed: undecodable bytes must degrade instead of killing the process.

const collect = (decoder: ShellOutputDecoder, chunks: Buffer[]): string =>
  chunks.map((chunk) => decoder.decode(chunk)).join("") + decoder.flush();

const utf8 = (value: string) => Buffer.from(value, "utf8");

test("a stream classified as UTF-8 survives a later non-UTF-8 chunk", () => {
  // First chunk is valid non-ASCII UTF-8, which pins mode to "utf8". This is the
  // exact transition that used to make the following chunk fatal.
  const chunks = [utf8("中文输出"), Buffer.from([0x81, 0x40, 0xff, 0xfe]), utf8("tail")];
  const decoder = createShellOutputDecoder();
  let text = "";
  assert.doesNotThrow(() => {
    text = collect(decoder, chunks);
  }, "mixed GBK/UTF-8 output must not throw out of decode()");
  assert.ok(text.includes("中文输出"), `head lost: ${JSON.stringify(text)}`);
  assert.ok(text.includes("tail"), `tail lost: ${JSON.stringify(text)}`);
});

test("flush after a corrupt chunk does not throw either", () => {
  const decoder = createShellOutputDecoder();
  decoder.decode(utf8("进度"));
  decoder.decode(Buffer.from([0xc3, 0x28]));
  assert.doesNotThrow(() => decoder.flush());
});

test("decodeShellOutput tolerates a UTF-8 header followed by binary noise", () => {
  const payload = Buffer.concat([utf8("result=ok 数据"), Buffer.from([0x00, 0xff, 0xfe, 0x0a])]);
  let out = "";
  assert.doesNotThrow(() => {
    out = decodeShellOutput(payload);
  });
  assert.ok(out.includes("result=ok"), `ASCII lost: ${JSON.stringify(out)}`);
});

test("pure UTF-8 output is decoded exactly, with no replacement characters", () => {
  const text = collect(createShellOutputDecoder(), [utf8("构建成功 "), utf8("1024 tests")]);
  assert.equal(text, "构建成功 1024 tests");
});

test("pure ASCII output is decoded exactly", () => {
  const text = collect(createShellOutputDecoder(), [utf8("hello "), utf8("world")]);
  assert.equal(text, "hello world");
});

test("a multibyte character split across chunks is reassembled", () => {
  const bytes = utf8("中 test");
  const text = collect(createShellOutputDecoder(), [bytes.subarray(0, 1), bytes.subarray(1)]);
  assert.equal(text, "中 test");
});