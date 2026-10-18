/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evaluation script. */
// Thesis figure for the infrastructure scan in the security evaluation:
//
//   fig-30-checkov-themes   every failed Checkov check, grouped by theme and by
//                           where in the system it was found
//
//   node scripts/plot-checkov-themes.cjs
//
// Reads docs/evaluation/security/checkov.json (written by evaluate-security.cjs).
// Checkov's open-source rules carry no severity, so the figure counts checks; it
// does not rank risk. The theme of each check ID is the author's classification
// and is written out below in full, so it can be audited. A check ID or a file
// this script has never seen stops it rather than being dropped from the totals.
const fs = require('node:fs');
const sharp = require('sharp');

const out = 'docs/figures';
const runs = JSON.parse(fs.readFileSync('docs/evaluation/security/checkov.json','utf8'));
const scans = Array.isArray(runs) ? runs : [runs];

const ink = {primary:'#16181d', secondary:'#3d4350', muted:'#5b6270', faint:'#898781', rule:'#e1e0d9', axis:'#c3c2b7'};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text = (x, y, s, {size = 12, fill = ink.primary, weight, anchor} = {}) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
function wrap(s, max){ const lines = []; let line = ''; for(const word of String(s).split(' ')){ if(line && (line + ' ' + word).length > max){ lines.push(line); line = word; } else line = line ? `${line} ${word}` : word; } if(line) lines.push(line); return lines; }
const swatch = (x, y, fill, size = 12) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${fill}"/>`;
function svg(width, height, label, body){
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}">\n  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>\n  <g font-family="Arial, Helvetica, sans-serif">${body}</g>\n</svg>\n`;
}

