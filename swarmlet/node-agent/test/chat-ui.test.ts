import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../ui/chat.js", import.meta.url), "utf8");
const consumer = source.slice(source.indexOf("      function consume(frame)"), source.indexOf("      while (!done)"));
function fixture() {
  const answer = { content: "" }, output = { textContent: "" };
  const view = { scrollHeight: 100, scrollTop: 0, clientHeight: 100 };
  const use = new Function("answer", "output", "$", 'var done = false; var processing = {feed: function () {}};\n' + consumer + '\nreturn {consume, done:()=>done};')(answer, output, () => view);
  return { ...use, answer, output };
}
test("chat safely appends content, accepts CRLF and recognizes terminal SSE marker", () => {
  const f = fixture();
  f.consume('data: {"choices":[{"delta":{"content":"<script>Živjo</script>"}}]}\r\n');
  expect(f.answer.content).toBe("<script>Živjo</script>");
  expect(f.output.textContent).toBe(f.answer.content);
  f.consume('data: [DONE]'); expect(f.done()).toBe(true);
});
test("chat exposes upstream SSE errors and does not turn reasoning into answer text", () => {
  const f = fixture();
  f.consume('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}');
  expect(f.answer.content).toBe("");
  expect(() => f.consume('data: {"error":{"message":"context full"}}')).toThrow("context full");
  expect(f.done()).toBe(false);
});
