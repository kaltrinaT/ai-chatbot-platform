/* eslint-disable @typescript-eslint/no-require-imports -- Shared by CommonJS evaluation scripts. */
// Mutants generated mechanically from the security-critical source files.
//
// The hand-written mutants in evaluate-security-mutants.cjs are chosen one
// per claim, which leaves a fair question open: were they chosen because the
// author knew the tests would catch them? These are not chosen. Every place in
// the listed files that matches one of four operators becomes a mutant, and
// the score is whatever it turns out to be. Each operator only ever weakens a
// check, so a mutant that survives is either equivalent (the weakened check
// was unreachable or redundant), held by another layer, or a gap in the tests.
//
//   guard          an `if` that returns, throws or redirects gets the condition `false`
//   guard-term     one alternative of such a guard's `||` condition is dropped
//   conjunct       one argument of a drizzle `and(...)` in a query is dropped
//   validator      one zod refinement (.regex, .refine, .min, .max, .url …) is dropped
//
// Mutants are described by an anchor (the original text and its occurrence
// number) so the runner applies them exactly as it applies hand-written ones,
// and by a fingerprint that survives unrelated edits elsewhere in the file, so
// a reviewed survivor stays reviewed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const ts = require('typescript');

const SOURCES = [
  'src/lib/crypto.ts',
  'src/lib/deploymentSecrets.ts',
  'src/lib/githubOidc.ts',
  'src/lib/docsSigner.ts',
  'src/lib/awsTrust.ts',
  'src/lib/azureFederation.ts',
  'src/lib/tenantInput.ts',
  'src/lib/tenantErasure.ts',
  'src/lib/operators.ts',
  'src/lib/reconcile.ts',
  'src/lib/deploy.ts',
  'src/app/api/deployments/[id]/status/route.ts',
  'src/app/api/deployments/[id]/secrets/route.ts',
  'src/app/api/deployments/[id]/progress/route.ts',
  'src/app/tenants/[id]/actions.ts',
  'src/app/tenants/[id]/documents/actions.ts',
  'src/app/tenants/connectionActions.ts',
  'src/app/tenants/new/actions.ts',
  'src/auth.ts',
];

const EXIT_CALLS = new Set(['redirect', 'notFound', 'forbidden', 'unauthorized']);
const VALIDATORS = new Set(['regex', 'refine', 'superRefine', 'min', 'max', 'length', 'url', 'uuid', 'email', 'startsWith', 'endsWith', 'nonempty']);

/** Whether a statement leaves the function: return, throw, or a Next.js redirect. */
function exits(statement){
  if(!statement) return false;
  if(ts.isBlock(statement)) return statement.statements.some(exits);
  if(ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && EXIT_CALLS.has(statement.expression.expression.getText());
}

/** The operands of an `a || b || c` chain, flattened. */
function alternatives(node){
  const expr = ts.isParenthesizedExpression(node) ? node.expression : node;
  if(ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...alternatives(expr.left), ...alternatives(expr.right)];
  return [node];
}

/** Whether a call chain starts at the zod namespace, `z.string()…`. */
function fromZod(node){
  let n = node;
  while(ts.isCallExpression(n) || ts.isPropertyAccessExpression(n)) n = n.expression;
  return ts.isIdentifier(n) && n.text === 'z';
}

/** The occurrence number of the text at `start`, counted the way the runner counts. */
function occurrence(text, find, start){
  let nth = 0;
  for(let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + 1)){ nth++; if(i === start) return nth; }
  return 0;
}

const oneLine = s => s.replace(/\s+/g, ' ').trim();

function mutantsFor(file){
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [], seen = new Map();
  const add = (operator, node, replace, what) => {
    const find = node.getText(source), start = node.getStart(source);
    const nth = occurrence(text, find, start);
    if(!nth) return;
    const line = source.getLineAndCharacterOfPosition(start).line + 1;
    // Enclosing function or variable, for the report and the fingerprint.
    let scope = node.parent, name = '';
    while(scope && !name){
      if((ts.isFunctionDeclaration(scope) || ts.isMethodDeclaration(scope)) && scope.name) name = scope.name.getText(source);
      else if(ts.isVariableDeclaration(scope)) name = scope.name.getText(source);
      else if(ts.isPropertyAssignment(scope)) name = scope.name.getText(source);
      scope = scope.parent;
    }
    // The same guard can appear twice in one function; the count tells them apart.
    const key = [file, operator, name, oneLine(find), oneLine(replace)].join('\u0000');
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const fingerprint = crypto.createHash('sha256').update(`${key}\u0000${seen.get(key)}`).digest('hex').slice(0, 12);
    out.push({file, line, operator, scope:name || '(module)', what, before:oneLine(find), after:oneLine(replace), fingerprint, changes:[{file, find, replace, nth}]});
  };

  (function visit(node){
    if(ts.isIfStatement(node) && exits(node.thenStatement)){
      add('guard', node.expression, 'false', `guard removed: if (${oneLine(node.expression.getText(source))})`);
      const terms = alternatives(node.expression);
      if(terms.length > 1) terms.forEach((term, i) => {
        const kept = terms.filter((_, j) => j !== i).map(t => t.getText(source)).join(' || ');
        add('guard-term', node.expression, kept, `alternative dropped: ${oneLine(term.getText(source))}`);
      });
    }
    if(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'and' && node.arguments.length >= 2){
      node.arguments.forEach((arg, i) => {
        const kept = node.arguments.filter((_, j) => j !== i).map(a => a.getText(source)).join(', ');
        add('conjunct', node, `and(${kept})`, `query condition dropped: ${oneLine(arg.getText(source))}`);
      });
    }
    if(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && VALIDATORS.has(node.expression.name.text) && fromZod(node.expression.expression)){
      add('validator', node, node.expression.expression.getText(source), `validation dropped: .${node.expression.name.text}(${oneLine(node.arguments.map(a => a.getText(source)).join(', ')).slice(0, 60)})`);
    }
    ts.forEachChild(node, visit);
  })(source);
  return out;
}

/** Every generated mutant, numbered G001… in file order. */
function generatedMutants(files = SOURCES){
  return files.flatMap(mutantsFor).map((m, i) => ({id:`G${String(i + 1).padStart(3, '0')}`, ...m}));
}

module.exports = {SOURCES, generatedMutants};
