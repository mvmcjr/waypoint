export const byName = (app: WebdriverIO.Browser, name: string) => app.$(`aria/${name}`);

/** Right-clicks an element (context menu trigger). */
export async function rightClick(el: ChainablePromiseElement | WebdriverIO.Element): Promise<void> {
  const resolved: WebdriverIO.Element = 'getElement' in el ? await el.getElement() : el;
  await resolved.click({ button: 'right' });
}

/**
 * Builds a safe XPath string literal for `s`, handling values that contain
 * both `'` and `"` via `concat()` (XPath 1.0 has no escape character).
 */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  const parts = s.split("'").map((p) => `'${p}'`);
  return `concat(${parts.join(", \"'\", ")})`;
}

/**
 * Finds a `[role=menuitem]` whose text matches `name` (string = substring, or
 * RegExp). Waits up to `timeoutMs` for the menu to mount — a right-click's
 * context menu is not necessarily present yet when this is called.
 */
export async function menuItem(
  app: WebdriverIO.Browser,
  name: string | RegExp,
  timeoutMs = 10_000
): Promise<WebdriverIO.Element> {
  let found: WebdriverIO.Element | undefined;
  let seenTexts: string[] = [];
  try {
    await app.waitUntil(
      async () => {
        const items = await app.$$('[role=menuitem]');
        const texts: string[] = [];
        found = undefined;
        for (const item of items) {
          const text = await item.getText();
          texts.push(text);
          const matches = typeof name === 'string' ? text.includes(name) : name.test(text);
          if (matches && !found) found = item;
        }
        seenTexts = texts;
        return found !== undefined;
      },
      { timeout: timeoutMs }
    );
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No [role=menuitem] matching ${name} found within ${timeoutMs}ms (menu items seen: ${JSON.stringify(seenTexts)}) — ${cause}`
    );
  }
  return found!;
}

/**
 * Finds a `[role=dialog]` containing `title` in its text. Waits up to
 * `timeoutMs` for the dialog to mount.
 */
export async function dialog(
  app: WebdriverIO.Browser,
  title: string,
  timeoutMs = 10_000
): Promise<WebdriverIO.Element> {
  let found: WebdriverIO.Element | undefined;
  let seenTexts: string[] = [];
  try {
    await app.waitUntil(
      async () => {
        const dialogs = await app.$$('[role=dialog]');
        const texts: string[] = [];
        found = undefined;
        for (const d of dialogs) {
          const text = await d.getText();
          texts.push(text);
          if (text.includes(title) && !found) found = d;
        }
        seenTexts = texts;
        return found !== undefined;
      },
      { timeout: timeoutMs }
    );
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No [role=dialog] containing "${title}" found within ${timeoutMs}ms (dialogs seen: ${JSON.stringify(seenTexts)}) — ${cause}`
    );
  }
  return found!;
}

/**
 * Finds a `<button>` or `role="button"` element by its accessible name
 * (exact, normalized text or `aria-label`), scoped to `scope` (browser or
 * element). Unlike `aria/<name>`, this can't accidentally match a
 * same-named non-button element in document order (e.g. a `<DialogTitle>`
 * reading "Merge" when looking for the "Merge" button). Waits up to
 * `timeoutMs` for it to exist.
 */
export async function button(
  scope: WebdriverIO.Browser | WebdriverIO.Element,
  name: string,
  timeoutMs = 10_000
): Promise<WebdriverIO.Element> {
  const lit = xpathLiteral(name);
  const xpath = `.//*[(self::button or @role="button") and (normalize-space(.)=${lit} or @aria-label=${lit})]`;
  const el = scope.$(xpath);
  await el.waitForExist({ timeout: timeoutMs });
  return el.getElement();
}

/** Waits until `text` appears anywhere in the page body. */
export async function waitForText(app: WebdriverIO.Browser, text: string, timeoutMs = 10_000): Promise<void> {
  await app.waitUntil(
    async () => {
      const body = await app.$('body');
      const bodyText = await body.getText();
      return bodyText.includes(text);
    },
    { timeout: timeoutMs, timeoutMsg: `Text "${text}" did not appear within ${timeoutMs}ms` }
  );
}
