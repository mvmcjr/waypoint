import { expect } from 'expect-webdriverio';
import { makeFixture, disposeFixture, type Fixture } from '../support/fixtures.js';
import { launch, quit } from '../support/app.js';
import { saveFailureArtifacts } from '../support/artifacts.js';
import { log1 } from '../support/git.js';
import { waitForText } from '../support/ui.js';

describe('smoke', function () {
  let fx: Fixture | undefined;
  let app: WebdriverIO.Browser | undefined;

  afterEach(async function () {
    const passed = this.currentTest?.state === 'passed';
    if (!passed) await saveFailureArtifacts(app, 'smoke', this.currentTest!.title);
    await quit(app);
    app = undefined;
    disposeFixture(fx, passed);
    fx = undefined;
  });

  it('launches the real app on a fixture and shows its history', async () => {
    fx = makeFixture('clean', 'launch');
    app = await launch(fx.openPath);
    const session = app;
    // `[role=tab]*=clean` (attribute selector + WDIO's text-contains shorthand)
    // is rejected by msedgedriver as an "invalid selector" — that shorthand only
    // combines with a plain tag name. Use an XPath contains() check instead;
    // same intent (a tab labelled "clean" is displayed).
    await expect(session.$('//*[@role="tab" and contains(., "clean")]')).toBeDisplayed();
    await waitForText(session, 'Add version config');
    expect(log1(fx.openPath)).toBe('Add version config');
  });
});
