import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../ui/chat.js", import.meta.url), "utf8");
const consumer = source.slice(source.indexOf("      function consume(frame)"), source.indexOf("      while (!done)"));
function fixture() {
  const answer = { content: "" }, output = { textContent: "" };
  const view = { scrollHeight: 100, scrollTop: 0, clientHeight: 100 };
  const use = new Function("answer", "output", "$", "window", 'var done = false; var processing = {feed: function () {}};\n' + consumer + '\nreturn {consume, done:()=>done};')(answer, output, () => view, { SwarmletMarkdown: { render: (target: typeof output, text: string) => { target.textContent = text; } } });
  return { ...use, answer, output };
}
test("chat forwards accumulated Markdown to the renderer, accepts CRLF and recognizes terminal SSE marker", () => {
  const f = fixture();
  f.consume('data: {"choices":[{"delta":{"content":"<script>Živjo</script>"}}]}\r\n');
  expect(f.answer.content).toBe("<script>Živjo</script>");
  expect(f.output.textContent).toBe(f.answer.content);
  f.consume('data: {"choices":[{"delta":{"content":"\\n**bold**"}}]}');
  expect(f.output.textContent).toBe('<script>Živjo</script>\n**bold**');
  f.consume('data: [DONE]'); expect(f.done()).toBe(true);
});
test("chat exposes upstream SSE errors and does not turn reasoning into answer text", () => {
  const f = fixture();
  f.consume('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}');
  expect(f.answer.content).toBe("");
  expect(() => f.consume('data: {"error":{"message":"context full"}}')).toThrow("context full");
  expect(f.done()).toBe(false);
});

for (const outcome of ['success', 'failure']) test(`late catalog ${outcome} cannot release active chat ownership`, async () => {
  const load = source.slice(source.indexOf('  async function loadModels()'), source.indexOf('  async function send(ev)'));
  let complete!: (response: Response) => void, fail!: (error: Error) => void;
  const pending = new Promise<Response>((resolve, reject) => { complete = resolve; fail = reject; });
  const elements = { 'tab-chat': { hidden: false }, 'chat-model': { value: 'current', replaceChildren() {}, appendChild() {} }, 'chat-route': { textContent: 'active' } };
  const run = new Function('fetch', 'els', `var busy=false,loading=false,saved={},catalog=[];var D={hidden:false,createElement:()=>({})};var $=id=>els[id];function error(){}function example(){}function setBusy(v){busy=v;}${load};return {loadModels,start:()=>{busy=true},isBusy:()=>busy};`)(() => pending, elements);
  const work = run.loadModels(); run.start();
  if (outcome === 'success') complete(Response.json({ data: [{ id: 'other' }] })); else fail(new Error('network failed'));
  await work;
  expect(run.isBusy()).toBe(true); expect(elements['chat-model'].value).toBe('current'); expect(elements['chat-route'].textContent).toBe('active');
});
