const scriptEscapes = Object.freeze({
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});

export function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, char => scriptEscapes[char]);
}
