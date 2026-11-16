/**
 * Regenerates the canvas label font (MSDF atlas used by utils/FastLabelRenderer.ts):
 * ASCII, Latin-1 (accented letters, ç, º, ª…) and a few symbols labels use.
 * Same size, padding and distance range as the original ASCII atlas, so glyph
 * metrics are unchanged.
 *
 *   node src/assets/fonts/gen-label-font.cjs src/assets/fonts   (from frontend/)
 */
const generateBMFont = require('msdf-bmfont-xml');
const fs = require('fs');
const out = process.argv[2];
const TTF = require('path').join(__dirname, 'Roboto-Regular.ttf');
let charset = '';
for (let c = 32; c <= 126; c++) charset += String.fromCharCode(c);
for (let c = 0xa1; c <= 0xff; c++) charset += String.fromCharCode(c);
charset += '·×–—…‘’“”•≤≥≠€∑';
// Keep only what the font has: a missing glyph would be drawn as an empty box
// instead of falling back to '?' (FastLabelRenderer resolveCharData).
const font = require('opentype.js').loadSync(TTF);
charset = [...charset].filter((ch) => font.charToGlyph(ch).index !== 0).join('');
generateBMFont(TTF, {
  outputType: 'json', fontSize: 48, distanceRange: 8, fieldType: 'msdf', texturePadding: 4, charset, smartSize: true, pot: false, square: false, textureSize: [1024, 1024],
}, (err, textures, font) => {
  if (err) throw err;
  if (textures.length !== 1) throw new Error('pages: ' + textures.length);
  fs.writeFileSync(out + '/roboto-msdf.png', textures[0].texture);
  const data = JSON.parse(font.data);
  data.pages = ['roboto-msdf.png'];
  fs.writeFileSync(out + '/Roboto-Regular.json', JSON.stringify(data));
  console.log(data.chars.length, data.common);
});
