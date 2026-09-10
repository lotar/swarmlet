# Embedded Markdown dependencies

Served locally inside the compiled agents and controller; no CDN requests.

- marked 18.0.12: https://registry.npmjs.org/marked/-/marked-18.0.12.tgz
  - npm archive integrity: `sha512-LEm4ga2YeI2T3GVHj9b0BaDPPk93LLTHMFeMyQbNIzPxc8vCI0y/scy0ZA6z6lXKyT9j9Nhl/OC6ZYKYGuFScA==`
- dompurify 3.4.15: https://registry.npmjs.org/dompurify/-/dompurify-3.4.15.tgz
  - npm archive integrity: `sha512-EUBjM+B+lkDE41iE82DDSCfkoPGfXx8IxFxPMjNzm/Uk4xDet77rTN9wqlxlVg71kK7XGuUMv6wUxJUwwv+Xyw==`

Upstream distribution bytes and license files are preserved. Marked parses GFM; DOMPurify sanitizes before insertion. The shared adapter escapes raw HTML, permits Markdown elements only, and presents images as explicit links. See https://marked.js.org/ and https://github.com/cure53/DOMPurify.
