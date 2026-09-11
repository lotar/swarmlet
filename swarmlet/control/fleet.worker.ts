import { previewFleet } from './fleet.ts';
self.onmessage = event => {
  try { self.postMessage({ result: previewFleet(event.data.request, event.data.input) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
