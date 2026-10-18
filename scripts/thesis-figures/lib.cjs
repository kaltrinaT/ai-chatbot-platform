/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS figure helpers. */
// Shared drawing helpers for the chapter 4 thesis figures (fig-4-1 … fig-4-5).
//
// Every figure is drawn on the same 720-unit-wide canvas with the same type
// sizes, so that scaled to a page's text width (about 16 cm) they all print at
// one size: body text near 8 pt, titles near 9.5 pt. Each figure is written to
// docs/figures/thesis/ as SVG (for LaTeX or editing), PNG (for Word) and PDF
// (vector, for LaTeX). The PDF is printed by a local Edge or Chrome in headless
// mode; without either, the PDF is skipped and said so.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');

const W = 720;
const OUT = 'docs/figures/thesis';

const C = {
  ink:'#16181d', sec:'#3d4350', mut:'#5b6270', faint:'#9aa0aa', line:'#2f343d',
  warn:'#a13b12', aws:'#b4540a', az:'#1f5fae',
  cust:'#146b58', custTint:'#e9f3ef',
  cp:'#3d4350', cpTint:'#eef1f6',
  gh:'#8a8778', ghTint:'#f5f4ef',
  ext:'#5b6270',
};
const F = {title:14, body:12.5, small:12, group:12.5};

const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function figure(){
  const under = [], body = [];
  const add = s => body.push(s);

  // A halo is a white-stroked copy drawn underneath, so a label can sit on a
  // line and stay legible. Not paint-order: Word's SVG renderer may ignore it.
  const text = (x, y, s, {size = F.body, fill = C.ink, weight, anchor, halo, italic, to = body} = {}) => {
    const attrs = `x="${x}" y="${y}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}${italic ? ' font-style="italic"' : ''}`;
    to.push(`${halo ? `<text ${attrs} fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round">${esc(s)}</text>` : ''}<text ${attrs} fill="${fill}">${esc(s)}</text>`);
  };

  // A region: a tinted rounded rectangle with its name in small capitals.
  // nameAt 'bottom' keeps the top edge free for arrows entering the group.
  const group = (x, y, w, h, name, {fill, stroke, nameFill, sub, dash, nameAt = 'top'} = {}) => {
    under.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.4"${dash ? ' stroke-dasharray="6 4"' : ''}/>`);
    const ny = nameAt === 'bottom' ? y + h - (sub ? 27 : 12) : y + 20;
    text(x + 12, ny, name, {size:F.group, weight:'bold', fill:nameFill ?? stroke, to:under});
    if(sub) text(x + 12, ny + 15, sub, {size:F.small, fill:C.mut, to:under});
  };

  // A component. Title centred, detail lines centred beneath it; the height
  // follows the number of lines unless one is given.
  const node = (x, y, w, title, lines = [], {fill = '#ffffff', stroke = C.sec, dash, h, titleFill = C.ink, lineFill = C.mut, align = 'middle'} = {}) => {
    const auto = lines.length ? 38 + (lines.length - 1) * 15 + 11 : 36;
    const hh = h ?? auto;
    body.push(`<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="1.3"${dash ? ' stroke-dasharray="5 3.5"' : ''}/>`);
    const cx = align === 'middle' ? x + w / 2 : x + 12;
    // Vertically centre the block when a fixed height leaves room.
    const off = (hh - auto) / 2;
    text(cx, y + off + (lines.length ? 21 : 23), title, {size:F.title, weight:'bold', fill:titleFill, anchor:align});
    lines.forEach((l, i) => {
      const [s, o] = Array.isArray(l) ? l : [l, {}];
      text(cx, y + off + 38 + i * 15, s, {size:F.body, fill:lineFill, anchor:align, ...o});
    });
    return {x, y, w, h:hh, cx:x + w / 2, cy:y + hh / 2, r:x + w, b:y + hh};
  };

  // A small rounded chip naming one service, used inside a cloud group.
  const chip = (x, y, w, label, {fill = '#ffffff', stroke = C.cust, dash} = {}) => {
    body.push(`<rect x="${x}" y="${y}" width="${w}" height="28" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.1"${dash ? ' stroke-dasharray="4 3"' : ''}/>`);
    text(x + w / 2, y + 18.5, label, {size:F.small, fill:C.ink, anchor:'middle'});
  };

  // kind: flow (solid) · reply (dashed, open head) · content (thick, the
  // customer's colour: document bytes) · refused (dashed, red) · link (thin
  // grey, no head)
  const arrow = (points, kind = 'flow') => {
    const pts = points.map(p => p.join(',')).join(' ');
    const style = {
      flow: `stroke="${C.line}" stroke-width="1.5" marker-end="url(#m-flow)"`,
      reply: `stroke="${C.line}" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#m-open)"`,
      content: `stroke="${C.cust}" stroke-width="3.4" marker-end="url(#m-content)"`,
      refused: `stroke="${C.warn}" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#m-refused)"`,
      link: `stroke="${C.faint}" stroke-width="1.2" stroke-dasharray="2 3"`,
    }[kind];
    body.push(`<polyline points="${pts}" fill="none" stroke-linejoin="round" ${style}/>`);
  };
  const label = (x, y, s, o = {}) => text(x, y, s, {size:F.small, halo:true, ...o});

  // A numbered step marker.
  const badge = (x, y, n, {fill = C.sec, r = 10} = {}) => {
    body.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#ffffff" stroke-width="1.6"/>`);
    text(x, y + 4.2, String(n), {size:String(n).length > 1 ? 10.5 : 12, weight:'bold', fill:'#ffffff', anchor:'middle'});
  };

  // A row of legend entries at baseline y, starting at x.
  const legend = (y, items, x = 20) => {
    for(const [kind, name] of items){
      if(kind === 'box-dash'){
        body.push(`<rect x="${x}" y="${y - 12}" width="34" height="16" rx="3" fill="#ffffff" stroke="${C.ext}" stroke-width="1.2" stroke-dasharray="5 3.5"/>`);
      }else if(kind === 'badge'){
        badge(x + 17, y - 4, 'n');
      }else{
        arrow([[x, y - 4], [x + 34, y - 4]], kind);
      }
      text(x + 42, y, name, {size:F.small, fill:C.sec});
      x += 42 + name.length * 6.2 + 24;
    }
  };

  const svg = (H, aria) => {
    const marker = (id, color, open, size = 7) => `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${size}" markerHeight="${size}" orient="auto">${open
      ? `<path d="M1,1 L9.5,5 L1,9" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
      : `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/>`}</marker>`;
    const defs = [
      marker('m-flow', C.line, false),
      marker('m-open', C.line, true),
      marker('m-refused', C.warn, false),
      // Sized in user space; scaled by the thick stroke it would swamp its label.
      `<marker id="m-content" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.cust}"/></marker>`,
    ].join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <defs>${defs}</defs>
  <g font-family="Arial, Helvetica, sans-serif">${under.join('')}${body.join('')}</g>
