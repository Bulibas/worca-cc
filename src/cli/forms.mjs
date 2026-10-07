// src/cli/forms.mjs
//
// The CLI's kind:'form' asker (spec §8): prints P1's text projection, then prompts
// field by field in layout order through an injected `question`. worca-cc.mjs
// builds one asker from its globals (`out`, `c`, and the readline `question` that
// night mode can abort); test/cli-forms-unit.test.mjs drives it with a scripted one.

import { formatFormField, formatCoerceError, formatFormErrors, FORM_REPROMPT_MAX } from './render.mjs';
import { promptFields, unfoldForm, coerceInput } from '../shared/forms/project.mjs';
import { whenOk } from '../shared/forms/layout.mjs';
import { validate } from '../shared/forms/schema.mjs';
import { collectAnswer } from '../shared/forms/answer.mjs';

/** The answer field a P1 error path names: `notes`, `steps[1].verdict` -> `steps`. */
function fieldOfPath(path) {
  return String(path || '').split(/[.[]/)[0] || '';
}

/** The answer schema for ONE field, or null (a stale layout, or a display widget). */
function fieldSchemaOf(ask, name) {
  const props = ask && ask.answerSchema && ask.answerSchema.properties;
  return props && Object.hasOwn(props, name) ? props[name] : null;
}

/**
 * @param {{ out: (line: string) => void, c: (color: string, text: string) => string,
 *   question: (rl: object, prompt: string) => Promise<string> }} io
 * @returns {{ askForm: (rl: object, ask: object) => Promise<{ values: object }> }}
 */
export function createFormAsker({ out, c, question }) {
  /**
   * Read ONE entry for `f` until it coerces and validates. Returns the value, or
   * `undefined` for an optional field the user left empty. Coercion is P1's
   * coerceInput (ruling X7) — the CLI only prints and decides requiredness.
   */
  async function readFormEntry(rl, f, prompt, indent = '') {
    for (;;) {
      const got = coerceInput(f, await question(rl, c('cyan', `${indent}${prompt}`)));
      if (!got.ok) { out(c('red', `${indent}${formatCoerceError(f, got)}`)); continue; }
      // coerceInput returns `undefined` for an empty entry meaning "use the default";
      // applying it is the caller's job, and so is requiredness.
      if (got.value === undefined) {
        if (f.default !== undefined) return f.default;
        if (f.required) { out(c('red', `${indent}  ${f.label || f.field} is required`)); continue; }
        return undefined;
      }
      return got.value;
    }
  }

  /** Prompt ONE field and write it into `values`. */
  async function askFormField(rl, ask, f, values) {
    const { lines, prompt } = formatFormField(f);
    for (const line of lines) out(line);
    for (;;) {
      const value = await readFormEntry(rl, f, prompt);
      if (value === undefined) { delete values[f.field]; return; }
      const schema = fieldSchemaOf(ask, f.field);
      if (schema) {
        const v = validate(schema, value);
        if (!v.ok) {
          for (const line of formatFormErrors(v.errors.map((e) => ({ ...e, path: e.path || f.field })))) out(c('red', line));
          continue;
        }
      }
      values[f.field] = value;
      return;
    }
  }

  /** A review-list: one row per bound item, each row prompting the field's itemFields. */
  async function askReviewList(rl, f, values) {
    const { lines } = formatFormField(f);
    for (const line of lines) out(line);
    const rows = [];
    for (const item of (Array.isArray(f.items) ? f.items : [])) {
      out(`  ${item.label || item.id}`);
      const row = { id: item.id };
      for (const sub of (Array.isArray(f.itemFields) ? f.itemFields : [])) {
        const { lines: subLines, prompt } = formatFormField(sub);
        for (const line of subLines) out(`  ${line}`);
        const value = await readFormEntry(rl, sub, prompt, '  ');
        if (value !== undefined) row[sub.field] = value;
      }
      rows.push(row);
    }
    values[f.field] = rows;
  }

  /**
   * Ask ONE kind:'form' question interactively (spec §8). Prints P1's text projection
   * — display widgets as text, files as `rel (mime, size)` — then prompts field by
   * field in LAYOUT order, honouring `when` as answers accumulate: a gated item's
   * projection prints only once the answers so far open it (a field that
   * becomes hidden loses its value and is not required). Each entry goes through P1's
   * coerceInput + validate; the whole set through collectAnswer, which drops hidden
   * fields, strips unknown keys and treats "" as missing. Returns { values }.
   * Re-offers from the first offending field, at most FORM_REPROMPT_MAX times.
   */
  async function askForm(rl, ask) {
    out('');
    const reveal = unfoldForm(ask);
    const projected = reveal({});
    out(c('bold', `? ${projected[0]}`));
    for (const line of projected.slice(1)) out(line);
    const fields = promptFields(ask);
    const values = {};
    let from = 0;
    for (let pass = 1; ; pass++) {
      for (let i = from; i < fields.length; i++) {
        const f = fields[i];
        if (!whenOk(f.when, values)) { delete values[f.field]; continue; }
        for (const line of reveal(values, f.field)) out(line);
        if (f.widget === 'review-list') await askReviewList(rl, f, values);
        else await askFormField(rl, ask, f, values);
      }
      for (const line of reveal(values)) out(line);   // a gated display item after the last prompt
      const collected = collectAnswer(ask, ask.answerSchema, values);
      if (!collected.errors.length) return { values: collected.values };
      for (const line of formatFormErrors(collected.errors)) out(c('red', line));
      if (pass >= FORM_REPROMPT_MAX) {
        throw new Error(`form "${ask.form}" is still invalid after ${FORM_REPROMPT_MAX} attempts`);
      }
      const bad = new Set(collected.errors.map((e) => fieldOfPath(e.path)));
      const first = fields.findIndex((f) => bad.has(f.field) && whenOk(f.when, values));
      from = first >= 0 ? first : 0;
      for (let i = from; i < fields.length; i++) delete values[fields[i].field];
    }
  }

  return { askForm };
}