// Where a finding lives. AWS blue and Azure orange as in fig-15 to fig-18; the
// platform takes the gray fig-28 uses for the platform's own steps.
const places = [
  {key:'aws',      label:'AWS customer account',      detail:'tenant Terraform, CloudFormation bootstrap', fill:'#2a78d6', text:'#ffffff', files:[/^\/infra\/terraform\/main\.tf$/, /^\/infra\/bootstrap\/aws\//]},
  {key:'azure',    label:'Azure customer subscription', detail:'tenant Terraform, ARM bootstrap',          fill:'#eb6834', text:'#ffffff', files:[/^\/infra\/terraform\/azure\//, /^\/infra\/bootstrap\/azure\//]},
  {key:'platform', label:'Platform',                    detail:'template bucket Terraform, workflows',     fill:'#8f8d86', text:'#ffffff', files:[/^\/infra\/platform\//, /^\/\.github\/workflows\//]},
];
const placeOf = file => {
  const p = places.find(pl => pl.files.some(re => re.test(file)));
  if(!p) throw new Error(`fig-30: no place for scanned file ${file}`);
  return p.key;
};

const themes = [
  {key:'network',   label:'Network exposure',            note:'Public storage, registry and vault endpoints, open load-balancer rules, Postgres without a private endpoint (Known Limitation #5)',
   ids:['CKV2_AWS_12','CKV_AWS_130','CKV_AWS_260','CKV_AWS_382','CKV_AWS_333','CKV_AWS_117','CKV_AWS_258','CKV_AWS_301','CKV2_AZURE_26','CKV2_AZURE_32','CKV2_AZURE_33','CKV2_AZURE_57','CKV2_AZURE_47','CKV_AZURE_59','CKV_AZURE_139','CKV_AZURE_189','CKV_AZURE_190','CKV_AZURE_221','CKV_AZURE_109','CKV_AZURE_35','CKV_AZURE_36','CKV_AWS_54','CKV_AWS_56','CKV2_AWS_6','CKV_AZURE_237']},
  {key:'resilience',label:'Redundancy and recovery',     note:'Multi-AZ and geo-redundancy, replication, backups, deletion and purge protection',
   ids:['CKV_AWS_144','CKV_AWS_150','CKV_AWS_157','CKV_AWS_293','CKV_AWS_310','CKV2_AWS_60','CKV_AWS_116','CKV_AZURE_110','CKV_AZURE_136','CKV_AZURE_165','CKV_AZURE_206','CKV_AZURE_212','CKV_AZURE_225','CKV_AZURE_233','CKV_AZURE_42','CKV2_AZURE_38']},
  {key:'logging',   label:'Logging and monitoring',      note:'Access and flow logs, log retention, database and container monitoring, tracing',
   ids:['CKV2_AWS_11','CKV2_AWS_30','CKV2_AWS_62','CKV_AWS_118','CKV_AWS_129','CKV_AWS_18','CKV_AWS_338','CKV_AWS_353','CKV_AWS_50','CKV_AWS_65','CKV_AWS_86','CKV_AWS_91','CKV2_AZURE_21','CKV_AZURE_33']},
  {key:'secrets',   label:'Secret and key lifecycle',    note:'Key Vault secret expiry and content type, automatic rotation, shared-key and password authentication',
   ids:['CKV_AZURE_41','CKV_AZURE_114','CKV2_AWS_57','CKV2_AZURE_41','CKV2_AZURE_40','CKV_AWS_161']},
  {key:'workflows', label:'Workflow inputs and token permissions', note:'Dispatch inputs and the id-token: write permission in all six workflows; S9 tests that inputs reach scripts as data only',
   ids:['CKV_GHA_7','CKV2_GHA_1']},
  {key:'cmk',       label:'Customer-managed encryption keys', note:'KMS or customer-managed keys in place of the provider-managed encryption every store already has',
   ids:['CKV_AWS_145','CKV_AWS_149','CKV_AWS_158','CKV_AWS_173','CKV2_AZURE_1']},
  {key:'edge',      label:'Edge protection',             note:'WAF, response-header policy, geo restriction, header dropping, Lambda concurrency limit',
   ids:['CKV_AWS_68','CKV2_AWS_28','CKV2_AWS_47','CKV2_AWS_32','CKV_AWS_131','CKV_AWS_374','CKV_AWS_115']},
  {key:'transit',   label:'Encryption in transit',       note:'HTTP listener and target groups, HTTPS redirect, TLS minimums, default CloudFront certificate',
   ids:['CKV_AWS_103','CKV_AWS_174','CKV_AWS_378','CKV2_AWS_20','CKV2_AWS_42','CKV_AZURE_44']},
  {key:'hygiene',   label:'Configuration hygiene',       note:'Security-group descriptions, naming rules, zone pinning, minor upgrades, lifecycle and root object',
   ids:['CKV_AWS_23','CKV_AZURE_43','CKV_AWS_394','CKV_AWS_226','CKV2_AWS_61','CKV_AWS_305']},
  {key:'iam',       label:'Deployment-role permissions', note:'The deployment role\'s IAM breadth; its scope is documented in SECURITY.md, What the deployment role can do',
   ids:['CKV_AWS_107','CKV_AWS_108','CKV_AWS_109','CKV_AWS_110','CKV_AWS_111']},
  {key:'supply',    label:'Image supply chain',          note:'Registry image scanning, quarantine, signing and code signing, untagged-manifest retention',
   ids:['CKV_AZURE_163','CKV_AZURE_164','CKV_AZURE_166','CKV_AWS_272','CKV_AZURE_167']},
];
const themeOf = new Map();
for(const t of themes) for(const id of t.ids){
  if(themeOf.has(id)) throw new Error(`fig-30: ${id} is in two themes`);
  themeOf.set(id, t.key);
}

const counts = Object.fromEntries(themes.map(t => [t.key, Object.fromEntries(places.map(p => [p.key, 0]))]));
let failed = 0, passed = 0;
for(const scan of scans){
  passed += scan.summary.passed;
  for(const f of scan.results.failed_checks){
    const t = themeOf.get(f.check_id);
    if(!t) throw new Error(`fig-30: no theme for ${f.check_id} (${f.check_name})`);
    counts[t][placeOf(f.file_path)]++;
    failed++;
  }
}
const totalOf = key => places.reduce((s, p) => s + counts[key][p.key], 0);
const sorted = [...themes].sort((a, b) => totalOf(b.key) - totalOf(a.key));
if(sorted.reduce((s, t) => s + totalOf(t.key), 0) !== failed) throw new Error('fig-30: theme totals do not add up to the failed checks');
const byPlace = Object.fromEntries(places.map(p => [p.key, themes.reduce((s, t) => s + counts[t.key][p.key], 0)]));
const version = scans[0].summary.checkov_version;

function figure(){
  const W = 1240, left = 60, barX = 330, maxBar = 330, noteX = 760, noteChars = 66, rowH = 42, barH = 20;
  const max = Math.max(...themes.map(t => totalOf(t.key)));
  const unit = maxBar / max;
  let b = '';
  b += text(left, 44, 'What the infrastructure scanner flagged, by theme', {size:16, weight:'bold'});
  b += text(left, 66, `Checkov ${version} over both tenant Terraform roots, both bootstrap templates, the platform's template-bucket Terraform and the six workflows: ${passed} checks passed and`, {size:11.5, fill:ink.muted});
  b += text(left, 84, `${failed} failed. ${byPlace.aws + byPlace.azure} of the failures are in what a deployment creates in the customer's cloud; each is placed in one theme by its check ID.`, {size:11.5, fill:ink.muted});

  places.forEach((p, i) => {
    const lx = left + i * 330;
    b += swatch(lx, 106, p.fill);
    b += text(lx + 18, 117, `${p.label} · ${byPlace[p.key]}`, {size:11.5, weight:'bold', fill:ink.secondary});
    b += text(lx + 18, 133, p.detail, {size:11, fill:ink.muted});
  });

  const top = 168;
  b += text(noteX, top - 8, 'WHAT THE CHECKS ASK FOR', {size:10.5, weight:'bold', fill:ink.muted});
  b += `<line x1="${left}" y1="${top}" x2="${W - 40}" y2="${top}" stroke="${ink.axis}" stroke-width="1"/>`;
  sorted.forEach((t, i) => {
    const y = top + 14 + i * rowH, cy = y + barH / 2;
    b += text(left, cy + 4.5, t.label, {size:12, fill:ink.primary});
    let x = barX;
    const segs = places.filter(p => counts[t.key][p.key] > 0);
    segs.forEach((p, k) => {
      const n = counts[t.key][p.key], w = n * unit, last = k === segs.length - 1;
      // 2 px surface gap between touching segments; the bar's far end is rounded,
      // its baseline end square.
      const drawn = Math.max(1.5, w - (last ? 0 : 2));
      if(last){
        const r = Math.min(4, drawn / 2);
        b += `<path d="M${x},${y} h${drawn - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${drawn - r} z" fill="${p.fill}"><title>${esc(`${t.label}, ${p.label}: ${n}`)}</title></path>`;
      } else {
        b += `<rect x="${x}" y="${y}" width="${drawn}" height="${barH}" fill="${p.fill}"><title>${esc(`${t.label}, ${p.label}: ${n}`)}</title></rect>`;
      }
      if(String(n).length * 11 * 0.6 + 10 <= drawn) b += text(x + drawn / 2, cy + 4, n, {size:11, fill:p.text, anchor:'middle', weight:'bold'});
      x += w;
    });
    b += text(x + 8, cy + 4.5, totalOf(t.key), {size:12, weight:'bold'});
    wrap(t.note, noteChars).forEach((l, k) => { b += text(noteX, y + 9 + k * 14, l, {size:10.5, fill:ink.secondary}); });
    if(i < sorted.length - 1) b += `<line x1="${left}" y1="${y + rowH - 8}" x2="${W - 40}" y2="${y + rowH - 8}" stroke="${ink.rule}" stroke-width="1"/>`;
  });

  const fTop = top + 14 + sorted.length * rowH + 22;
  const perFramework = scans.map(s => `${s.check_type} ${s.summary.failed}/${s.summary.passed + s.summary.failed}`).join(', ');
  const notes = [
    `Source: docs/evaluation/security/checkov.json; failed of all checks per framework: ${perFramework}.`,
    'Checkov\'s open-source rules carry no severity, so a count says how many checks a theme gathers, not how much risk it holds. The theme of every check ID is',
    'written out in scripts/plot-checkov-themes.cjs. Many checks ask for production hardening (redundancy, customer-managed keys, extended logging) that would add',
    'cost to every tenant. Each failed check still needs a disposition: fixed, accepted with a reason, or a documented limitation.',
  ];
  notes.forEach((n, i) => { b += text(left, fTop + i * 18, n, {size:11, fill:ink.muted}); });
  const H = fTop + notes.length * 18 + 14;
  const aria = `Failed Checkov checks by theme: ` + sorted.map(t => `${t.label} ${totalOf(t.key)}`).join(', ') + `. ${failed} failed and ${passed} passed in total.`;
  return svg(W, H, aria, b);
}

(async () => {
  const content = figure();
  fs.writeFileSync(`${out}/fig-30-checkov-themes.svg`, content);
  await sharp(Buffer.from(content), {density:216}).png().toFile(`${out}/fig-30-checkov-themes.png`);
  console.log(`Wrote ${out}/fig-30-checkov-themes.svg and .png`);
})().catch(e => { console.error(e); process.exit(1); });