</svg>
`;
  };

  return {add, text, group, node, chip, arrow, label, badge, legend, svg};
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function printPdf(svg, H, pdfPath){
  const browser = BROWSERS.find(p => fs.existsSync(p));
  if(!browser){
    console.warn(`  no Edge or Chrome found: ${pdfPath} skipped`);
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thesis-fig-'));
  try{
    const html = path.join(dir, 'page.html');
    // One page exactly the figure's size, so the PDF has no margins to crop.
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0;padding:0;width:${W}px;height:${H}px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`);
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      `--print-to-pdf=${path.resolve(pdfPath)}`,
      pathToFileURL(html).href,
    ], {stdio:'ignore', timeout:60_000});
    return fs.existsSync(pdfPath);
  }finally{
    fs.rmSync(dir, {recursive:true, force:true});
  }
}

async function render(name, svg, H){
  fs.mkdirSync(OUT, {recursive:true});
  const base = `${OUT}/${name}`;
  fs.writeFileSync(`${base}.svg`, svg);
  // 288 dpi against the SVG's 72: 2880 px wide, about 450 dpi at 16 cm.
  await sharp(Buffer.from(svg), {density:288}).png().toFile(`${base}.png`);
  const pdf = printPdf(svg, H, `${base}.pdf`);
  console.log(`Wrote ${base}.svg, .png${pdf ? ', .pdf' : ''} (${W}×${H})`);
}

module.exports = {W, C, F, figure, render};
